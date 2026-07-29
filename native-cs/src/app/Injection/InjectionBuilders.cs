using System.Text.RegularExpressions;
using Sharkov.App.Models;

namespace Sharkov.App.Injection;

/// <summary>Pure string builders for the JS injected into the cross-origin SPA iframes.
/// Mirrors <c>src/webrtcStatsInjection.ts</c>: the JS content is ported verbatim (it runs
/// in the same Chromium DOM/WebRTC API under WebView2), and the builders are pure so they
/// can be unit-tested in xUnit/Jint without spinning up the WebView.
///
/// The strings are deliberately written as arrays joined with "" (single line) so they
/// CANNOT contain slash-slash line comments — a line comment would swallow the rest of the
/// code to EOF (this was a real bug in the Electron app). Block comments only.</summary>
public static class InjectionBuilders
{
    // Cross-runtime message bridge: WebView2's host channel is `chrome.webview.postMessage`
    // (available in the top frame of the WebView2, which is where the SPA runs in the native
    // app). In the Electron app the SPA sits in an iframe and talks to the wrapper via
    // `parent.postMessage`. Every injected hook posts through __sharkordPost so the
    // sharkord-* protocol works unchanged under both hosts. Defined at top-frame script
    // scope (outside any IIFE) so it persists across the injection strings.
    private const string BridgePreamble =
        "if(!window.__sharkordPost){window.__sharkordPost=function(msg,origin){" +
        "try{if(window.chrome&&window.chrome.webview&&window.chrome.webview.postMessage){window.chrome.webview.postMessage(msg);return true;}}catch(e){}" +
        "try{if(window.parent&&window.parent!==window){window.parent.postMessage(msg,origin||\"*\");return true;}}catch(e){}" +
        "return false;};}";

    // ---- webrtc stats + control injection (codec force, live bitrate cap, SDP bw, stats loop) ----

