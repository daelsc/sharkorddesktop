/**
 * WebRTC stats/control injection — pure string builders.
 *
 * These run inside the SPA iframe (cross-origin), so they must be self-contained
 * JS strings with NO imports. Extracted here (electron-free) so they can be unit
 * tested in vitest against a mock RTCPeerConnection — the bitrate cap algorithm
 * is subtle (setParameters transactionId invalidation, simulcast high-layer
 * selection) and previously broke silently.
 *
 * The strings are deliberately written as an array joined with '' (single line)
 * so they CANNOT contain slash-slash line comments — a line comment would swallow the
 * rest of the code to EOF (this was a real bug). Use block comments only.
 */

export type WebrtcStatsInjectionOptions = {
  /** Forced bitrate in bps. 0 = Auto (let the bandwidth estimator decide). */
  forcedBps: number;
  /** Forced codec short name, e.g. "H264", or "AUTO" to let the app decide. */
  forcedCodec: string;
};

/**
 * Force b=AS bandwidth in SDP, skipping simulcast m-lines. A single b=AS cap on
 * a simulcast m-line throttles the aggregate across all layers and can starve
 * the high layer; simulcast sections carry `a=simulcast`. Extracted as a pure fn
 * so it can be unit-tested (regex correctness, no double-cap, audio untouched,
 * Auto no-op). The injection string calls this via the same logic.
 */
export function forceSdpBandwidth(sdp: string, forcedBps: number): string {
  if (!sdp || !forcedBps) return sdp;
  const bwKbps = Math.round(forcedBps / 1000);
  const sections = sdp.split(/(?=m=)/);
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].indexOf('m=video') === 0) {
      if (/a=simulcast/i.test(sections[i])) continue;
      sections[i] = sections[i].replace(/b=AS:\d+\r?\n/g, '');
      sections[i] = sections[i].replace(/(m=video[^\n]+\n)/, '$1b=AS:' + bwKbps + '\r\n');
    }
  }
  return sections.join('');
}

/**
 * Builds the webrtc-stats + control injection. Wraps RTCPeerConnection to:
 *  - force the preferred codec on video transceivers (setCodecPreferences)
 *  - apply bitrate limits (cap the simulcast HIGH layer live via setParameters;
 *    single-stream min=max force + maintain-resolution)
 *  - force b=AS bandwidth in SDP (skipping simulcast m-lines)
 *  - poll getStats() every 2s and postMessage sharkord-rtc-stats to the parent
 *  - handle sharkord-set-video-bitrate / -codec messages live
 */
