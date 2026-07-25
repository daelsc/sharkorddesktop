import { app, BrowserWindow, Menu, shell, ipcMain, session, desktopCapturer, nativeImage, webFrameMain, clipboard, dialog, safeStorage } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { NsisUpdater } from 'electron-updater';
import { pathToFileURL } from 'node:url';
import * as processAudio from './processAudioBridge.js';
import { saveCredentials, loadCredentials, clearCredentials, type CredentialCrypto } from './credentials.js';

function getBuildId(): string {
  return app.getVersion();
}

/** Resolve a window HWND to its owning process PID via user32.dll */
function getWindowPid(hwnd: number): number {
  if (process.platform !== 'win32' || !hwnd) return 0;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const pidBuf = Buffer.alloc(4);
    user32.func('uint __stdcall GetWindowThreadProcessId(uintptr_t, _Out_ uint32_t*)')(hwnd, pidBuf);
    return pidBuf.readUInt32LE(0);
  } catch {
    return 0;
  }
}

type SavedServer = {
  id: string;
  url: string;
  name: string;
  icon?: string;
  keepConnected?: boolean;
  identity?: string;
  password?: string;
};
type StoreType = { get: (key: string, defaultValue?: string) => string; set: (key: string, value: string) => void };
let store: StoreType | null = null;

// NOTE: safeStorage.isEncryptionAvailable() returns false before the app has emitted its
// 'ready' event (on Windows it hard-returns false if Browser::is_ready() is false). Building
// credentialCrypto at module-load time therefore always produced null, which silently
// aborted every desktop-set-credentials IPC. Build it lazily on first use, after app.whenReady().
let credentialCrypto: CredentialCrypto | null = null;
function getCredentialCrypto(): CredentialCrypto | null {
  if (credentialCrypto) return credentialCrypto;
  if (!safeStorage.isEncryptionAvailable()) return null;
  credentialCrypto = {
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  };
  return credentialCrypto;
}

const SAVED_SERVERS_KEY = 'savedServers';
const DEVICE_PREFS_KEY = 'devicePreferences';

type DevicePreferences = {
  audioInput?: string;
  videoInput?: string;
  audioInputLabel?: string;
  videoInputLabel?: string;
  audioInputVolume?: number;
  /** Push-to-talk: e.g. "KeyP", "Mouse4", "Mouse5" */
  pttBinding?: string;
  /** Forced video bitrate in kbps (e.g. 6000 = 6 Mbps). 0 or undefined = no override. */
  videoBitrate?: number;
  /** Preferred video codec: "H264", "VP8", "VP9", "AV1". Default "H264". */
  videoCodec?: string;
};

function getDevicePreferences(): DevicePreferences {
  if (!store) return {};
  try {
    const raw = store.get(DEVICE_PREFS_KEY, '{}');
    return JSON.parse(raw) as DevicePreferences;
  } catch {
    return {};
  }
}

function setDevicePreferences(prefs: DevicePreferences): void {
  if (!store) return;
  store.set(DEVICE_PREFS_KEY, JSON.stringify(prefs));
}

function getSavedServers(): SavedServer[] {
  if (!store) return [];
  try {
    const raw = store.get(SAVED_SERVERS_KEY, '[]');
    return JSON.parse(raw) as SavedServer[];
  } catch {
    return [];
  }
}

function setSavedServers(servers: SavedServer[]): void {
  if (!store) return;
  store.set(SAVED_SERVERS_KEY, JSON.stringify(servers));
}

let mainWindow: BrowserWindow | null = null;

const DEFAULT_SERVER_URL = 'https://demo.sharkord.com';

function getServerUrl(): string {
  if (!store) return DEFAULT_SERVER_URL;
  const url = store.get('serverUrl', DEFAULT_SERVER_URL).trim();
  if (!url) return DEFAULT_SERVER_URL;
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}

function getIconPath(): string {
  const base = path.join(app.getAppPath(), 'static');
  if (process.platform === 'win32') {
    const ico = path.join(base, 'icon.ico');
    if (existsSync(ico)) return ico;
  }
  return path.join(base, 'icon.png');
}

function createMainWindow(): void {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  const winIcon = icon.isEmpty() ? undefined : icon;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Sharkov Desktop',
    ...(winIcon && { icon: winIcon }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'static', 'wrapper.html'));
  mainWindow.once('ready-to-show', () => {
    if (winIcon && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIcon(winIcon);
    }
    mainWindow?.show();
  });

  // Force close when user clicks X or chooses Quit (don't let the page block with beforeunload)
  mainWindow.on('close', (event) => {
    if (!mainWindow) return;
    event.preventDefault();
    mainWindow.destroy();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  // When tabbed out (blur), start polling PTT key state on Windows (GetAsyncKeyState). Stop when focused again.
  mainWindow.on('blur', () => { startPttBackgroundPollIfWindows(); });
  mainWindow.on('focus', () => { stopPttBackgroundPoll(); });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-frame-navigate', (_event, url, _httpResponseCode, _httpStatusText, _isMainFrame, frameProcessId, frameRoutingId) => {
    if (!url || url.startsWith('file:')) return;
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (frame && !(frame as { isDestroyed?: () => boolean }).isDestroyed?.()) {
      frame.once('dom-ready', () => {
        injectDevicePrefsIntoFrame(frame);
      });
    }
  });
  mainWindow.webContents.on('did-frame-finish-load', () => {
    injectDevicePrefsIntoFrames();
  });

}