    public static string BuildWebrtcStatsInjection(int forcedBps, string forcedCodec) => string.Concat(new[]
    {
        BridgePreamble,
        "(function(){if(window.__sharkordRtcStatsHooked)return;window.__sharkordRtcStatsHooked=true;",
        "var OrigPC=window.RTCPeerConnection;if(!OrigPC)return;",
        "var pcs=[];window.__sharkordPcs=pcs; /* exposed for the CDP self-test driver */",
        "var FORCED_BPS=", forcedBps.ToString(System.Globalization.CultureInfo.InvariantCulture), ";",
        "var FORCED_CODEC=", JsonQuote(forcedCodec), ";",

        "function forceCodec(pc){",
        "  if(!FORCED_CODEC||FORCED_CODEC===\"AUTO\")return;",
        "  try{var transceivers=pc.getTransceivers();",
        "  transceivers.forEach(function(t){",
        "    if(!t.sender||!t.sender.track||t.sender.track.kind!==\"video\")return;",
        "    if(!OrigPC.getCapabilities)return;",
        "    var caps=OrigPC.getCapabilities(\"video\");",
        "    if(!caps||!caps.codecs)return;",
        "    var mime=\"video/\"+FORCED_CODEC;",
        "    var preferred=caps.codecs.filter(function(c){return c.mimeType===mime||c.mimeType===\"video/rtx\";});",
        "    if(preferred.length>0)try{t.setCodecPreferences(preferred);}catch(e){}",
        "  });}catch(e){}",
        "}",

        "function applyBitrateLimits(pc){",
        "  try{pc.getSenders().forEach(function(s){",
        "    if(!s.track||s.track.kind!==\"video\")return;",
        "    var p=s.getParameters();",
        "    if(!p.encodings||p.encodings.length===0)p.encodings=[{}];",
        "    var sim=false;for(var si=0;si<p.encodings.length;si++){var se=p.encodings[si];if(se.rid||(se.scaleResolutionDownBy&&se.scaleResolutionDownBy>1)){sim=true;break;}}",
        "    if(sim){",
        "      var encs=p.encodings;var high=encs[encs.length-1];",
        "      for(var i=0;i<encs.length;i++){if(encs[i].scaleResolutionDownBy===1)high=encs[i];}",
        "      var lc=false;",
        "      if(FORCED_BPS>0){if(high.maxBitrate!==FORCED_BPS){high.maxBitrate=FORCED_BPS;lc=true;}}",
        "      else{if(\"maxBitrate\" in high){delete high.maxBitrate;lc=true;}}",
        "      if(lc)s.setParameters(p).catch(function(){});",
        "      return;",
        "    }",
        "    if(!FORCED_BPS)return;",
        "    if(p.encodings.length>1)return;",
        "    var enc=p.encodings[0];var changed=false;",
        "    var isSvc=!!enc.scalabilityMode;",
        "    if(enc.maxBitrate!==FORCED_BPS){enc.maxBitrate=FORCED_BPS;changed=true;}",
        "    if(!isSvc){",
        "      if(enc.minBitrate!==FORCED_BPS){enc.minBitrate=FORCED_BPS;changed=true;}",
        "      if(!p.degradationPreference||p.degradationPreference!==\"maintain-resolution\"){",
        "        p.degradationPreference=\"maintain-resolution\";changed=true;}",
        "    }",
        "    if(changed)s.setParameters(p).catch(function(){});",
        "  });}catch(e){}",
        "}",

        "function forceSdpBandwidth(sdp){",
        "  if(!sdp||!FORCED_BPS)return sdp;",
        "  var bwKbps=Math.round(FORCED_BPS/1000);",
        "  var sections=sdp.split(/(?=m=)/);",
        "  for(var i=0;i<sections.length;i++){",
        "    if(sections[i].indexOf(\"m=video\")===0){",
        "      if(/a=simulcast/i.test(sections[i]))continue;",
        "      sections[i]=sections[i].replace(/b=AS:\\d+\\r?\\n/g,\"\");",
        "      sections[i]=sections[i].replace(/(m=video[^\\n]+\\n)/,\"$1b=AS:\"+bwKbps+\"\\r\\n\");",
        "    }",
        "  }",
        "  return sections.join(\"\");",
        "}",

        "window.RTCPeerConnection=function(){",
        "  var args=Array.prototype.slice.call(arguments);",
        "  var pc=new(Function.prototype.bind.apply(OrigPC,[null].concat(args)));",
        "  pcs.push(pc);",
        "  pc.addEventListener(\"connectionstatechange\",function(){",
        "    if(pc.connectionState===\"closed\"||pc.connectionState===\"failed\")pcs=pcs.filter(function(p){return p!==pc;});",
        "  });",

        "  var origSLD=pc.setLocalDescription.bind(pc);",
        "  pc.setLocalDescription=function(desc){",
        "    if(desc&&desc.sdp)desc=Object.assign({},desc,{sdp:forceSdpBandwidth(desc.sdp)});",
        "    return origSLD.call(this,desc);",
        "  };",

        "  pc.addEventListener(\"track\",function(){forceCodec(pc);applyBitrateLimits(pc);});",
        "  var origAddTrack=pc.addTrack.bind(pc);",
        "  pc.addTrack=function(){var r=origAddTrack.apply(this,arguments);forceCodec(pc);applyBitrateLimits(pc);return r;};",

        "  var origCreateOffer=pc.createOffer.bind(pc);",
        "  pc.createOffer=function(){forceCodec(pc);return origCreateOffer.apply(this,arguments);};",

        "  return pc;",
        "};",
        "window.RTCPeerConnection.prototype=OrigPC.prototype;",
        "Object.keys(OrigPC).forEach(function(k){try{window.RTCPeerConnection[k]=OrigPC[k];}catch(e){}});",

        "window.addEventListener(\"message\",function(e){",
        "  if(e.data&&e.data.type===\"sharkord-set-video-bitrate\"&&typeof e.data.bps===\"number\"){FORCED_BPS=e.data.bps;pcs.forEach(function(pc){applyBitrateLimits(pc);});}",
        "  if(e.data&&e.data.type===\"sharkord-set-video-codec\"&&typeof e.data.codec===\"string\"){FORCED_CODEC=e.data.codec;pcs.forEach(function(pc){forceCodec(pc);});}",
        "});",

        "var prev={};",
        "setInterval(function(){pcs.forEach(function(pc,idx){if(pc.connectionState===\"closed\")return;",
        "applyBitrateLimits(pc);",
        "pc.getStats().then(function(stats){var report={pc:idx,audio_out:null,video_out:null,audio_in:null,video_in:null};",
        "stats.forEach(function(s){",
        "if(s.type===\"outbound-rtp\"&&s.bytesSent!==undefined){",
        "var key=idx+\"_\"+s.id;var p=prev[key];var bps=0;",
        "if(p){var dt=(s.timestamp-p.ts)/1000;if(dt>0)bps=8*(s.bytesSent-p.bytes)/dt;}",
        "prev[key]={ts:s.timestamp,bytes:s.bytesSent};",
        "var codecName=\"\";if(s.codecId){var cs=stats.get(s.codecId);if(cs)codecName=cs.mimeType||\"\";}",
        "var info={bitrate:Math.round(bps),codec:codecName||s.codecId||\"\",frameRate:s.framesPerSecond||0,width:s.frameWidth||0,height:s.frameHeight||0,packets:s.packetsSent||0,nacks:s.nackCount||0,plis:s.pliCount||0,firs:s.firCount||0,retransmitted:s.retransmittedBytesSent||0,qpSum:s.qpSum||0,framesEncoded:s.framesEncoded||0,encoderImplementation:s.encoderImplementation||\"\",targetBitrate:s.targetBitrate||0,qualityLimitationReason:s.qualityLimitationReason||\"\",qualityLimitationDurations:s.qualityLimitationDurations||null};",
        "if(s.kind===\"audio\"||s.mediaType===\"audio\")report.audio_out=info;",
        "else if(s.kind===\"video\"||s.mediaType==\"video\")report.video_out=info;",
        "}",
        "if(s.type==\"inbound-rtp\"&&s.bytesReceived!==undefined){",
        "var key2=idx+\"_\"+s.id;var p2=prev[key2];var bps2=0;",
        "if(p2){var dt2=(s.timestamp-p2.ts)/1000;if(dt2>0)bps2=8*(s.bytesReceived-p2.bytes)/dt;}",
        "prev[key2]={ts:s.timestamp,bytes:s.bytesReceived};",
        "var codecName2=\"\";if(s.codecId){var cs2=stats.get(s.codecId);if(cs2)codecName2=cs2.mimeType||\"\";}",
        "var info2={bitrate:Math.round(bps2),codec:codecName2||s.codecId||\"\",packetsLost:s.packetsLost||0,jitter:s.jitter||0,frameRate:s.framesPerSecond||0,width:s.frameWidth||0,height:s.frameHeight||0};",
        "if(s.kind===\"audio\"||s.mediaType===\"audio\")report.audio_in=info2;",
        "else if(s.kind===\"video\"||s.mediaType==\"video\")report.video_in=info2;",
        "}",
        "});",
        "if(report.audio_out||report.video_out||report.audio_in||report.video_in){",
        "try{__sharkordPost({type:\"sharkord-rtc-stats\",report:report},\"*\");}catch(e){}",
        "}",
        "}).catch(function(){});});},2000);",

        "})();"
    });

