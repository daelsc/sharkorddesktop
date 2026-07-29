using System.Text.RegularExpressions;
using Jint;
using Sharkov.App.Injection;

namespace Sharkov.Tests.Injection;

/// <summary>Tests for the injection builders. The JS content is executed in Jint (a real
/// JS interpreter) against a mock RTCPeerConnection that enforces the real WebRTC
/// transactionId invalidation contract — the exact invariant the applyBitrateLimits
/// simulcast path must respect. Ports webrtcStatsInjection.test.ts.</summary>
public class InjectionBuilderTests
{
    // Mock RTCPeerConnection + sender that enforces the real WebRTC transactionId
    // invalidation contract: getParameters() returns a fresh transactionId each call
    // (invalidating the previous); setParameters(p) rejects if p.transactionId is stale.
    // All globals are set directly on the engine so the injection (which references bare
    // `window`, `RTCPeerConnection`, `setInterval`, `console`) sees them.
    private const string MockPcJs = @"
      var __nextTxId = 1;
      var __setCalls = [];
      var __rejections = [];
      function __mkSender(trackKind, encodings) {
        var currentTx = __nextTxId++;
        return {
          track: { kind: trackKind },
          _encodings: encodings,
          getParameters: function () {
            currentTx = __nextTxId++;
            return { encodings: encodings.map(function (e) { return Object.assign({}, e); }), transactionId: currentTx };
          },
          setParameters: function (p) {
            if (p.transactionId !== currentTx) {
              __rejections.push('stale tx ' + p.transactionId + ' (current ' + currentTx + ')');
              return Promise.reject(new Error('InvalidAccessError: transactionId mismatch'));
            }
            encodings.splice(0, encodings.length);
            p.encodings.forEach(function (e) { encodings.push(Object.assign({}, e)); });
            __setCalls.push(p);
            return Promise.resolve();
          },
          setCodecPreferences: function () {}
        };
      }
      function __mkPc(senders) {
        var listeners = {};
        return {
          connectionState: 'new',
          getSenders: function () { return senders; },
          getTransceivers: function () { return senders.map(function (s) { return { sender: s }; }); },
          addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
          setLocalDescription: function (d) { return Promise.resolve(d); },
          addTrack: function () { return {}; },
          createOffer: function () { return Promise.resolve({}); },
          getStats: function () { return Promise.resolve(new Map()); }
        };
      }
      var __handlers = [];
    ";

    // Returns a JS object string for the given C# encodings array.
    private static string EncJson(object[][] encodings) => System.Text.Json.JsonSerializer.Serialize(encodings);

    private sealed class DriveResult
    {
        public Engine Engine { get; set; } = new();
        public string HandleExpr { get; set; } = "";
    }