function getDevicePrefsInjectionCode(): string {
  const prefs = getDevicePreferences();
  const prefsJson = JSON.stringify(prefs);
  const pttBinding = prefs.pttBinding ? JSON.stringify(prefs.pttBinding) : 'null';
  return [
    '(function(){var p=' + prefsJson + ';var md=navigator.mediaDevices;if(!md)return;',
    'window.__sharkordPttAudioTracks=window.__sharkordPttAudioTracks||[];',
    'var pttBinding=' + pttBinding + ';',
    'var origGUM=md.getUserMedia&&md.getUserMedia.bind(md);var origEnum=md.enumerateDevices&&md.enumerateDevices.bind(md);',
    'function addTracksToPtt(stream){if(!stream.getAudioTracks)return;stream.getAudioTracks().forEach(function(tr){if(window.__sharkordPttAudioTracks.indexOf(tr)===-1)window.__sharkordPttAudioTracks.push(tr);if(pttBinding)tr.enabled=false;});}',
    'if(origGUM){md.getUserMedia=function(c){var t=typeof c==="object"&&c!==null?JSON.parse(JSON.stringify(c)):{};',
    'if(p.audioInput==="none"&&t.audio)t.audio=false;else if(p.audioInput&&p.audioInput!=="none"&&t.audio){t.audio=t.audio===true?{deviceId:{exact:p.audioInput}}:Object.assign({},t.audio,{deviceId:{exact:p.audioInput}});}',
    'if(p.videoInput==="none"&&t.video)t.video=false;else if(p.videoInput&&p.videoInput!=="none"&&t.video){t.video=t.video===true?{deviceId:{exact:p.videoInput}}:Object.assign({},t.video,{deviceId:{exact:p.videoInput}});}',
    'return origGUM(t).then(function(stream){',
    'addTracksToPtt(stream);',
    'if(!stream.getAudioTracks||stream.getAudioTracks().length===0||p.audioInputVolume== null)return stream;',
    'var vol=(p.audioInputVolume/100)||1;if(vol===1)return stream;',
    'var ctx=new(window.AudioContext||window.webkitAudioContext)();var src=ctx.createMediaStreamSource(stream);var g=ctx.createGain();g.gain.value=vol;var dest=ctx.createMediaStreamDestination();src.connect(g);g.connect(dest);',
    'var out=new MediaStream();dest.stream.getAudioTracks().forEach(function(tr){out.addTrack(tr);});',
    'if(stream.getVideoTracks().length)stream.getVideoTracks().forEach(function(tr){out.addTrack(tr);});',
    'addTracksToPtt(out);',
    'return out;});};}',
    'if(origEnum){md.enumerateDevices=function(){var out=[];',
    'if(p.audioInput&&p.audioInput!=="none")out.push({deviceId:p.audioInput,kind:"audioinput",label:p.audioInputLabel||"Microphone",groupId:""});',
    'if(p.videoInput&&p.videoInput!=="none")out.push({deviceId:p.videoInput,kind:"videoinput",label:p.videoInputLabel||"Camera",groupId:""});',
    'return out.length>0?Promise.resolve(out):origEnum();};}',
    'if(pttBinding&&String(pttBinding).indexOf("Mouse")===0){var btn=parseInt(String(pttBinding).slice(5),10)||0;',
    'document.addEventListener("mousedown",function(e){if(e.button===btn){e.preventDefault();if(window.parent!==window)window.parent.postMessage({type:"sharkord-ptt",pressed:true},"*");}},true);',
    'document.addEventListener("mouseup",function(e){if(e.button===btn){e.preventDefault();if(window.parent!==window)window.parent.postMessage({type:"sharkord-ptt",pressed:false},"*");}},true);}',
    'if(pttBinding&&String(pttBinding).indexOf("Mouse")!==0){var keyCode=String(pttBinding);',
    'document.addEventListener("keydown",function(e){if(e.code===keyCode){e.preventDefault();e.stopPropagation();if(window.parent!==window)window.parent.postMessage({type:"sharkord-ptt",pressed:true},"*");}},true);',
    'document.addEventListener("keyup",function(e){if(e.code===keyCode){e.preventDefault();e.stopPropagation();if(window.parent!==window)window.parent.postMessage({type:"sharkord-ptt",pressed:false},"*");}},true);}',
    // Per-process audio: wrap getDisplayMedia once, check __sharkordProcessAudioPid at call time
    'if(!window.__sharkordGDMWrapped){window.__sharkordGDMWrapped=true;',
    'var origGDM=md.getDisplayMedia&&md.getDisplayMedia.bind(md);',
    'if(origGDM){md.getDisplayMedia=function(c){',
    'c=typeof c==="object"&&c!==null?JSON.parse(JSON.stringify(c)):{};',
    'if(!c.video)c.video={};',
    'if(c.video===true)c.video={};',
    'c.video.width={ideal:1920};c.video.height={ideal:1080};c.video.frameRate={ideal:60};',
    'var ppid=window.__sharkordProcessAudioPid;',
    'if(ppid&&ppid>0)c.audio=false;',
    'return origGDM(c).then(function(stream){',
    'if(!ppid||ppid<=0)return stream;',
    'window.parent.postMessage({type:"sharkord-start-process-audio",pid:ppid},"*");',
    'var workletSrc="class F extends AudioWorkletProcessor{constructor(){super();this.q=[];this.r=0;this.port.onmessage=function(e){if(e.data&&e.data.type===\\"pcm\\")this.q.push(new Float32Array(e.data.buffer));}.bind(this);}process(i,o){var ch=o[0];if(!ch||ch.length===0)return true;var fs=ch[0].length;var nc=ch.length;var w=0;while(w<fs&&this.q.length>0){var b=this.q[0];var ts=b.length/nc;var av=ts-this.r;var tk=Math.min(av,fs-w);for(var c=0;c<nc;c++){for(var s=0;s<tk;s++){ch[c][w+s]=b[(this.r+s)*nc+c];}}w+=tk;this.r+=tk;if(this.r>=ts){this.q.shift();this.r=0;}}for(var c=0;c<nc;c++){for(var s=w;s<fs;s++){ch[c][s]=0;}}return true;}}registerProcessor(\\"process-audio-feeder\\",F);";',
    'var blob=new Blob([workletSrc],{type:"application/javascript"});var blobUrl=URL.createObjectURL(blob);',
    'var actx=new AudioContext({sampleRate:48000});',
    'return actx.resume().then(function(){return actx.audioWorklet.addModule(blobUrl);}).then(function(){',
    'var node=new AudioWorkletNode(actx,"process-audio-feeder",{outputChannelCount:[2],numberOfOutputs:1,numberOfInputs:0});',
    'var dest=actx.createMediaStreamDestination();node.connect(dest);',
    'function onPcm(e){if(e.data&&e.data.type==="sharkord-process-audio-chunk"&&e.data.buffer){node.port.postMessage({type:"pcm",buffer:e.data.buffer});}}',
    'window.addEventListener("message",onPcm);',
    'stream.getAudioTracks().forEach(function(t){stream.removeTrack(t);t.stop();});',
    'dest.stream.getAudioTracks().forEach(function(t){stream.addTrack(t);});',
    'var vt=stream.getVideoTracks();if(vt.length>0){vt[0].addEventListener("ended",function(){window.removeEventListener("message",onPcm);window.parent.postMessage({type:"sharkord-stop-process-audio"},"*");node.disconnect();actx.close();});}',
    'return stream;}).catch(function(err){console.error("[Sharkov] AudioWorklet setup failed:",err);return stream;});});}}}',
    '})();'
  ].join('');
}

function getClipboardCopyInjectionCode(): string {
  return [
    '(function(){',
    'if(!navigator.clipboard||typeof navigator.clipboard.writeText!=="function")return;',
    'var orig=navigator.clipboard.writeText.bind(navigator.clipboard);',
    'navigator.clipboard.writeText=function(text){',
    'if(window.parent!==window&&typeof text==="string"){',
    'try{window.parent.postMessage({type:"sharkord-copy-to-clipboard",text:text},"*");}catch(e){}',
    'return Promise.resolve();',
    '}',
    'return orig(text);',
    '};',
    '})();'
  ].join('');
}

function getMuteStreamsInjectionCode(): string {
  return [
    '(function(){if(window.__sharkordMuteStreamsHooked)return;window.__sharkordMuteStreamsHooked=true;',
    // Override srcObject setter on HTMLMediaElement to mute video elements that receive a MediaStream
    'var desc=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"srcObject");',
    'if(desc&&desc.set){',
    '  var origSet=desc.set;',
    '  Object.defineProperty(HTMLMediaElement.prototype,"srcObject",{',
    '    get:desc.get,',
    '    set:function(v){',
    '      origSet.call(this,v);',
    '      if(v instanceof MediaStream&&this.tagName==="VIDEO"&&v.getVideoTracks().length>0){',
    '        this.muted=true;this.volume=0;',
    '        var el=this;if(el.paused)el.play().catch(function(){});',
    '      }',
    '    },',
    '    configurable:true,enumerable:true',
    '  });',
    '}',
    '})();'
  ].join('');
}