    // ---- simulcast codec injection (default SPA screenCodec to H264, wire bitrate selector) ----

    public static string BuildSimulcastCodecInjection() => string.Concat(new[]
    {
        BridgePreamble,
        "(function(){if(window.__sharkordSimulcastCodecHooked)return;window.__sharkordSimulcastCodecHooked=true;",
        "var KEY=\"sharkord-devices-settings\";",
        "try{",
        "  var raw=localStorage.getItem(KEY);",
        "  var o=raw?JSON.parse(raw):{};",
        "  if(o.screenCodec!==\"video/H264\"){",
        "    o.screenCodec=\"video/H264\";",
        "    localStorage.setItem(KEY,JSON.stringify(o));",
        "    console.log(\"[Sharkov] defaulting simulcast screenCodec to video/H264\");",
        "    window.location.reload();",
        "  }",
        "}catch(e){}",
        "try{__sharkordPost({type:\"sharkord-request-bitrate\"},\"*\");}catch(e){}",
        "function readSettings(){try{return JSON.parse(localStorage.getItem(KEY)||\"{}\")}catch(e){return{}}}",
        "function writeSettings(o){try{localStorage.setItem(KEY,JSON.stringify(o))}catch(e){}}",
        "window.addEventListener(\"message\",function(e){",
        "  if(!e.data||e.data.type!==\"sharkord-set-video-bitrate\"||typeof e.data.bps!==\"number\")return;",
        "  var kbps=e.data.bps>0?Math.round(e.data.bps/1000):0;",
        "  try{",
        "    var o=readSettings();",
        "    var cur=o.screenBitrate;",
        "    var changed=false;",
        "    if(kbps===0){ if(\"screenBitrate\" in o){ delete o.screenBitrate; changed=true; } }",
        "    else { if(cur!==kbps){ o.screenBitrate=kbps; changed=true; } }",
        "    if(changed){ writeSettings(o); console.log(\"[Sharkov] set simulcast screenBitrate=\"+(kbps||\"auto\")); window.location.reload(); }",
        "  }catch(err){}",
        "});",
        "})();"
    });