export function buildWebrtcStatsInjection(opts: WebrtcStatsInjectionOptions): string {
  const FORCED_BPS = opts.forcedBps;
  const FORCED_CODEC = JSON.stringify(opts.forcedCodec);
  return [
    '(function(){if(window.__sharkordRtcStatsHooked)return;window.__sharkordRtcStatsHooked=true;',
    'var OrigPC=window.RTCPeerConnection;if(!OrigPC)return;',
    'var pcs=[];',
    'var FORCED_BPS=' + FORCED_BPS + ';',
    'var FORCED_CODEC=' + FORCED_CODEC + ';',

    /* Force preferred codec on transceivers. Applies to simulcast senders too —
       we PROVED Chromium + NVENC do 3-layer H264 simulcast (1080p), so forcing
       H264 via setCodecPreferences makes the desktop default take effect.
       setCodecPreferences does NOT use a transactionId (unlike setParameters),
       so it is safe to call here. "AUTO" = let the app decide (no forcing). */
    'function forceCodec(pc){',
    '  if(!FORCED_CODEC||FORCED_CODEC==="AUTO")return;',
    '  try{var transceivers=pc.getTransceivers();',
    '  transceivers.forEach(function(t){',
    '    if(!t.sender||!t.sender.track||t.sender.track.kind!=="video")return;',
    '    if(!OrigPC.getCapabilities)return;',
    '    var caps=OrigPC.getCapabilities("video");',
    '    if(!caps||!caps.codecs)return;',
    '    var mime="video/"+FORCED_CODEC;',
    /* Include RTX so retransmission keeps working on the forced codec. */
    '    var preferred=caps.codecs.filter(function(c){return c.mimeType===mime||c.mimeType==="video/rtx";});',
    '    if(preferred.length>0)try{t.setCodecPreferences(preferred);}catch(e){}',
    '  });}catch(e){}',
    '}',

    /* Apply bitrate limits. Two paths:
       SIMULCAST (screen share): cap the HIGH layer's maxBitrate only, leaving
         low/mid layers alone so the SFU can still subscribe to lower quality.
         Applied LIVE via setParameters (no reload). Auto (FORCED_BPS=0) removes
         the cap so the bandwidth estimator decides.
       SINGLE-stream (webcam): force min=max=FORCED_BPS + maintain-resolution to
         bypass the bandwidth estimator (desired for LAN). Auto = leave alone.
       CRITICAL: detect simulcast from THIS getParameters() result — do NOT call
       a helper that calls getParameters() again, which would invalidate p's
       transactionId and make setParameters reject silently. */
    'function applyBitrateLimits(pc){',
    '  try{pc.getSenders().forEach(function(s){',
    '    if(!s.track||s.track.kind!=="video")return;',
    '    var p=s.getParameters();',
    '    if(!p.encodings||p.encodings.length===0)p.encodings=[{}];',
    '    var sim=false;for(var si=0;si<p.encodings.length;si++){var se=p.encodings[si];if(se.rid||(se.scaleResolutionDownBy&&se.scaleResolutionDownBy>1)){sim=true;break;}}',
    '    if(sim){',
    '      var encs=p.encodings;var high=encs[encs.length-1];',
    '      for(var i=0;i<encs.length;i++){if(encs[i].scaleResolutionDownBy===1)high=encs[i];}',
    '      var lc=false;',
    '      if(FORCED_BPS>0){if(high.maxBitrate!==FORCED_BPS){high.maxBitrate=FORCED_BPS;lc=true;}}',
    '      else{if("maxBitrate" in high){delete high.maxBitrate;lc=true;}}',
    '      if(lc)s.setParameters(p).catch(function(){});',
    '      return;',
    '    }',
    '    if(!FORCED_BPS)return;',
    '    if(p.encodings.length>1)return;',
    '    var enc=p.encodings[0];var changed=false;',
    '    if(enc.maxBitrate!==FORCED_BPS){enc.maxBitrate=FORCED_BPS;changed=true;}',
    '    if(enc.minBitrate!==FORCED_BPS){enc.minBitrate=FORCED_BPS;changed=true;}',
    '    if(!p.degradationPreference||p.degradationPreference!=="maintain-resolution"){',
    '      p.degradationPreference="maintain-resolution";changed=true;}',
    '    if(changed)s.setParameters(p).catch(function(){});',
    '  });}catch(e){}',
    '}',

    /* Force bandwidth in SDP — skip simulcast m-lines. A single b=AS cap on a
       simulcast m-line throttles the aggregate across all layers and can starve
       the high layer. Simulcast sections carry `a=simulcast`. */
    'function forceSdpBandwidth(sdp){',
    '  if(!sdp||!FORCED_BPS)return sdp;',
    '  var bwKbps=Math.round(FORCED_BPS/1000);',
    '  var sections=sdp.split(/(?=m=)/);',
    '  for(var i=0;i<sections.length;i++){',
    '    if(sections[i].indexOf("m=video")===0){',
    '      if(/a=simulcast/i.test(sections[i]))continue;',
    '      sections[i]=sections[i].replace(/b=AS:\\d+\\r?\\n/g,"");',
    '      sections[i]=sections[i].replace(/(m=video[^\\n]+\\n)/,"$1b=AS:"+bwKbps+"\\r\\n");',
    '    }',
    '  }',
    '  return sections.join("");',
    '}',

    /* Wrap RTCPeerConnection. */
    'window.RTCPeerConnection=function(){',
    '  var args=Array.prototype.slice.call(arguments);',
    '  var pc=new(Function.prototype.bind.apply(OrigPC,[null].concat(args)));',
    '  pcs.push(pc);',
    '  pc.addEventListener("connectionstatechange",function(){',
    '    if(pc.connectionState==="closed"||pc.connectionState==="failed")pcs=pcs.filter(function(p){return p!==pc;});',
    '  });',

    /* Wrap setLocalDescription to force bandwidth in SDP. */
    '  var origSLD=pc.setLocalDescription.bind(pc);',
    '  pc.setLocalDescription=function(desc){',
    '    if(desc&&desc.sdp)desc=Object.assign({},desc,{sdp:forceSdpBandwidth(desc.sdp)});',
    '    return origSLD.call(this,desc);',
    '  };',

    /* On track added, force codec and apply bitrate. */
    '  pc.addEventListener("track",function(){forceCodec(pc);applyBitrateLimits(pc);});',
    '  var origAddTrack=pc.addTrack.bind(pc);',
    '  pc.addTrack=function(){var r=origAddTrack.apply(this,arguments);forceCodec(pc);applyBitrateLimits(pc);return r;};',

    /* Wrap createOffer to force codec before offer. */
    '  var origCreateOffer=pc.createOffer.bind(pc);',
    '  pc.createOffer=function(){forceCodec(pc);return origCreateOffer.apply(this,arguments);};',

    '  return pc;',
    '};',
    'window.RTCPeerConnection.prototype=OrigPC.prototype;',
    'Object.keys(OrigPC).forEach(function(k){try{window.RTCPeerConnection[k]=OrigPC[k];}catch(e){}});',

    /* Bitrate/codec message handlers (override from the desktop UI, live). */
    'window.addEventListener("message",function(e){',
    '  if(e.data&&e.data.type==="sharkord-set-video-bitrate"&&typeof e.data.bps==="number"){FORCED_BPS=e.data.bps;pcs.forEach(function(pc){applyBitrateLimits(pc);});}',
    '  if(e.data&&e.data.type==="sharkord-set-video-codec"&&typeof e.data.codec==="string"){FORCED_CODEC=e.data.codec;pcs.forEach(function(pc){forceCodec(pc);});}',
    '});',

    /* Stats loop: poll getStats() every 2s and post a sharkord-rtc-stats report
       to the parent. prev{} caches the last sample per (pc,ssrc) to compute
       bitrate deltas. */
    'var prev={};',
    'setInterval(function(){pcs.forEach(function(pc,idx){if(pc.connectionState==="closed")return;',
    'applyBitrateLimits(pc);',
    'pc.getStats().then(function(stats){var report={pc:idx,audio_out:null,video_out:null,audio_in:null,video_in:null};',
    'stats.forEach(function(s){',
    'if(s.type==="outbound-rtp"&&s.bytesSent!==undefined){',
    'var key=idx+"_"+s.id;var p=prev[key];var bps=0;',
    'if(p){var dt=(s.timestamp-p.ts)/1000;if(dt>0)bps=8*(s.bytesSent-p.bytes)/dt;}',
    'prev[key]={ts:s.timestamp,bytes:s.bytesSent};',
    'var codecName="";if(s.codecId){var cs=stats.get(s.codecId);if(cs)codecName=cs.mimeType||"";}',
    'var info={bitrate:Math.round(bps),codec:codecName||s.codecId||"",frameRate:s.framesPerSecond||0,width:s.frameWidth||0,height:s.frameHeight||0,packets:s.packetsSent||0,nacks:s.nackCount||0,plis:s.pliCount||0,firs:s.firCount||0,retransmitted:s.retransmittedBytesSent||0,qpSum:s.qpSum||0,framesEncoded:s.framesEncoded||0,encoderImplementation:s.encoderImplementation||""};',
    'if(s.kind==="audio"||s.mediaType==="audio")report.audio_out=info;',
    'else if(s.kind==="video"||s.mediaType==="video")report.video_out=info;',
    '}',
    'if(s.type==="inbound-rtp"&&s.bytesReceived!==undefined){',
    'var key2=idx+"_"+s.id;var p2=prev[key2];var bps2=0;',
    'if(p2){var dt2=(s.timestamp-p2.ts)/1000;if(dt2>0)bps2=8*(s.bytesReceived-p2.bytes)/dt2;}',
    'prev[key2]={ts:s.timestamp,bytes:s.bytesReceived};',
    'var codecName2="";if(s.codecId){var cs2=stats.get(s.codecId);if(cs2)codecName2=cs2.mimeType||"";}',
    'var info2={bitrate:Math.round(bps2),codec:codecName2||s.codecId||"",packetsLost:s.packetsLost||0,jitter:s.jitter||0,frameRate:s.framesPerSecond||0,width:s.frameWidth||0,height:s.frameHeight||0};',
    'if(s.kind==="audio"||s.mediaType==="audio")report.audio_in=info2;',
    'else if(s.kind==="video"||s.mediaType==="video")report.video_in=info2;',
    '}',
    '});',
    'if(report.audio_out||report.video_out||report.audio_in||report.video_in){',
    'try{window.parent.postMessage({type:"sharkord-rtc-stats",report:report},"*");}catch(e){}',
    '}',
    '}).catch(function(){});});},2000);',

    '})();'
  ].join('');
}

/**
 * Builds the simulcast-codec injection: defaults the SPA's `screenCodec` device
 * setting to video/H264 on load (H264 NVENC is the desktop default). If the stored
 * value isn't H264, writes H264 and reloads the SPA once so DevicesProvider
 * rehydrates it. Self-limiting (no reload loop). Runs only in the desktop SPA
 * frame; web clients keep their own default.
 */
export function buildSimulcastCodecInjection(): string {
  return [
    '(function(){if(window.__sharkordSimulcastCodecHooked)return;window.__sharkordSimulcastCodecHooked=true;',
    'var KEY="sharkord-devices-settings";',
    'try{',
    '  var raw=localStorage.getItem(KEY);',
    '  var o=raw?JSON.parse(raw):{};',
    '  if(o.screenCodec!=="video/H264"){',
    '    o.screenCodec="video/H264";',
    '    localStorage.setItem(KEY,JSON.stringify(o));',
    '    console.log("[Sharkov] defaulting simulcast screenCodec to video/H264");',
    '    window.location.reload();',
    '  }',
    '}catch(e){}',
    '})();'
  ].join('');
}