function getCredentialCaptureInjectionCode(): string {
  return [
    '(function(){if(window.__sharkordCredCaptureHooked)return;window.__sharkordCredCaptureHooked=true;',
    'var origFetch=window.fetch&&window.fetch.bind(window);if(!origFetch)return;',
    'window.fetch=function(input,init){',
    'var reqUrl=typeof input==="string"?input:(input&&input.url)||"";',
    'var u;try{u=new URL(reqUrl,location.origin);}catch(e){return origFetch.apply(this,arguments);}',
    'var method=((init&&init.method)||"GET").toUpperCase();',
    'if(method!=="POST"||!/\\/login$/.test(u.pathname))return origFetch.apply(this,arguments);',
    'var body=null;try{body=init&&init.body?JSON.parse(init.body):null;}catch(e){body=null;}',
    'return origFetch.apply(this,arguments).then(function(resp){',
    'if(resp&&resp.ok&&body&&body.identity&&body.password){',
    'try{',
    'window.parent.postMessage({type:"sharkord-save-credentials",identity:body.identity,password:body.password},"*");',
    '}catch(e){}',
    '}',
    'return resp;',
    '});',
    '};',
    '})();'
  ].join('');
}

function getAutoLoginInjectionCode(): string {
  return [
    '(function(){if(window.__sharkordAutoLoginHooked)return;window.__sharkordAutoLoginHooked=true;',
    'var attempted=false;',
    'function hasConnectScreen(){return !!document.querySelector("[data-testid=\\"connect-identity-input\\"]");}',
    'function setNativeValue(el,value){',
    'var proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;',
    'var desc=Object.getOwnPropertyDescriptor(proto,"value");',
    'if(desc&&desc.set)desc.set.call(el,value);else el.value=value;',
    'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));',
    '}',
    'function tryAutoLogin(){if(attempted||!hasConnectScreen())return;attempted=true;window.parent.postMessage({type:"sharkord-request-credentials"},"*");}',
    'setInterval(tryAutoLogin,500);',
    'if(document.body){new MutationObserver(function(){tryAutoLogin();}).observe(document.body,{childList:true,subtree:true});}',
    'else{document.addEventListener("DOMContentLoaded",function(){new MutationObserver(function(){tryAutoLogin();}).observe(document.body,{childList:true,subtree:true});});}',
    'window.addEventListener("message",function(e){',
    'if(!e.data||e.data.type!=="sharkord-credentials")return;',
    'if(!e.data.identity||!e.data.password)return;',
    'var idEl=document.querySelector("[data-testid=\\"connect-identity-input\\"]");',
    'var pwEl=document.querySelector("[data-testid=\\"connect-password-input\\"]");',
    'if(!idEl||!pwEl)return;',
    'setNativeValue(idEl,e.data.identity);setNativeValue(pwEl,e.data.password);',
    'var sw=document.querySelector("[data-testid=\\"connect-auto-login-switch\\"]");',
    'if(sw){var isOn=!!sw.querySelector("[data-state=\\"checked\\"]");if(!isOn)sw.click();}',
    'function clickConnect(){var btn=document.querySelector("[data-testid=\\"connect-button\\"]");if(btn&&!btn.disabled){btn.click();return true;}return false;}',
    'if(!clickConnect()){setTimeout(function(){clickConnect();},100);}',
    '});',
    '})();'
  ].join('');
}