    // ---- device prefs injection (getUserMedia, enumerateDevices, PTT, getDisplayMedia + per-process audio worklet) ----

    public static string BuildDevicePrefsInjection(string prefsJson, string? pttBinding) => string.Concat(new[]
    {
        BridgePreamble,
        "(function(){var p=", prefsJson, ";var md=navigator.mediaDevices;if(!md)return;",
        "window.__sharkordPttAudioTracks=window.__sharkordPttAudioTracks||[];",
        // The PTT binding is stored on window so the picker can update it live (see
        // BuildPttBindingUpdateJs) without re-running this whole injection (which would
        // double-wrap getUserMedia — this IIFE has no idempotency guard by design).
        "window.__sharkordPttBinding=", pttBinding is null ? "null" : JsonQuote(pttBinding), ";",
        "var origGUM=md.getUserMedia&&md.getUserMedia.bind(md);var origEnum=md.enumerateDevices&&md.enumerateDevices.bind(md);",
        "function addTracksToPtt(stream){if(!stream.getAudioTracks)return;stream.getAudioTracks().forEach(function(tr){if(window.__sharkordPttAudioTracks.indexOf(tr)===-1)window.__sharkordPttAudioTracks.push(tr);if(window.__sharkordPttBinding)tr.enabled=false;});}",
        "if(origGUM){md.getUserMedia=function(c){var t=typeof c===\"object\"&&c!==null?JSON.parse(JSON.stringify(c)):{};",
        "if(p.audioInput===\"none\"&&t.audio)t.audio=false;else if(p.audioInput&&p.audioInput!==\"none\"&&t.audio){t.audio=t.audio===true?{deviceId:{exact:p.audioInput}}:Object.assign({},t.audio,{deviceId:{exact:p.audioInput}});}",
        "if(p.videoInput===\"none\"&&t.video)t.video=false;else if(p.videoInput&&p.videoInput!==\"none\"&&t.video){t.video=t.video===true?{deviceId:{exact:p.videoInput}}:Object.assign({},t.video,{deviceId:{exact:p.videoInput}});}",
        "return origGUM(t).then(function(stream){",
        "addTracksToPtt(stream);",
        "if(!stream.getAudioTracks||stream.getAudioTracks().length===0||p.audioInputVolume== null)return stream;",
        "var vol=(p.audioInputVolume/100)||1;if(vol===1)return stream;",
        "var ctx=new(window.AudioContext||window.webkitAudioContext)();var src=ctx.createMediaStreamSource(stream);var g=ctx.createGain();g.gain.value=vol;var dest=ctx.createMediaStreamDestination();src.connect(g);g.connect(dest);",
        "var out=new MediaStream();dest.stream.getAudioTracks().forEach(function(tr){out.addTrack(tr);});",
        "if(stream.getVideoTracks().length)stream.getVideoTracks().forEach(function(tr){out.addTrack(tr);});",
        "addTracksToPtt(out);",
        "return out;});};}",
        "if(origEnum){md.enumerateDevices=function(){var out=[];",
        "if(p.audioInput&&p.audioInput!==\"none\")out.push({deviceId:p.audioInput,kind:\"audioinput\",label:p.audioInputLabel||\"Microphone\",groupId:\"\"});",
        "if(p.videoInput&&p.videoInput!==\"none\")out.push({deviceId:p.videoInput,kind:\"videoinput\",label:p.videoInputLabel||\"Camera\",groupId:\"\"});",
        "return out.length>0?Promise.resolve(out):origEnum();};}",
        // PTT key listeners. They read window.__sharkordPttBinding at event time (not a
        // closure) so BuildPttBindingUpdateJs can change the key without re-installing.
        // Install both mouse and keyboard listeners once; each checks the live binding.
        "document.addEventListener(\"mousedown\",function(e){var b=window.__sharkordPttBinding;if(b&&String(b).indexOf(\"Mouse\")===0){var btn=parseInt(String(b).slice(5),10)||0;if(e.button===btn){e.preventDefault();try{__sharkordPost({type:\"sharkord-ptt\",pressed:true},\"*\");}catch(x){}}}},true);",
        "document.addEventListener(\"mouseup\",function(e){var b=window.__sharkordPttBinding;if(b&&String(b).indexOf(\"Mouse\")===0){var btn=parseInt(String(b).slice(5),10)||0;if(e.button===btn){e.preventDefault();try{__sharkordPost({type:\"sharkord-ptt\",pressed:false},\"*\");}catch(x){}}}},true);",
        "document.addEventListener(\"keydown\",function(e){var b=window.__sharkordPttBinding;if(b&&String(b).indexOf(\"Mouse\")!==0){if(e.code===String(b)){e.preventDefault();e.stopPropagation();try{__sharkordPost({type:\"sharkord-ptt\",pressed:true},\"*\");}catch(x){}}}},true);",
        "document.addEventListener(\"keyup\",function(e){var b=window.__sharkordPttBinding;if(b&&String(b).indexOf(\"Mouse\")!==0){if(e.code===String(b)){e.preventDefault();e.stopPropagation();try{__sharkordPost({type:\"sharkord-ptt\",pressed:false},\"*\");}catch(x){}}}},true);",
        "if(!window.__sharkordGDMWrapped){window.__sharkordGDMWrapped=true;",
        "var origGDM=md.getDisplayMedia&&md.getDisplayMedia.bind(md);",
        "if(origGDM){md.getDisplayMedia=function(c){",
        "c=typeof c===\"object\"&&c!==null?JSON.parse(JSON.stringify(c)):{};",
        "if(!c.video)c.video={};",
        "if(c.video===true)c.video={};",
        "c.video.width={ideal:1920};c.video.height={ideal:1080};c.video.frameRate={ideal:60};",
        "var ppid=window.__sharkordProcessAudioPid;",
        "if(ppid&&ppid>0)c.audio=false;",
        "return origGDM(c).then(function(stream){",
        "if(!ppid||ppid<=0)return stream;",
        "try{__sharkordPost({type:\"sharkord-start-process-audio\",pid:ppid},\"*\");}catch(e){}",
        "var workletSrc=\"class F extends AudioWorkletProcessor{constructor(){super();this.q=[];this.r=0;this.port.onmessage=function(e){if(e.data&&e.data.type===\\\"pcm\\\")this.q.push(new Float32Array(e.data.buffer));}.bind(this);}process(i,o){var ch=o[0];if(!ch||ch.length===0)return true;var fs=ch[0].length;var nc=ch.length;var w=0;while(w<fs&&this.q.length>0){var b=this.q[0];var ts=b.length/nc;var av=ts-this.r;var tk=Math.min(av,fs-w);for(var c=0;c<nc;c++){for(var s=0;s<tk;s++){ch[c][w+s]=b[(this.r+s)*nc+c];}}w+=tk;this.r+=tk;if(this.r>=ts){this.q.shift();this.r=0;}}for(var c=0;c<nc;c++){for(var s=w;s<fs;s++){ch[c][s]=0;}}return true;}}registerProcessor(\\\"process-audio-feeder\\\",F);\";",
        "var blob=new Blob([workletSrc],{type:\"application/javascript\"});var blobUrl=URL.createObjectURL(blob);",
        "var actx=new AudioContext({sampleRate:48000});",
        "return actx.resume().then(function(){return actx.audioWorklet.addModule(blobUrl);}).then(function(){",
        "var node=new AudioWorkletNode(actx,\"process-audio-feeder\",{outputChannelCount:[2],numberOfOutputs:1,numberOfInputs:0});",
        "var dest=actx.createMediaStreamDestination();node.connect(dest);",
        "function onPcm(e){if(e.data&&e.data.type===\"sharkord-process-audio-chunk\"&&e.data.buffer){node.port.postMessage({type:\"pcm\",buffer:e.data.buffer});}}",
        "window.addEventListener(\"message\",onPcm);",
        "stream.getAudioTracks().forEach(function(t){stream.removeTrack(t);t.stop();});",
        "dest.stream.getAudioTracks().forEach(function(t){stream.addTrack(t);});",
        "var vt=stream.getVideoTracks();if(vt.length>0){vt[0].addEventListener(\"ended\",function(){window.removeEventListener(\"message\",onPcm);try{__sharkordPost({type:\"sharkord-stop-process-audio\"},\"*\");}catch(e){}node.disconnect();actx.close();});}",
        "return stream;}).catch(function(err){console.error(\"[Sharkov] AudioWorklet setup failed:\",err);return stream;});});}}}",
        "})();"
    });