    // Sets up the mock globals + PC, runs the injection directly (no eval indirection),
    // then constructs a wrapped PC so the injection's pcs[] is populated. Mirrors the
    // freshWindow()/constructPc() helpers in webrtcStatsInjection.test.ts.
    private static DriveResult Drive(int forcedBps, string codec, object[][] encodings)
    {
        var e = new Engine(opts => opts.LimitRecursion(10_000));
        e.Execute(MockPcJs);
        // build the window + mock PC as globals, then run the injection in the SAME scope
        e.Execute($@"
          var __senders = [__mkSender('video', {EncJson(encodings)}[0])];
          var __pc = __mkPc(__senders);
          var __window = {{
            RTCPeerConnection: function () {{ return __pc; }},
            addEventListener: function (t, fn) {{ __handlers.push({{ type: t, fn: fn }}); }},
            parent: null,
            location: {{ reload: function () {{}} }}
          }};
          __window.parent = __window;
          __window.RTCPeerConnection.getCapabilities = function () {{ return {{ codecs: [{{ mimeType: 'video/H264' }}, {{ mimeType: 'video/rtx' }}] }}; }};
          __window.RTCPeerConnection.prototype = {{}};
          window = __window;
          setInterval = function () {{ return 0; }};
          clearInterval = function () {{}};
          console = {{ log: function () {{}}, error: function () {{}} }};
          RTCPeerConnection = __window.RTCPeerConnection;
          // helper to fire a message at the injection's registered message listener
          function __fire(data) {{
            __handlers.filter(function (x) {{ return x.type === 'message'; }})
                      .forEach(function (x) {{ x.fn({{ data: data }}); }});
          }}
        ");
        // run the injection directly — it's an IIFE that reads `window` at call time
        e.Execute(InjectionBuilders.BuildWebrtcStatsInjection(forcedBps, codec));
        // populate the injection's pcs[] with __pc
        e.Execute("new window.RTCPeerConnection();");
        return new DriveResult { Engine = e, HandleExpr = "__drv" };
    }

    // ---- string integrity ----

    [Fact]
    public void Webrtc_BuildsValidJs()
    {
        var code = InjectionBuilders.BuildWebrtcStatsInjection(0, "H264");
        // If Jint can parse + execute it against a minimal window, it's syntactically valid.
        // (The injection's first line reads window.__sharkordRtcStatsHooked, so a window is required.)
        var e = new Engine();
        e.Execute("var window = { addEventListener: function(){}, parent: {}, location: { reload: function(){} } }; var setInterval = function(){return 0;}; var console = { log: function(){} };");
        e.Execute(code);
    }

    [Fact]
    public void Webrtc_NoSlashSlashLineComments()
    {
        var code = InjectionBuilders.BuildWebrtcStatsInjection(0, "H264");
        // The whole string is one line (joined with ''); any // would swallow the rest.
        Assert.DoesNotContain("//", code);
    }

    [Fact]
    public void Webrtc_HasHookGuard_AndIsSafeWhenRtcAbsent()
    {
        var code = InjectionBuilders.BuildWebrtcStatsInjection(0, "H264");
        var e = new Engine();
        e.Execute("var window = { addEventListener: function(){}, parent: {}, location: { reload: function(){} } }; var setInterval = function(){return 0;}; var console = { log: function(){} };");
        e.Execute(code);
        Assert.True(e.Evaluate("window.__sharkordRtcStatsHooked").AsBoolean());
    }

    // ---- simulcast bitrate cap (live setParameters) ----

    private static object[][] SimEncodings() => new[]
    {
        new object[]
        {
            new { rid = "r0", scaleResolutionDownBy = 4, maxBitrate = 300000, scalabilityMode = "L1T3", active = true },
            new { rid = "r1", scaleResolutionDownBy = 2, maxBitrate = 800000, scalabilityMode = "L1T3", active = true },
            new { rid = "r2", scaleResolutionDownBy = 1, maxBitrate = 4000000, scalabilityMode = "L1T3", active = true }
        }
    };

    [Fact]
    public void Simulcast_CapsHighLayerToForcedBitrate()
    {
        var d = Drive(0, "H264", SimEncodings());
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 10000000 });");
        var high = d.Engine.Evaluate("JSON.stringify(__senders[0].getParameters().encodings.find(function(e){return e.scaleResolutionDownBy===1;}))").AsString();
        var doc = System.Text.Json.JsonDocument.Parse(high);
        Assert.Equal("r2", doc.RootElement.GetProperty("rid").GetString());
        Assert.Equal(10000000, doc.RootElement.GetProperty("maxBitrate").GetInt32());
        Assert.Equal(0, d.Engine.Evaluate("__rejections.length").AsNumber());
    }

    [Fact]
    public void Simulcast_Auto_RemovesHighLayerCap()
    {
        var d = Drive(0, "H264", SimEncodings());
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 10000000 });");
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 0 });");
        var high = d.Engine.Evaluate("JSON.stringify(__senders[0].getParameters().encodings.find(function(e){return e.scaleResolutionDownBy===1;}))").AsString();
        var doc = System.Text.Json.JsonDocument.Parse(high);
        Assert.False(doc.RootElement.TryGetProperty("maxBitrate", out _));
        Assert.Equal(0, d.Engine.Evaluate("__rejections.length").AsNumber());
    }

    [Fact]
    public void Simulcast_DoesNotTouchLowMidLayers()
    {
        var d = Drive(0, "H264", SimEncodings());
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 6000000 });");
        var r0 = d.Engine.Evaluate("__senders[0].getParameters().encodings.find(function(e){return e.rid==='r0';}).maxBitrate").AsNumber();
        var r1 = d.Engine.Evaluate("__senders[0].getParameters().encodings.find(function(e){return e.rid==='r1';}).maxBitrate").AsNumber();
        var r2 = d.Engine.Evaluate("__senders[0].getParameters().encodings.find(function(e){return e.rid==='r2';}).maxBitrate").AsNumber();
        Assert.Equal(300000, r0);
        Assert.Equal(800000, r1);
        Assert.Equal(6000000, r2);
    }

    [Fact]
    public void Simulcast_NeverRejectsStaleTransactionId()
    {
        var d = Drive(0, "H264", SimEncodings());
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 8000000 });");
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 4000000 });");
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 0 });");
        Assert.Equal(0, d.Engine.Evaluate("__rejections.length").AsNumber());
        Assert.Equal(3, d.Engine.Evaluate("__setCalls.length").AsNumber());
    }

    // ---- single-stream bitrate force ----

    [Fact]
    public void SingleStream_ForcesMinMaxAndMaintainResolution()
    {
        var d = Drive(0, "H264", new[] { new object[] { new { maxBitrate = 100000 } } });
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 5000000 });");
        Assert.Equal(1, d.Engine.Evaluate("__setCalls.length").AsNumber());
        var sent = d.Engine.Evaluate("JSON.stringify(__setCalls[0])").AsString();
        var doc = System.Text.Json.JsonDocument.Parse(sent);
        var enc = doc.RootElement.GetProperty("encodings")[0]!;
        Assert.Equal(5000000, enc.GetProperty("maxBitrate").GetInt32());
        Assert.Equal(5000000, enc.GetProperty("minBitrate").GetInt32());
        Assert.Equal("maintain-resolution", doc.RootElement.GetProperty("degradationPreference").GetString());
        Assert.Equal(0, d.Engine.Evaluate("__rejections.length").AsNumber());
    }

    [Fact]
    public void SingleStream_Auto_LeavesStreamUntouched()
    {
        var d = Drive(0, "H264", new[] { new object[] { new { maxBitrate = 100000 } } });
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 0 });");
        Assert.Equal(0, d.Engine.Evaluate("__setCalls.length").AsNumber());
    }

    [Fact]
    public void SVC_CapsMaxBitrateOnly_NeverSetsMinBitrate()
    {
        var d = Drive(0, "H264", new[] { new object[] { new { scalabilityMode = "L3T3", maxBitrate = 4000000 } } });
        d.Engine.Execute("__fire({ type: 'sharkord-set-video-bitrate', bps: 6000000 });");
        Assert.Equal(1, d.Engine.Evaluate("__setCalls.length").AsNumber());
        var sent = d.Engine.Evaluate("JSON.stringify(__setCalls[0])").AsString();
        var doc = System.Text.Json.JsonDocument.Parse(sent);
        var enc = doc.RootElement.GetProperty("encodings")[0]!;
        Assert.Equal(6000000, enc.GetProperty("maxBitrate").GetInt32());
        Assert.False(enc.TryGetProperty("minBitrate", out _));
        Assert.False(doc.RootElement.TryGetProperty("degradationPreference", out _));
        Assert.Equal(0, d.Engine.Evaluate("__rejections.length").AsNumber());
    }

    // ---- SDP bandwidth forcing (pure C#) ----

    private const string SingleSdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
    private const string SimulcastSdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=simulcast:prepare rid=low;high\r\n";
    private const string AudioSdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    private const string MixedSdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";

    [Fact]
    public void Sdp_InjectsBAsAfterVideoLine()
    {
        var out_ = InjectionBuilders.ForceSdpBandwidth(SingleSdp, 6000000);
        Assert.Contains("b=AS:6000", out_);
        Assert.True(out_.IndexOf("b=AS:6000") > out_.IndexOf("m=video"));
    }

    [Fact]
    public void Sdp_SkipsSimulcastSections()
    {
        Assert.Equal(SimulcastSdp, InjectionBuilders.ForceSdpBandwidth(SimulcastSdp, 6000000));
    }

    [Fact]
    public void Sdp_ReplacesExistingBAsLine()
    {
        var withBw = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nb=AS:1000\r\n";
        var out_ = InjectionBuilders.ForceSdpBandwidth(withBw, 6000000);
        Assert.Equal(1, Regex.Matches(out_, "b=AS:").Count);
        Assert.Contains("b=AS:6000", out_);
        Assert.DoesNotContain("b=AS:1000", out_);
    }

    [Fact]
    public void Sdp_LeavesAudioUntouched()
    {
        Assert.Equal(AudioSdp, InjectionBuilders.ForceSdpBandwidth(AudioSdp, 6000000));
    }

    [Fact]
    public void Sdp_LeavesAudioInMixedAndCapsVideo()
    {
        var out_ = InjectionBuilders.ForceSdpBandwidth(MixedSdp, 4000000);
        Assert.Contains("b=AS:4000", out_);
        Assert.StartsWith("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", out_);
    }

    [Fact]
    public void Sdp_Auto_IsNoOp()
    {
        Assert.Equal(SingleSdp, InjectionBuilders.ForceSdpBandwidth(SingleSdp, 0));
    }

    [Fact]
    public void Sdp_FalsyInput_ReturnsInput()
    {
        Assert.Equal("", InjectionBuilders.ForceSdpBandwidth("", 6000000));
        Assert.Equal(null!, InjectionBuilders.ForceSdpBandwidth(null!, 6000000));
    }

    [Fact]
    public void Sdp_BuiltStringContainsBAsLogic()
    {
        var code = InjectionBuilders.BuildWebrtcStatsInjection(6000000, "H264");
        Assert.Contains("b=AS:\"+bwKbps+\"", code);
        Assert.Contains("if(/a=simulcast/i.test(sections[i]))continue;", code);
    }

    // ---- simulcast codec injection (H264 default on load) ----

    private sealed class LocalStorageMock
    {
        private readonly Dictionary<string, string> _store = new();
        public string? GetItem(string k) => _store.TryGetValue(k, out var v) ? v : null;
        public void SetItem(string k, string v) => _store[k] = v;
        public void RemoveItem(string k) => _store.Remove(k);
        public IReadOnlyDictionary<string, string> Store => _store;
    }

    private sealed class WindowMock
    {
        public List<(string type, Action<object> fn)> Handlers { get; } = new();
        public bool Reloaded { get; set; }
        public void AddEventListener(string t, Action<object> fn) => Handlers.Add((t, fn));
    }

    private sealed class ConsoleMock
    {
        public void Log(string _) { }
    }

    private static (LocalStorageMock ls, bool reloaded) RunSimulcastCodec(string? stored)
    {
        var ls = new LocalStorageMock();
        if (stored is not null) ls.SetItem("sharkord-devices-settings", stored);
        var w = new WindowMock();
        var e = new Engine();
        e.SetValue("window", w);
        e.SetValue("localStorage", ls);
        e.SetValue("console", new ConsoleMock());
        // window.location.reload must set the reloaded flag
        e.Execute("Object.defineProperty(window, 'location', { value: { reload: function(){ window.__reloaded = true; } } });");
        e.Execute(InjectionBuilders.BuildSimulcastCodecInjection());
        return (ls, w.Reloaded || e.Evaluate("window.__reloaded === true").AsBoolean());
    }

    [Fact]
    public void SimulcastCodec_WritesH264AndReloadsWhenNotH264()
    {
        var (ls, reloaded) = RunSimulcastCodec(System.Text.Json.JsonSerializer.Serialize(new { screenCodec = "auto" }));
        Assert.Contains("video/H264", ls.Store["sharkord-devices-settings"]);
        Assert.True(reloaded);
    }

    [Fact]
    public void SimulcastCodec_NoOpWhenAlreadyH264()
    {
        var (_, reloaded) = RunSimulcastCodec(System.Text.Json.JsonSerializer.Serialize(new { screenCodec = "video/H264" }));
        Assert.False(reloaded);
    }

    [Fact]
    public void SimulcastCodec_CreatesKeyWhenMissing()
    {
        var (ls, reloaded) = RunSimulcastCodec(null);
        Assert.Contains("video/H264", ls.Store["sharkord-devices-settings"]);
        Assert.True(reloaded);
    }

    // ---- WebSocket capture + close-on-quit (the zombie-session fix) ----

    /// <summary>Drives BuildWebSocketCaptureInjection against a mock WebSocket in Jint.
    /// The hook wraps window.WebSocket so every new socket is recorded in
    /// window.__sharkordWebSockets, letting the host close them on app quit.</summary>
    private static Engine DriveWsEngine()
    {
        var e = new Engine(opts => opts.LimitRecursion(10_000));
        e.Execute(@"
          function __mkWs(url, protocols){
            this.url = url; this.readyState = 1; this.closeCalls = 0; this._listeners = {};
            this.close = function(){ this.closeCalls++; this.readyState = 3; this.__fire(); };
            this.addEventListener = function(t, fn){ (this._listeners[t]=this._listeners[t]||[]).push(fn); };
            this.__fire = function(){ var me=this; (me._listeners['close']||[]).forEach(function(f){ f({}); }); };
          }
          var window = { WebSocket: __mkWs };
        ");
        e.Execute(InjectionBuilders.BuildWebSocketCaptureInjection());
        return e;
    }

    [Fact]
    public void WebSocketCapture_TracksNewSockets()
    {
        var e = DriveWsEngine();
        e.Execute("new window.WebSocket('wss://host'); new window.WebSocket('wss://host2', ['chat']);");
        Assert.Equal(2, e.Evaluate("window.__sharkordWebSockets.length").AsNumber());
    }

    [Fact]
    public void WebSocketCapture_RemovesOnClose()
    {
        var e = DriveWsEngine();
        e.Execute("var ws = new window.WebSocket('wss://host'); ws.close();");
        // the close listener the hook registered must drop the socket from the list
        Assert.Equal(0, e.Evaluate("window.__sharkordWebSockets.length").AsNumber());
    }

    [Fact]
    public void WebSocketCapture_HasHookGuard()
    {
        var e = DriveWsEngine();
        e.Execute("var __firstWS = window.WebSocket;");
        e.Execute(InjectionBuilders.BuildWebSocketCaptureInjection()); // second run — guard must skip
        Assert.True(e.Evaluate("window.WebSocket === __firstWS").AsBoolean());
    }

    [Fact]
    public void WebSocketCapture_NoSlashSlashLineComments()
    {
        Assert.DoesNotContain("//", InjectionBuilders.BuildWebSocketCaptureInjection());
        Assert.DoesNotContain("//", InjectionBuilders.BuildCloseWebSocketsJs());
    }

    [Fact]
    public void CloseWebSockets_ClosesOnlyOpenSockets()
    {
        var e = DriveWsEngine();
        e.Execute("var a = new window.WebSocket('wss://a'); var b = new window.WebSocket('wss://b'); b.readyState = 3;");
        var closed = e.Evaluate(InjectionBuilders.BuildCloseWebSocketsJs()).AsNumber();
        Assert.Equal(1, closed);                              // only the OPEN socket
        Assert.Equal(1, e.Evaluate("a.closeCalls").AsNumber()); // 'a' was closed
        Assert.Equal(0, e.Evaluate("b.closeCalls").AsNumber()); // 'b' (readyState 3) was skipped
    }
}