function getWebrtcStatsInjectionCode(): string {
  const prefs = getDevicePreferences();
  const FORCED_BPS = (prefs.videoBitrate || 5000) * 1000; // kbps -> bps, default 5 Mbps
  const FORCED_CODEC = JSON.stringify(prefs.videoCodec || 'H264');
  return [
    '(function(){if(window.__sharkordRtcStatsHooked)return;window.__sharkordRtcStatsHooked=true;',
    'var OrigPC=window.RTCPeerConnection;if(!OrigPC)return;',
    'var pcs=[];',
    'var FORCED_BPS=' + FORCED_BPS + ';',
    'var FORCED_CODEC=' + FORCED_CODEC + ';',

    // Force preferred codec on transceivers — but NEVER on simulcast senders.
    // A simulcast sender uses the app-chosen simulcast codec (VP8/AV1). Forcing
    // H264/H265 here would break simulcast: Chromium can't do 3-layer H264/H265
    // simulcast, so the upper layers would die. "AUTO" means let the app decide
    // (no forcing at all) — preserves upstream simulcast.
    //
    // Robust simulcast detection: getParameters().encodings can COLLAPSE to the
    // base layer when the upper layers are inactive (P2P, or an SFU not yet
    // subscribed to mid/high), so encodings.length>1 alone misses real simulcast
    // senders and would let us force-collapse them. The base encoding keeps its
    // `rid` and scaleResolutionDownBy through the collapse, so detect on those.
    'function isSimulcastSender(sender){',
    '  try{var p=sender.getParameters();if(!p||!p.encodings)return false;',
    '    if(p.encodings.length>1)return true;',
    '    for(var i=0;i<p.encodings.length;i++){var e=p.encodings[i];',
    '      if(e.rid)return true;',
    '      if(e.scaleResolutionDownBy&&e.scaleResolutionDownBy>1)return true;}',
    '    return false;}catch(e){return false;}',
    '}',
    'function forceCodec(pc){',
    '  if(!FORCED_CODEC||FORCED_CODEC==="AUTO")return;',
    '  try{var transceivers=pc.getTransceivers();',
    '  transceivers.forEach(function(t){',
    '    if(!t.sender||!t.sender.track||t.sender.track.kind!=="video")return;',
    // Apply to simulcast senders too: we PROVED Chromium + NVENC do 3-layer H264',
    // simulcast (1080p). Forcing the chosen codec via setCodecPreferences makes',
    // the desktop app\'s codec selection (default H264) take effect for simulcast',
    // WITHOUT depending on the server SPA bundle patch (which gets wiped on',
    // container restart). This is the restart-safe path.',
    '    if(!OrigPC.getCapabilities)return;',
    '    var caps=OrigPC.getCapabilities("video");',
    '    if(!caps||!caps.codecs)return;',
    '    var mime="video/"+FORCED_CODEC;',
    // Include RTX so retransmission keeps working on the forced codec.',
    '    var preferred=caps.codecs.filter(function(c){return c.mimeType===mime||c.mimeType==="video/rtx";});',
    '    if(preferred.length>0)try{t.setCodecPreferences(preferred);}catch(e){}',
    '  });}catch(e){}',
    '}',

    // Apply bitrate limits — but ONLY to single-stream senders. The old code forced
    // min=max=FORCED_BPS on EVERY encoding, which collapsed simulcast's distinct
    // low/mid/high quality layers into one flat bitrate (destroying simulcast).
    // For a simulcast sender we leave the app's per-layer bitrates untouched and
    // let the SFU manage per-layer congestion/subscription. For single-stream we
    // keep the original behaviour: force a constant bitrate to bypass the bandwidth
    // estimator (desired for LAN/local screen share) + maintain-resolution.
    'function applyBitrateLimits(pc){',
    '  if(!FORCED_BPS)return;',
    '  try{pc.getSenders().forEach(function(s){',
    '    if(!s.track||s.track.kind!=="video")return;',
    '    var p=s.getParameters();',
    '    if(!p.encodings||p.encodings.length===0)p.encodings=[{}];',
    '    if(p.encodings.length>1)return; /* (redundant safety) handled by isSimulcastSender below */',
    '    if(isSimulcastSender(s))return;', // simulcast (rid-aware) — preserve per-layer bitrates
    '    var enc=p.encodings[0];var changed=false;',
    '    if(enc.maxBitrate!==FORCED_BPS){enc.maxBitrate=FORCED_BPS;changed=true;}',
    '    if(enc.minBitrate!==FORCED_BPS){enc.minBitrate=FORCED_BPS;changed=true;}',
    '    if(!p.degradationPreference||p.degradationPreference!=="maintain-resolution"){',
    '      p.degradationPreference="maintain-resolution";changed=true;}',
    '    if(changed)s.setParameters(p).catch(function(){});',
    '  });}catch(e){}',
    '}',

    // Force bandwidth in SDP — but skip simulcast m-lines. A single b=AS cap on a
    // simulcast m-line throttles the aggregate across all layers and can starve the
    // high layer; the per-layer encodings already express intent. Chromium marks
    // simulcast sections with `a=simulcast`, so detect on that.
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

    // Wrap RTCPeerConnection
    'window.RTCPeerConnection=function(){',
    '  var args=Array.prototype.slice.call(arguments);',
    '  var pc=new(Function.prototype.bind.apply(OrigPC,[null].concat(args)));',
    '  pcs.push(pc);',
    '  pc.addEventListener("connectionstatechange",function(){',
    '    if(pc.connectionState==="closed"||pc.connectionState==="failed")pcs=pcs.filter(function(p){return p!==pc;});',
    '  });',

    // Wrap setLocalDescription to force bandwidth in SDP
    '  var origSLD=pc.setLocalDescription.bind(pc);',
    '  pc.setLocalDescription=function(desc){',
    '    if(desc&&desc.sdp)desc=Object.assign({},desc,{sdp:forceSdpBandwidth(desc.sdp)});',
    '    return origSLD.call(this,desc);',
    '  };',

    // On track added, force H264 and apply bitrate
    '  pc.addEventListener("track",function(){forceCodec(pc);applyBitrateLimits(pc);});',
    '  var origAddTrack=pc.addTrack.bind(pc);',
    '  pc.addTrack=function(){var r=origAddTrack.apply(this,arguments);forceCodec(pc);applyBitrateLimits(pc);return r;};',

    // Wrap createOffer to force H264 before offer
    '  var origCreateOffer=pc.createOffer.bind(pc);',
    '  pc.createOffer=function(){forceCodec(pc);return origCreateOffer.apply(this,arguments);};',

    '  return pc;',
    '};',
    'window.RTCPeerConnection.prototype=OrigPC.prototype;',
    'Object.keys(OrigPC).forEach(function(k){try{window.RTCPeerConnection[k]=OrigPC[k];}catch(e){}});',

    // Bitrate message handler (override from UI)
    'window.addEventListener("message",function(e){',
    '  if(e.data&&e.data.type==="sharkord-set-video-bitrate"&&typeof e.data.bps==="number"){FORCED_BPS=e.data.bps;pcs.forEach(function(pc){applyBitrateLimits(pc);});}',
    '  if(e.data&&e.data.type==="sharkord-set-video-codec"&&typeof e.data.codec==="string"){FORCED_CODEC=e.data.codec;pcs.forEach(function(pc){forceCodec(pc);});}',
    '});',

    // Stats loop
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

// Inject a hook that drives the SPA's screen-share codec for SIMULCAST.
// The v0.0.23 SPA hardcodes VP8 for simulcast (CB = find VP8). A server-side bundle
// patch now makes the simulcast codec honor the SPA's `screenCodec` device pref
// (same field the single-stream path uses). This injection sets that pref in the
// SPA's persisted Redux store when the desktop codec selector changes, so picking
// H264 yields H264 NVENC hardware simulcast instead of software VP8.
//
// Robustness: the redux-persist localStorage key is randomized per build, so we
// DISCOVER it by scanning localStorage for the entry whose parsed JSON has a
// `devices` field, then patch `devices.screenCodec` in place and dispatch via the
// exposed store. Falls back gracefully if the store/key is unavailable.
function getSimulcastCodecInjectionCode(): string {
  return [
    '(function(){if(window.__sharkordSimulcastCodecHooked)return;window.__sharkordSimulcastCodecHooked=true;',
    // short codec name (desktop UI) -> SPA Hi.* mimeType value
    'var MIME={auto:"auto",h264:"video/H264",vp8:"video/VP8",vp9:"video/VP9",av1:"video/AV1",h265:"video/H265"};',
    'function mimeFor(name){if(!name)return undefined;var n=String(name).toLowerCase();return MIME[n]||("video/"+name);}',
    // The SPA persists device settings (including screenCodec + simulcastEnabled) to a
    // STABLE localStorage key: "sharkord-devices-settings". The JSON has the device
    // fields at the TOP LEVEL (no `devices` wrapper). Patch screenCodec there. The SPA's
    // DevicesProvider reads localStorage only in its useState initializer (on mount),
    // so to make a mid-session codec change take effect we ALSO reload the SPA iframe
    // after writing — the provider rehydrates the new screenCodec on next mount.
    'function setScreenCodecInStorage(mime){var keys=["sharkord-devices-settings"];for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(!k||keys.indexOf(k)!==-1)continue;var v=localStorage.getItem(k);if(!v)continue;try{var o=JSON.parse(v);if(o&&typeof o==="object"&&o.devices&&typeof o.devices==="object")keys.push(k);}catch(e){}}for(var ki=0;ki<keys.length;ki++){var key=keys[ki];try{var raw=localStorage.getItem(key);if(!raw)continue;var o2=JSON.parse(raw);if(o2&&typeof o2==="object"){if(o2.devices){o2.devices=Object.assign({},o2.devices,{screenCodec:mime});}else{o2.screenCodec=mime;}localStorage.setItem(key,JSON.stringify(o2));return true;}}catch(e){}}return false;}',
    // read the LIVE screenCodec from the React DevicesProvider context (fiber walk)
    'function liveScreenCodec(){try{var r=document.getElementById("root");if(!r)return null;var key=Object.keys(r).find(function(k){return k.startsWith("__reactContainer$")||k.startsWith("__reactFiber$");});var f=r[key]&&(r[key].current||r[key]);var hit=null;function w(n,d){if(!n||d>300||hit)return;var p=n.memoizedProps;if(p&&typeof p==="object"&&p.value&&typeof p.value==="object"){var v=p.value;if("screenCodec" in v){hit=v.screenCodec;return;}if(v.devices&&"screenCodec" in v.devices){hit=v.devices.screenCodec;return;}}w(n.child,d+1);w(n.sibling,d+1);}w(f,0);return hit;}catch(e){return null;}}',
    // reload the SPA document so DevicesProvider rehydrates the new screenCodec
    'function reloadSpa(){try{window.location.reload();}catch(e){}}',
    'function applyCodec(name){var m=mimeFor(name);if(!m)return;var live=liveScreenCodec();var wrote=setScreenCodecInStorage(m);console.log("[Sharkov] set simulcast screenCodec="+m+" (live="+live+", wrote="+wrote+")");if(wrote&&live!==m){console.log("[Sharkov] reloading SPA to rehydrate screenCodec="+m);reloadSpa();}}',
    // desktop codec selector messages drive this
    'window.addEventListener("message",function(e){if(!e.data||e.data.type!=="sharkord-set-video-codec")return;applyCodec(e.data.codec);});',
    '})();'
  ].join('');
}

function injectDevicePrefsIntoFrame(frame: { url: string; executeJavaScript: (code: string) => Promise<unknown> }): void {
  const url = frame.url;
  if (!url || url.startsWith('file:')) return;
  try {
    frame.executeJavaScript(getDevicePrefsInjectionCode()).catch(() => {});
    frame.executeJavaScript(getClipboardCopyInjectionCode()).catch(() => {});
    frame.executeJavaScript(getMuteStreamsInjectionCode()).catch(() => {});
    frame.executeJavaScript(getWebrtcStatsInjectionCode()).catch(() => {});
    frame.executeJavaScript(getSimulcastCodecInjectionCode()).catch(() => {});
    frame.executeJavaScript(getCredentialCaptureInjectionCode()).catch(() => {});
    frame.executeJavaScript(getAutoLoginInjectionCode()).catch(() => {});
  } catch {
    /* ignore */
  }
}

function injectDevicePrefsIntoFrames(): void {
  if (!mainWindow?.webContents || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const mainFrame = wc.mainFrame as {
    url: string;
    frames?: { url: string; executeJavaScript: (code: string) => Promise<unknown> }[];
    framesInSubtree?: { url: string; executeJavaScript: (code: string) => Promise<unknown> }[];
  };
  const frames = mainFrame.framesInSubtree ?? [mainFrame, ...(mainFrame.frames ?? [])];
  for (const frame of frames) {
    injectDevicePrefsIntoFrame(frame as { url: string; executeJavaScript: (code: string) => Promise<unknown> });
  }
}

let pttPressed = false;
/** Stop function for Windows background PTT poll (GetAsyncKeyState). */
let pttBackgroundStop: (() => void) | null = null;

function setPttPressed(pressed: boolean): void {
  pttPressed = pressed;
}

function registerPttGlobalShortcut(): void {
  /* No-op; background PTT is started on window blur (Windows only). */
}

function unregisterPttGlobalShortcut(): void {
  if (pttBackgroundStop) {
    pttBackgroundStop();
    pttBackgroundStop = null;
  }
}

function startPttBackgroundPollIfWindows(): void {
  if (process.platform !== 'win32' || !mainWindow) return;
  if (pttBackgroundStop) return; // already running
  const prefs = getDevicePreferences();
  const binding = prefs.pttBinding;
  if (!binding) return;
  import('./pttBackgroundPoller.js').then((m) => {
    const vk = m.pttBindingToVk(binding);
    if (vk == null) return;
    pttBackgroundStop = m.startPttBackgroundPoll(vk, (pressed: boolean) => {
      setPttPressed(pressed);
      applyPttStateToFrames();
    });
  }).catch(() => {});
}

function stopPttBackgroundPoll(): void {
  if (pttBackgroundStop) {
    pttBackgroundStop();
    pttBackgroundStop = null;
  }
}

function applyPttStateToFrames(): void {
  if (!mainWindow?.webContents || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const mainFrame = wc.mainFrame as {
    url: string;
    frames?: { url: string; executeJavaScript: (code: string) => Promise<unknown> }[];
    framesInSubtree?: { url: string; executeJavaScript: (code: string) => Promise<unknown> }[];
  };
  const frames = mainFrame.framesInSubtree ?? [mainFrame, ...(mainFrame.frames ?? [])];
  const code = `(function(p){window.__sharkordPttAudioTracks&&window.__sharkordPttAudioTracks.forEach(function(t){t.enabled=p;});})(${pttPressed});`;
  for (const frame of frames) {
    try {
      const url = (frame as { url?: string }).url;
      if (url && !url.startsWith('file:')) {
        (frame as { executeJavaScript: (c: string) => Promise<unknown> }).executeJavaScript(code).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
}

function setupMediaPermissions(): void {
  const ses = session.defaultSession;

  // Allow camera and microphone (getUserMedia)
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Allow screen/window capture (getDisplayMedia); show picker so user can choose
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } }).then((sources) => {
      if (sources.length === 0) {
        try { callback({}); } catch {}
        return;
      }

      const pickerWin = new BrowserWindow({
        width: 680,
        height: 480,
        resizable: true,
        title: 'Share your screen',
        parent: mainWindow ?? undefined,
        modal: true,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      pickerWin.setMenuBarVisibility(false);

      const pickerSources = sources.map(s => {
        let pid = 0;
        const match = s.id.match(/^window:(\d+):/);
        if (match) pid = getWindowPid(parseInt(match[1], 10));
        return { id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), pid };
      });

      pickerWin.loadFile(path.join(__dirname, '..', 'static', 'screen-picker.html'));
      pickerWin.webContents.on('did-finish-load', () => {
        pickerWin.webContents.send('screen-picker-sources', pickerSources);
      });

      const onSelected = (_event: Electron.Event, selectedId: string | null, audioPid: number) => {
        pickerWin.close();
        if (!selectedId) { try { callback({}); } catch {} return; }
        const chosen = sources.find(s => s.id === selectedId);
        if (!chosen) { try { callback({}); } catch {} return; }

        if (audioPid === -1) {
          // No audio mode — clear PID flag and return video-only stream
          const clearCode = 'window.__sharkordProcessAudioPid=0;';
          const wc = mainWindow?.webContents;
          if (wc && !mainWindow!.isDestroyed()) {
            const mainFrame = wc.mainFrame as {
              framesInSubtree?: { url: string; executeJavaScript: (c: string) => Promise<unknown> }[];
              frames?: { url: string; executeJavaScript: (c: string) => Promise<unknown> }[];
            };
            const frames = mainFrame.framesInSubtree ?? mainFrame.frames ?? [];
            frames.filter(f => f.url && !f.url.startsWith('file:')).forEach(f => f.executeJavaScript(clearCode).catch(() => {}));
          }
          callback({ video: chosen });
        } else if (audioPid && audioPid > 0 && processAudio.isAvailable()) {
          // Inject PID into frames, then resolve with video-only (audio via native capture)
          const pidCode = 'window.__sharkordProcessAudioPid=' + audioPid + ';';
          const wc = mainWindow?.webContents;
          if (wc && !mainWindow!.isDestroyed()) {
            const mainFrame = wc.mainFrame as {
              framesInSubtree?: { url: string; executeJavaScript: (c: string) => Promise<unknown> }[];
              frames?: { url: string; executeJavaScript: (c: string) => Promise<unknown> }[];
            };
            const frames = mainFrame.framesInSubtree ?? mainFrame.frames ?? [];
            const promises = frames
              .filter(f => f.url && !f.url.startsWith('file:'))
              .map(f => f.executeJavaScript(pidCode).catch(() => {}));
            Promise.all(promises).then(() => callback({ video: chosen }), () => callback({ video: chosen }));
          } else {
            callback({ video: chosen });
          }
        } else {
          // Clear PID flag, use system loopback audio
          const clearCode = 'window.__sharkordProcessAudioPid=0;';
          const wc = mainWindow?.webContents;
          if (wc && !mainWindow!.isDestroyed()) {
            const mainFrame = wc.mainFrame as {
              framesInSubtree?: { url: string; executeJavaScript: (c: string) => Promise<unknown> }[];
              frames?: { url: string; executeJavaScript: (c: string) => Promise<unknown> }[];
            };
            const frames = mainFrame.framesInSubtree ?? mainFrame.frames ?? [];
            frames.filter(f => f.url && !f.url.startsWith('file:')).forEach(f => f.executeJavaScript(clearCode).catch(() => {}));
          }
          callback({ video: chosen, audio: 'loopback' });
        }
      };
      ipcMain.once('screen-picker-selected', onSelected);
      pickerWin.on('closed', () => {
        ipcMain.removeListener('screen-picker-selected', onSelected);
      });
    }).catch(() => {
      try { callback({}); } catch {}
    });
  });
}

function clearAllSavedServers(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('open-clear-servers-modal');
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Sharkov Desktop',
      submenu: [
        {
          label: 'About Sharkov Desktop',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-about-modal');
            }
          }
        },
        { type: 'separator' as const },
        {
          label: 'Server URL…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-add-server-modal');
            }
          }
        },
        {
          label: 'Clear all saved servers…',
          click: () => clearAllSavedServers()
        },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        {
          label: 'Enter admin token…',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-admin-token-dialog');
            }
          }
        },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(process.platform === 'darwin' ? [{ role: 'close' as const }] : [])
      ]
    }
  ]);
}