    // ---- clipboard copy intercept (route to parent so the native shell can show a modal) ----

    public static string BuildClipboardCopyInjection() => string.Concat(new[]
    {
        BridgePreamble,
        "(function(){",
        "if(!navigator.clipboard||typeof navigator.clipboard.writeText!==\"function\")return;",
        "var orig=navigator.clipboard.writeText.bind(navigator.clipboard);",
        "navigator.clipboard.writeText=function(text){",
        "if(typeof text===\"string\"){",
        "try{__sharkordPost({type:\"sharkord-copy-to-clipboard\",text:text},\"*\");}catch(e){}",
        "return Promise.resolve();",
        "}",
        "return orig(text);",
        "};",
        "})();"
    });

    // ---- mute incoming video streams by default (intercept srcObject on <video>) ----

    public static string BuildMuteStreamsInjection() => string.Concat(new[]
    {
        "(function(){if(window.__sharkordMuteStreamsHooked)return;window.__sharkordMuteStreamsHooked=true;",
        "var desc=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,\"srcObject\");",
        "if(desc&&desc.set){",
        "  var origSet=desc.set;",
        "  Object.defineProperty(HTMLMediaElement.prototype,\"srcObject\",{",
        "    get:desc.get,",
        "    set:function(v){",
        "      origSet.call(this,v);",
        "      if(v instanceof MediaStream&&this.tagName===\"VIDEO\"&&v.getVideoTracks().length>0){",
        "        this.muted=true;this.volume=0;",
        "        var el=this;if(el.paused)el.play().catch(function(){});",
        "      }",
        "    },",
        "    configurable:true,enumerable:true",
        "  });",
        "}",
        "})();"
    });

