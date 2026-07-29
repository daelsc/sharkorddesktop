// Probe: does WebView2's WebRTC actually encode AV1 in hardware (NVENC)?
//
// Method: build a loopback RTCPeerConnection (two ends in the same page), force AV1 via
// setCodecPreferences, feed it frames from a canvas.captureStream(30), wait, and sample
// getStats() on the outbound-rtp entry. Hardware encode at 720p is ~1-2 ms/frame; software
// AV1 is ~10-30x slower. We report totalEncodeTime/framesEncoded so we can tell hardware
// from software without trusting encoderImplementation strings (which are often absent).
//
// Also reports encoderImplementation, scalabilityMode, width/height/fps so we can cross-
// check against the Electron proof (evidence/live-selftest-av1.json).

using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace Sharkov.Probes.Codecs;

public partial class EncodeProbeWindow : Window
{
    private readonly string _outPath;
    private readonly string _label;
    private readonly bool _withFlags;

    public EncodeProbeWindow(string outPath, string label, bool withFlags)
    {
        _outPath = outPath;
        _label = label;
        _withFlags = withFlags;
        Width = 200; Height = 120; Visibility = Visibility.Hidden;
        Loaded += async (_, _) => await RunAsync();
    }

    private async Task RunAsync()
    {
        var flags = _withFlags
            ? "--enable-features=PlatformHEVCEncoderSupport,MediaFoundationVideoCapture,MediaFoundationAV1Encoding,WebRtcAV1HWEncode,WebRtcH264WithOpenH264FFmpeg,VaapiVideoEncoder,VaapiVideoDecoder --ignore-gpu-blocklist --enable-gpu-rasterization --force-fieldtrials=WebRTC-H264-SpsPpsIdrIsH264Keyframe/Enabled/WebRTC-Video-Pacing/Enabled/"
            : "";
        var env = await CoreWebView2Environment.CreateAsync(options: new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments = flags
        });
        var wv = new Microsoft.Web.WebView2.Wpf.WebView2 { DefaultBackgroundColor = System.Drawing.Color.Black };
        Content = wv;
        await wv.EnsureCoreWebView2Async(env);

        wv.WebMessageReceived += (s, e) =>
        {
            var payload = e.TryGetWebMessageAsString();
            var result = new { label = _label, withFlags = _withFlags, payload = payload };
            File.WriteAllText(_outPath, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
            System.Windows.Application.Current.Shutdown();
        };

        // Loopback AV1 encode over a canvas-generated stream. The important parts:
        // - setCodecPreferences(AV1 only) forces the codec before the offer
        // - frames come from canvas.captureStream(30) so no display capture is needed
        // - after 8s, sample getStats for outbound-rtp and report the deltas
        var html = """
<!DOCTYPE html><html><body><script>
(async function () {
  var out = { ok: false, note: "", stats: [] };
  try {
    if (!RTCRtpSender || !RTCRtpSender.getCapabilities) { out.note = "no getCapabilities"; return window.chrome.webview.postMessage(JSON.stringify(out)); }
    var caps = RTCRtpSender.getCapabilities('video');
    var av1 = caps.codecs.filter(function (c) { return c.mimeType === 'video/AV1'; });
    if (!av1.length) { out.note = "AV1 not advertised"; return window.chrome.webview.postMessage(JSON.stringify(out)); }

    // Generate frames from a canvas (no display capture needed)
    var canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    var ctx = canvas.getContext('2d');
    var stream = canvas.captureStream(30);
    var track = stream.getVideoTracks()[0];
    if (!track) { out.note = "no video track from canvas.captureStream"; return window.chrome.webview.postMessage(JSON.stringify(out)); }

    // Draw a moving gradient so the encoder has real work to do
    var t = 0;
    var drawId = setInterval(function () {
      t++;
      var g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      g.addColorStop(0, 'hsl(' + ((t * 3) % 360) + ', 70%, 60%)');
      g.addColorStop(1, 'hsl(' + ((t * 7 + 180) % 360) + ', 60%, 30%)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = '48px sans-serif';
      ctx.fillText('AV1 probe frame ' + t, 40, 100 + (t % 100) * 4);
    }, 33);

    // Build a loopback RTCPeerConnection pair
    var pcOffer = new RTCPeerConnection();
    var pcAnswer = new RTCPeerConnection();
    pcOffer.onicecandidate = function (e) { if (e.candidate) pcAnswer.addIceCandidate(e.candidate); };
    pcAnswer.onicecandidate = function (e) { if (e.candidate) pcOffer.addIceCandidate(e.candidate); };

    var sender = pcOffer.addTrack(track, stream);

    // Force AV1 before the offer (setCodecPreferences does not use a transactionId)
    var transceivers = pcOffer.getTransceivers();
    if (transceivers[0]) {
      try { transceivers[0].setCodecPreferences(av1); out.note = "av1 only via setCodecPreferences"; } catch (e) { out.note = "setCodecPreferences failed: " + e.message; }
    }

    var offer = await pcOffer.createOffer();
    await pcOffer.setLocalDescription(offer);
    await pcAnswer.setRemoteDescription(offer);
    var answer = await pcAnswer.createAnswer();
    await pcAnswer.setLocalDescription(answer);
    await pcOffer.setRemoteDescription(answer);

    // Let it encode for a bit
    await new Promise(function (r) { setTimeout(r, 8000); });
    clearInterval(drawId);

    // Sample outbound-rtp stats
    var stats = await sender.getStats();
    sts = [];
    stats.forEach(function (s) {
      if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
        sts.push({
          codecId: s.codecId,
          framesEncoded: s.framesEncoded || 0,
          framesSent: s.framesSent || 0,
          totalEncodeTime: s.totalEncodeTime || 0,
          width: s.frameWidth || 0,
          height: s.frameHeight || 0,
          framesPerSecond: s.framesPerSecond || 0,
          packetsSent: s.packetsSent || 0,
          retransmittedBytesSent: s.retransmittedBytesSent || 0,
          keyFramesEncoded: s.keyFramesEncoded || 0,
          qualityLimitationReason: s.qualityLimitationReason || "",
          encoderImplementation: s.encoderImplementation || "",
          scalabilityMode: s.scalabilityMode || "",
          targetBitrate: s.targetBitrate || 0
        });
      }
      // also collect codec entries so we can resolve the mimeType
    });

    // Resolve codecId -> mimeType
    var codecInfo = null;
    stats.forEach(function (s) {
      if (s.type === 'codec' && sts.length && sts[0].codecId === s.id) codecInfo = s;
    });
    if (codecInfo) sts[0].mimeType = codecInfo.mimeType || "";

    out.ok = true;
    out.stats = sts;
    out.note = out.note || "encoded";
    window.chrome.webview.postMessage(JSON.stringify(out));
  } catch (e) {
    out.note = "error: " + (e && e.message || e);
    window.chrome.webview.postMessage(JSON.stringify(out));
  }
})();
</script></body></html>
""";
        wv.NavigateToString(html);
    }
}

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        var outDir = args.Length > 0 ? args[0] : ".";
        Directory.CreateDirectory(outDir);
        var stockPath = Path.Combine(outDir, "encode-stock.json");
        var flagsPath = Path.Combine(outDir, "encode-flags.json");

        var withFlags = args.Length > 1 && args[1] == "flags";
        var label = withFlags ? "with hardware-encoder flags" : "stock WebView2";
        var path = withFlags ? flagsPath : stockPath;

        var app = new System.Windows.Application();
        app.ShutdownMode = ShutdownMode.OnMainWindowClose;
        app.Run(new EncodeProbeWindow(path, label, withFlags));
        return 0;
    }
}