// Enable hardware video encoding for WebRTC (NVENC, AMF, QSV)
// - MediaFoundationAV1Encoding / WebRtcAV1HWEncode: expose NVENC AV1 hardware encode to WebRTC (disabled by default on Windows)
// - PlatformHEVCEncoderSupport: allow H.265/HEVC encode (NVENC HEVC)
app.commandLine.appendSwitch('enable-features',
  'PlatformHEVCEncoderSupport,MediaFoundationVideoCapture,MediaFoundationAV1Encoding,WebRtcAV1HWEncode,WebRtcH264WithOpenH264FFmpeg,VaapiVideoEncoder,VaapiVideoDecoder');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-fieldtrials',
  'WebRTC-H264-SpsPpsIdrIsH264Keyframe/Enabled/' +
  'WebRTC-Video-Pacing/Enabled/'
);

// ---- Self-test mode (no server, no UI interaction) ------------------------------------
// Loopback mode:  electron . --selftest [--selftest-out=...]
// Live mode:      electron . --selftest-live --selftest-token=<path-to-JWT-file> \
//                 [--selftest-host=sharkord.thesemite.com] [--selftest-channel=5] \
//                 [--selftest-codec=VP8] [--selftest-kind=screen] [--selftest-simulcast=1]
//                 [--selftest-out=...]
// Loopback opens a tiny window and runs local WebRTC loopbacks per codec (single +
// 3-layer simulcast) to verify hardware encoding without a server. Live mode connects
// to a real sharkord mediasoup server over tRPC/WebSocket, joins a voice channel,
// produces a (simulcast) stream, and samples getStats() to prove end-to-end simulcast
// + hardware. Both modes write a JSON report and quit — no human interaction.
function runSelfTest(): void {
  const live = app.commandLine.hasSwitch('selftest-live');
  const outPath = app.commandLine.getSwitchValue('selftest-out') ||
    path.join(app.getPath('userData'), live ? 'live-selftest-report.json' : 'codec-selftest-report.json');
  process.stdout.write(`[selftest] mode=${live ? 'live' : 'loopback'} writing report to ${outPath}\n`);

  // Build the query string for live mode. The JWT is read from the token file here
  // (main process) and passed via the URL so the renderer never touches the filesystem.
  let token = '';
  if (live) {
    const tokenPath = app.commandLine.getSwitchValue('selftest-token');
    if (tokenPath) {
      try { token = readFileSync(tokenPath, 'utf8').trim(); }
      catch (err) { process.stdout.write(`[selftest] failed to read token file: ${err}\n`); }
    }
    if (!token) {
      process.stdout.write('[selftest] live mode requires --selftest-token=<path>\n');
      app.quit(); return;
    }
  }
  const query: Record<string, string> = {};
  if (live) {
    query['mode'] = 'live';
    query['token'] = token;
    query['host'] = app.commandLine.getSwitchValue('selftest-host') || 'sharkord.thesemite.com';
    query['channel'] = app.commandLine.getSwitchValue('selftest-channel') || '5';
    query['codec'] = app.commandLine.getSwitchValue('selftest-codec') || 'VP8';
    query['kind'] = app.commandLine.getSwitchValue('selftest-kind') || 'screen';
    query['simulcast'] = app.commandLine.getSwitchValue('selftest-simulcast') || '1';
    query['svc'] = app.commandLine.getSwitchValue('selftest-svc') || '';
    query['sampleMs'] = app.commandLine.getSwitchValue('selftest-sample-ms') || '15000';
  }

  const win = new BrowserWindow({
    width: 600, height: 560, show: true, title: live ? 'Sharkov Live Self-Test' : 'Sharkov Codec Self-Test',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'static', 'selftest.html'), { query });

  // Relay renderer console to stdout for live visibility.
  win.webContents.on('console-message', (_e, ...args: unknown[]) => {
    const msg = args.length >= 2 ? (args[1] as string) : ((args[0] as { message?: string })?.message ?? String(args[0]));
    process.stdout.write(`[selftest] ${msg}\n`);
  });

  ipcMain.once('selftest-report', (_e, report: unknown) => {
    try {
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(report, null, 2));
      process.stdout.write(`[selftest] report written to ${outPath}\n`);
    } catch (err) {
      process.stdout.write(`[selftest] failed to write report: ${err}\n`);
    }
    try { win.close(); } catch {}
    app.quit();
  });
}