    // ---- credential capture (wrap fetch on POST /login, post creds to parent) ----

    public static string BuildCredentialCaptureInjection() => string.Concat(new[]
    {
        BridgePreamble,
        "(function(){if(window.__sharkordCredCaptureHooked)return;window.__sharkordCredCaptureHooked=true;",
        "var origFetch=window.fetch&&window.fetch.bind(window);if(!origFetch)return;",
        "var parentOrigin=\"*\";try{parentOrigin=window.parent.location.origin;}catch(e){parentOrigin=\"*\";}",
        "window.fetch=function(input,init){",
        "var reqUrl=typeof input===\"string\"?input:(input&&input.url)||\"\";",
        "var u;try{u=new URL(reqUrl,location.origin);}catch(e){return origFetch.apply(this,arguments);}",
        "var method=((init&&init.method)||\"GET\").toUpperCase();",
        "if(method!==\"POST\"||!/\\/login$/.test(u.pathname))return origFetch.apply(this,arguments);",
        "var body=null;try{body=init&&init.body?JSON.parse(init.body):null;}catch(e){body=null;}",
        "return origFetch.apply(this,arguments).then(function(resp){",
        "if(resp&&resp.ok&&body&&body.identity&&body.password){",
        "try{",
        "try{__sharkordPost({type:\"sharkord-save-credentials\",identity:body.identity,password:body.password},parentOrigin);}catch(e){}",
        "}catch(e){}",
        "}",
        "return resp;",
        "});",
        "};",
        "})();"
    });

    // ---- auto-login (poll for connect screen, request creds, fill, click Connect) ----

    public static string BuildAutoLoginInjection() => string.Concat(new[]
    {
        BridgePreamble,
        "(function(){if(window.__sharkordAutoLoginHooked)return;window.__sharkordAutoLoginHooked=true;",
        "var attempted=false;",
        "var parentOrigin=\"*\";try{parentOrigin=window.parent.location.origin;}catch(e){parentOrigin=\"*\";}",
        "function hasConnectScreen(){return !!document.querySelector(\"[data-testid=\\\"connect-identity-input\\\"]\");}",
        "function setNativeValue(el,value){",
        "var proto=el.tagName===\"TEXTAREA\"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;",
        "var desc=Object.getOwnPropertyDescriptor(proto,\"value\");",
        "if(desc&&desc.set)desc.set.call(el,value);else el.value=value;",
        "el.dispatchEvent(new Event(\"input\",{bubbles:true}));el.dispatchEvent(new Event(\"change\",{bubbles:true}));",
        "}",
        "function tryAutoLogin(){if(attempted||!hasConnectScreen())return;attempted=true;try{__sharkordPost({type:\"sharkord-request-credentials\"},parentOrigin);}catch(e){}}",
        "setInterval(tryAutoLogin,500);",
        "if(document.body){new MutationObserver(function(){tryAutoLogin();}).observe(document.body,{childList:true,subtree:true});}",
        "else{document.addEventListener(\"DOMContentLoaded\",function(){new MutationObserver(function(){tryAutoLogin();}).observe(document.body,{childList:true,subtree:true});});}",
        "window.addEventListener(\"message\",function(e){",
        "if(e.origin!==parentOrigin)return;",
        "if(!e.data||e.data.type!==\"sharkord-credentials\")return;",
        "if(!e.data.identity||!e.data.password)return;",
        "var idEl=document.querySelector(\"[data-testid=\\\"connect-identity-input\\\"]\");",
        "var pwEl=document.querySelector(\"[data-testid=\\\"connect-password-input\\\"]\");",
        "if(!idEl||!pwEl)return;",
        "setNativeValue(idEl,e.data.identity);setNativeValue(pwEl,e.data.password);",
        "var sw=document.querySelector(\"[data-testid=\\\"connect-auto-login-switch\\\"]\");",
        "if(sw){var isOn=!!sw.querySelector(\"[data-state=\\\"checked\\\"]\");if(!isOn)sw.click();}",
        "function clickConnect(){var btn=document.querySelector(\"[data-testid=\\\"connect-button\\\"]\");if(btn&&!btn.disabled){btn.click();return true;}return false;}",
        "if(!clickConnect()){setTimeout(function(){clickConnect();},100);}",
        "});",
        "})();"
    });