app.whenReady().then(async () => {
  if (app.commandLine.hasSwitch('selftest') || app.commandLine.hasSwitch('selftest-live')) { runSelfTest(); return; }
  const StoreImpl = (await import('electron-store')).default;
  store = new StoreImpl<{ serverUrl: string; savedServers: string }>({
    defaults: { serverUrl: 'https://demo.sharkord.com', savedServers: '[]' }
  }) as unknown as StoreType;

  // Identify the desktop in the User-Agent so the server's existing login
  // log (logins.userAgent column, surfaced in the admin user-info panel)
  // records the running app version per user. The sharkord server already
  // parses and persists req.headers['user-agent'] on every WS join.
  // Prepend a prominent, stable token; keep the original UA tail so the
  // server's UAParser can still extract os/device for the admin panel.
  app.userAgentFallback = `Sharkov-Desktop/${app.getVersion()} ${app.userAgentFallback}`;

  setupMediaPermissions();
  Menu.setApplicationMenu(buildMenu());
  createMainWindow();
  registerPttGlobalShortcut();

  // Auto-update (only works with NSIS installer, not portable exe)
  const autoUpdater = new NsisUpdater({
    provider: 'github',
    owner: 'daelsc',
    repo: 'sharkov-desktop'
  });
  autoUpdater.allowDowngrade = false;
  (autoUpdater as unknown as { verifyUpdateCodeSignature: unknown }).verifyUpdateCodeSignature = () => Promise.resolve(null);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (msg: unknown) => appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[INFO] ${msg}\n`),
    warn: (msg: unknown) => appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[WARN] ${msg}\n`),
    error: (msg: unknown) => appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[ERROR] ${msg}\n`),
    debug: (msg: unknown) => appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[DEBUG] ${msg}\n`),
  } as unknown as typeof autoUpdater.logger;
  autoUpdater.on('checking-for-update', () => {
    appendFileSync(path.join(app.getPath('userData'), 'updater.log'), '[EVENT] checking-for-update\n');
  });
  autoUpdater.on('update-available', (info) => {
    appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[EVENT] update-available: ${JSON.stringify(info)}\n`);
  });
  autoUpdater.on('update-not-available', (info) => {
    appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[EVENT] update-not-available: ${JSON.stringify(info)}\n`);
  });
  autoUpdater.on('error', (err) => {
    appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[EVENT] error: ${err}\n`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[EVENT] update-downloaded: ${JSON.stringify(info)}\n`);
    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded. It will be installed when you quit the app.`,
      buttons: ['Restart Now', 'Later']
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });
  autoUpdater.checkForUpdates().catch((err) => {
    appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `[CATCH] checkForUpdates failed: ${err}\n`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  unregisterPttGlobalShortcut();
});

// IPC handlers for preload
ipcMain.handle('copy-to-clipboard', (_event, text: string) => {
  if (typeof text === 'string') clipboard.writeText(text);
});
ipcMain.handle('get-server-url', () => getServerUrl());

ipcMain.handle('set-server-url', (_event, url: string) => {
  if (!store) return;
  const normalized = (url || '').trim();
  const withProtocol =
    !normalized || normalized.startsWith('http://') || normalized.startsWith('https://')
      ? normalized
      : `https://${normalized}`;
  store.set('serverUrl', withProtocol || DEFAULT_SERVER_URL);
  const finalUrl = getServerUrl();
  if (mainWindow && mainWindow.webContents.getURL().startsWith('file:')) {
    mainWindow.webContents.send('wrapper-navigate', finalUrl);
  } else {
    mainWindow?.loadURL(finalUrl);
  }
});
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-build-id', () => getBuildId());
ipcMain.handle('get-video-bitrate', () => getDevicePreferences().videoBitrate || 0);
ipcMain.handle('set-video-bitrate', (_event, kbps: number) => {
  if (!store) return;
  const prefs = getDevicePreferences();
  prefs.videoBitrate = kbps;
  store.set(DEVICE_PREFS_KEY, JSON.stringify(prefs));
});
ipcMain.handle('get-video-codec', () => getDevicePreferences().videoCodec || 'H264');
ipcMain.handle('set-video-codec', (_event, codec: string) => {
  if (!store) return;
  const prefs = getDevicePreferences();
  prefs.videoCodec = codec;
  store.set(DEVICE_PREFS_KEY, JSON.stringify(prefs));
});

const rtcLogPath = path.join(app.getPath('userData'), 'rtc-stats.log');
let rtcLogStream: import('fs').WriteStream | null = null;
function getRtcLogStream() {
  if (!rtcLogStream) {
    rtcLogStream = require('fs').createWriteStream(rtcLogPath, { flags: 'a' });
    rtcLogStream!.write(`\n--- Session started ${new Date().toISOString()} ---\n`);
  }
  return rtcLogStream!;
}
ipcMain.handle('log-rtc-stats', (_event, report: unknown) => {
  const ts = new Date().toISOString();
  getRtcLogStream().write(ts + ' ' + JSON.stringify(report) + '\n');
});

ipcMain.handle('confirm-clear-servers', async () => {
  if (!store) return;
  const origins = getSavedServers()
    .map(s => { try { return new URL(s.url).origin; } catch { return null; } })
    .filter((o): o is string => !!o && o !== 'null');
  store.set(SAVED_SERVERS_KEY, '[]');
  store.set('serverUrl', DEFAULT_SERVER_URL);
  await Promise.all(
    origins.map(origin =>
      session.defaultSession.clearStorageData({ storages: ['localstorage'], origin })
    )
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.reload();
  }
});

ipcMain.handle('focus-active-client-frame', (_event, activeFrameUrl?: string) => {
  if (!mainWindow?.webContents || mainWindow.isDestroyed()) return;
  mainWindow.focus();
  const wc = mainWindow.webContents;
  wc.executeJavaScript(
    `(function(){var f=document.querySelector('.client-frame.active');if(f){f.setAttribute('tabindex','0');f.focus();}})();`
  ).catch(() => {});
  if (activeFrameUrl) {
    const mainFrame = wc.mainFrame as {
      frames?: { url: string; executeJavaScript: (code: string) => Promise<unknown> }[];
      framesInSubtree?: { url: string; executeJavaScript: (code: string) => Promise<unknown> }[];
    };
    const frames = mainFrame?.framesInSubtree ?? mainFrame?.frames ?? [];
    const targetUrl = activeFrameUrl.startsWith('http') ? activeFrameUrl : `https://${activeFrameUrl}`;
    let targetOrigin: string;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      targetOrigin = targetUrl;
    }
    for (const frame of frames) {
      const url = (frame as { url?: string }).url || '';
      try {
        const frameOrigin = new URL(url).origin;
        if (frameOrigin === targetOrigin || url === targetUrl || url.startsWith(targetUrl)) {
          (frame as { executeJavaScript: (c: string) => Promise<unknown> })
            .executeJavaScript('window.focus();')
            .catch(() => {});
          break;
        }
      } catch {
        if (url === targetUrl || url.startsWith(targetUrl)) {
          (frame as { executeJavaScript: (c: string) => Promise<unknown> })
            .executeJavaScript('window.focus();')
            .catch(() => {});
          break;
        }
      }
    }
  }
});

ipcMain.handle('reload-for-reconnect', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
});

// Saved servers (for server picker panel)
ipcMain.handle('desktop-get-servers', () => getSavedServers());

ipcMain.handle('desktop-add-server', (_event, server: { url: string; name: string }) => {
  const list = getSavedServers();
  const url = (server.url || '').trim();
  const withProtocol =
    url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
  if (list.some((s) => s.url === withProtocol)) return list;
  const newServer: SavedServer = {
    id: crypto.randomUUID(),
    url: withProtocol,
    name: (server.name || '').trim() || new URL(withProtocol).hostname
  };
  setSavedServers([...list, newServer]);
  return getSavedServers();
});