    // ---- WebSocket capture (so the host can close the SPA's tRPC socket on app quit) ----
    // The SPA's tRPC client opens a WebSocket (module-scoped in trpc.ts, never put on
    // window) and never closes it on quit. The server only fires "left the server" on
    // ws.close() (wss.ts: ws.on('close')); behind the nginx proxy an ungraceful quit can
    // hold the upstream open ~60s+, stacking zombie sessions (many "joined" with no
    // "left") which can crash the mediasoup worker under load. This hook records every
    // WebSocket so MainWindow.OnClosing can close them cleanly before the process dies.
    public static string BuildWebSocketCaptureInjection() => string.Concat(new[]
    {
        "(function(){if(window.__sharkordWsHooked)return;window.__sharkordWsHooked=true;",
        "if(!window.WebSocket)return;",
        "window.__sharkordWebSockets=[];",
        "var OrigWS=window.WebSocket;",
        "function WrappedWS(url,protocols){",
        "  var ws=protocols!==undefined?new OrigWS(url,protocols):new OrigWS(url);",
        "  window.__sharkordWebSockets.push(ws);",
        "  try{ws.addEventListener(\"close\",function(){",
        "    window.__sharkordWebSockets=window.__sharkordWebSockets.filter(function(x){return x!==ws;});",
        "  });}catch(e){}",
        "  return ws;",
        "}",
        "WrappedWS.prototype=OrigWS.prototype;",
        "try{WrappedWS.CONNECTING=OrigWS.CONNECTING;WrappedWS.OPEN=OrigWS.OPEN;",
        "WrappedWS.CLOSING=OrigWS.CLOSING;WrappedWS.CLOSED=OrigWS.CLOSED;}catch(e){}",
        "window.WebSocket=WrappedWS;",
        "})();"
    });

    /// <summary>JS that closes every tracked OPEN WebSocket (readyState === 1). Inject on
    /// app quit so the server detects the disconnect immediately and tears down voice
    /// state, instead of accumulating zombie sessions behind the proxy timeout. Returns
    /// the number of sockets it closed (for diagnostics; WebView2 returns it JSON-encoded).</summary>
    public static string BuildCloseWebSocketsJs() =>
        "(function(){var l=window.__sharkordWebSockets||[];var c=0;" +
        "l.forEach(function(s){try{if(s.readyState===1){s.close();c++;}}catch(e){}});return c;})();";

    /// <summary>Idempotent update of the PTT binding at runtime (used by the picker dialog).
    /// Sets window.__sharkordPttBinding (which the device-prefs key listeners read at event
    /// time) and re-applies mute state to existing tracks: a binding set mutes them (PTT
    /// = hold-to-talk), a cleared binding un-mutes them (open mic). Does NOT re-install
    /// listeners or re-wrap getUserMedia, so it's safe to call repeatedly.</summary>
    public static string BuildPttBindingUpdateJs(string? binding)
    {
        var b = binding is null ? "null" : JsonQuote(binding);
        return "(function(){window.__sharkordPttBinding=" + b + ";" +
               "var tracks=window.__sharkordPttAudioTracks||[];" +
               "tracks.forEach(function(t){try{t.enabled=!window.__sharkordPttBinding;}catch(e){}});})();";
    }

    // ---- pure C# port of forceSdpBandwidth (webrtcStatsInjection.ts:29) for unit testing ----

    /// <summary>Force b=AS bandwidth in SDP, skipping simulcast m-lines. A single b=AS cap on a
    /// simulcast m-line throttles the aggregate across all layers and can starve the high layer;
    /// simulcast sections carry <c>a=simulcast</c>. Auto (forcedBps=0) is a no-op.</summary>
    public static string ForceSdpBandwidth(string sdp, int forcedBps)
    {
        if (string.IsNullOrEmpty(sdp) || forcedBps == 0) return sdp;
        var bwKbps = Math.Round(forcedBps / 1000.0);
        var sections = Regex.Split(sdp, "(?=m=)");
        for (var i = 0; i < sections.Length; i++)
        {
            if (!sections[i].StartsWith("m=video", StringComparison.Ordinal)) continue;
            if (Regex.IsMatch(sections[i], "a=simulcast", RegexOptions.IgnoreCase)) continue;
            sections[i] = Regex.Replace(sections[i], @"b=AS:\d+\r?\n", "");
            sections[i] = Regex.Replace(sections[i], @"(m=video[^\n]+\n)", "$1b=AS:" + bwKbps + "\r\n");
        }
        return string.Join(string.Empty, sections);
    }

    /// <summary>Quote a string as a JS string literal (the builders emit JSON for prefs + codec).</summary>
    private static string JsonQuote(string s) => System.Text.Json.JsonSerializer.Serialize(s);
}