ipcMain.handle('desktop-remove-server', (_event, id: string) => {
  const list = getSavedServers();
  const removed = list.find((s) => s.id === id);
  if (removed) {
    try {
      const origin = new URL(removed.url).origin;
      setSavedServers(clearCredentials(list, origin).filter((s) => s.id !== id));
    } catch {
      setSavedServers(list.filter((s) => s.id !== id));
    }
  } else {
    setSavedServers(list);
  }
});

ipcMain.handle('desktop-update-server', (_event, id: string, updates: Partial<SavedServer>) => {
  const list = getSavedServers();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return list;
  const next = [...list];
  next[idx] = { ...next[idx], ...updates };
  setSavedServers(next);
  return getSavedServers();
});

ipcMain.handle('desktop-reorder-servers', (_event, orderedIds: string[]) => {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return getSavedServers();
  const list = getSavedServers();
  const byId = new Map(list.map((s) => [s.id, s]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as SavedServer[];
  const remaining = list.filter((s) => !orderedIds.includes(s.id));
  setSavedServers([...reordered, ...remaining]);
  return getSavedServers();
});

ipcMain.handle('desktop-get-credentials-for-origin', (_event, origin: string) => {
  const crypto = getCredentialCrypto();
  if (!crypto) return null;
  return loadCredentials(getSavedServers(), crypto, origin);
});

ipcMain.handle('desktop-set-credentials', (_event, origin: string, identity: string, password: string) => {
  const crypto = getCredentialCrypto();
  if (!store || !crypto) return; // refuse to store without OS-keyring encryption
  setSavedServers(saveCredentials(getSavedServers(), crypto, origin, identity, password));
});

ipcMain.handle('desktop-clear-credentials', (_event, origin: string) => {
  if (!store) return;
  setSavedServers(clearCredentials(getSavedServers(), origin));
});

ipcMain.handle('desktop-navigate-to-server', (_event, url: string) => {
  if (mainWindow && url) {
    const u = url.startsWith('http') ? url : `https://${url}`;
    mainWindow.loadURL(u);
  }
});

ipcMain.handle('submit-admin-token', async (_event, token: string, activeServerId: string | null) => {
  if (!mainWindow?.webContents || mainWindow.isDestroyed()) return;
  const trimmed = (token ?? '').trim();
  if (!trimmed) return;
  const servers = getSavedServers();
  let targetOrigin: string | null = null;
  if (activeServerId) {
    const server = servers.find((s) => s.id === activeServerId);
    if (server) {
      try {
        targetOrigin = new URL(server.url).origin;
      } catch {
        /* ignore */
      }
    }
  }
  const wc = mainWindow.webContents;
  const mainFrame = wc.mainFrame;
  const frames = (mainFrame as { frames?: { url: string; executeJavaScript: (code: string) => Promise<unknown> }[] }).frames ?? [];
  let frameToRun = frames.find((f) => {
    try {
      const origin = new URL(f.url).origin;
      return targetOrigin ? origin === targetOrigin : true;
    } catch {
      return false;
    }
  });
  if (!frameToRun && frames.length > 0) {
    frameToRun = frames[0];
  }
  if (frameToRun) {
    const code = `typeof window.useToken === 'function' && window.useToken(${JSON.stringify(trimmed)});`;
    await frameToRun.executeJavaScript(code).catch(() => {});
  }
});

ipcMain.handle('get-device-preferences', () => getDevicePreferences());

ipcMain.handle('set-device-preferences', (_event, prefs: DevicePreferences) => {
  setDevicePreferences(prefs ?? {});
  injectDevicePrefsIntoFrames();
  registerPttGlobalShortcut();
});

ipcMain.handle('request-apply-device-preferences', () => {
  injectDevicePrefsIntoFrames();
  registerPttGlobalShortcut();
});

ipcMain.handle('ptt-state', (_event, pressed: boolean) => {
  setPttPressed(!!pressed);
  applyPttStateToFrames();
});

ipcMain.handle('fetch-communities-database', async (_event, url: string) => {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) return null;
  try {
    const res = await fetch(u, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
});

const COMMUNITIES_HTML_URL = 'https://raw.githubusercontent.com/Bugel/sharkordserverdb/main/communities.html';
const COMMUNITIES_JSON_URL = 'https://raw.githubusercontent.com/Bugel/sharkordserverdb/main/communities.json';

function getCommunitiesCacheDir(): string {
  return path.join(app.getPath('userData'), 'communities-cache');
}

function ensureCommunitiesCacheDir(): void {
  const dir = getCommunitiesCacheDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function downloadCommunitiesFiles(): Promise<boolean> {
  ensureCommunitiesCacheDir();
  const dir = getCommunitiesCacheDir();
  const htmlPath = path.join(dir, 'communities.html');
  const jsonPath = path.join(dir, 'communities.json');
  const fallbackHtmlPath = path.join(__dirname, '..', 'static', 'communities', 'communities-for-github.html');

  try {
    const jsonRes = await fetch(COMMUNITIES_JSON_URL, { cache: 'no-store' });
    if (!jsonRes.ok) return false;
    const jsonText = await jsonRes.text();
    writeFileSync(jsonPath, jsonText, 'utf-8');
  } catch {
    return false;
  }

  try {
    const htmlRes = await fetch(COMMUNITIES_HTML_URL, { cache: 'no-store' });
    if (htmlRes.ok) {
      const htmlText = await htmlRes.text();
      writeFileSync(htmlPath, htmlText, 'utf-8');
    } else {
      if (existsSync(fallbackHtmlPath)) {
        writeFileSync(htmlPath, readFileSync(fallbackHtmlPath, 'utf-8'), 'utf-8');
      } else {
        return false;
      }
    }
  } catch {
    if (existsSync(fallbackHtmlPath)) {
      writeFileSync(htmlPath, readFileSync(fallbackHtmlPath, 'utf-8'), 'utf-8');
    } else {
      return false;
    }
  }
  writeFileSync(path.join(dir, 'last-refreshed.txt'), new Date().toISOString(), 'utf-8');
  return true;
}

ipcMain.handle('get-communities-page-url', async () => {
  const dir = getCommunitiesCacheDir();
  const htmlPath = path.join(dir, 'communities.html');
  if (!existsSync(htmlPath)) {
    const ok = await downloadCommunitiesFiles();
    if (!ok) return null;
  }
  return pathToFileURL(htmlPath).href;
});

ipcMain.handle('refresh-communities-cache', async () => {
  const dir = getCommunitiesCacheDir();
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  } catch {}
  return downloadCommunitiesFiles();
});

// Per-process audio capture IPC handlers
ipcMain.handle('process-audio-available', () => processAudio.isAvailable());

ipcMain.handle('list-audio-sessions', () => processAudio.listAudioSessions());

ipcMain.handle('start-process-audio-capture', (_event, pid: number) => {
  if (!processAudio.isAvailable()) return { ok: false, error: 'not available' };
  try {
    processAudio.startCapture(pid, (buf: Float32Array) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('process-audio-chunk', buf.buffer);
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('stop-process-audio-capture', () => {
  processAudio.stopCapture();
  return { ok: true };
});
