// Sharkov BITRATE self-test — E2E test of the REAL webrtc-stats injection's bitrate
// cap for simulcast. Loads the actual built injection from dist/main.js, produces
// an H264 simulcast stream, then drives it via the real `sharkord-set-video-bitrate`
// postMessage (exactly what the wrapper sends) and verifies the high layer's
// maxBitrate changes live via setParameters. No user interaction.
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createTRPCProxyClient, wsLink, createWSClient } = require('@trpc/client');
const mediasoupClient = require('mediasoup-client');

const qs = new URLSearchParams(location.search);
const CFG = {
  host: qs.get('host') || 'sharkord.thesemite.com',
  token: qs.get('token') || '',
  channel: parseInt(qs.get('channel') || '4', 10),
  codec: (qs.get('codec') || 'H264').toUpperCase()
};
const logEl = document.getElementById('log');
function out(msg) { console.log(msg); if (logEl) { const d = document.createElement('div'); d.textContent = msg; logEl.appendChild(d); } }
out('CFG: ' + JSON.stringify({ ...CFG, token: CFG.token ? '<c>' : '<none>' }));

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let frame = 0;
function draw() { frame++; const g = ctx.createLinearGradient(0,0,canvas.width,canvas.height); g.addColorStop((Math.sin(frame/30)+1)/2,'#0a0a0a'); g.addColorStop((Math.cos(frame/45)+1)/2,'#1e3a5f'); ctx.fillStyle=g; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle='#a1e6a1'; ctx.font='64px Consolas'; ctx.fillText('BITRATE ' + frame, 60+(frame%200), 360+Math.sin(frame/10)*120); requestAnimationFrame(draw); }
draw();
function wait(ms){return new Promise(r=>setTimeout(r,ms));}

// ---- extract + load the REAL webrtc-stats injection from dist/main.js ----
function loadRealInjection() {
  // Load the real builder module (compiled to dist/webrtcStatsInjection.js by tsc)
  // and the real device-prefs reader, then build the injection exactly as the app does.
  // This replaces the old brace-scraping of dist/main.js, which broke once main.ts
  // delegates to the module (the scraped code could not resolve the import binding).
  const distDir = path.join(__dirname, '..', 'dist');
  let builderMod, prefsSrc;
  try {
    // In the renderer (nodeIntegration), require resolves dist modules.
    builderMod = require(path.join(distDir, 'webrtcStatsInjection.js'));
  } catch (e) {
    // Fallback: build dist in-memory by transpiling the TS source is not available
    // without tsc; instead read the compiled JS and eval it as a module.
    const fs2 = require('fs');
    const code = fs2.readFileSync(path.join(distDir, 'webrtcStatsInjection.js'), 'utf8');
    const m = { exports: {} };
    (new Function('module', 'exports', 'require', code))(m, m.exports, require);
    builderMod = m.exports;
  }
  // Read getDevicePreferences from dist/main.js via brace scrape (still works: it's
  // a self-contained function reading the module-level store).
  const distPath = path.join(distDir, 'main.js');
  const src = fs.readFileSync(distPath, 'utf8');
  function ex(n){const s=src.indexOf('function '+n+'(');let b=src.indexOf('{',s);let d=0,e=b;for(;e<src.length;e++){if(src[e]==='{')d++;else if(src[e]==='}'){d--;if(d===0)break;}}return src.slice(s,e+1);}
  const g = ex('getDevicePreferences');
  const ctx2 = { store: null, DEVICE_PREFS_KEY: 'x', getDevicePreferences: null, getWebrtcStatsInjectionCode: null, buildWebrtcStatsInjection: builderMod.buildWebrtcStatsInjection };
  vm.createContext(ctx2); vm.runInContext(g + '\n' + 'getWebrtcStatsInjectionCode = function(){ var prefs = getDevicePreferences(); var forcedBps = (prefs.videoBitrate && prefs.videoBitrate>0) ? prefs.videoBitrate*1000 : 0; var forcedCodec = prefs.videoCodec || "H264"; return buildWebrtcStatsInjection({forcedBps: forcedBps, forcedCodec: forcedCodec}); }' + '\n', ctx2);
  const code = ctx2.getWebrtcStatsInjectionCode();
  out('loaded real injection via module (len=' + code.length + ')');
  // eval it in THIS window so it wraps RTCPeerConnection + installs the message handler
  (0, eval)(code);
  out('injection installed: statsHook=' + !!window.__sharkordRtcStatsHooked);
  return !!window.__sharkordRtcStatsHooked;
}

// ---- diagnostic capture (separate from the injection's own capture) ----
const capturedPcs = [];
function findSimulcastPc() {
  for (var i = 0; i < capturedPcs.length; i++) {
    var pc = capturedPcs[i];
    try {
      if (pc.connectionState === 'closed') continue;
      var senders = pc.getSenders();
      for (var j = 0; j < senders.length; j++) {
        var s = senders[j];
        if (!s.track || s.track.kind !== 'video') continue;
        var p = s.getParameters();
        if (p && p.encodings && p.encodings.length > 1) return pc;
      }
    } catch (e) {}
  }
  return null;
}
function readHighLayerMaxBitrate(pc) {
  var senders = pc.getSenders();
  for (var i = 0; i < senders.length; i++) {
    var s = senders[i];
    if (!s.track || s.track.kind !== 'video') continue;
    var p = s.getParameters();
    if (!p.encodings || p.encodings.length <= 1) continue;
    var high = p.encodings[p.encodings.length - 1];
    for (var j = 0; j < p.encodings.length; j++) { if (p.encodings[j].scaleResolutionDownBy === 1) high = p.encodings[j]; }
    return { maxBitrate: high.maxBitrate, rid: high.rid, scale: high.scaleResolutionDownBy, nEnc: p.encodings.length };
  }
  return null;
}

(async () => {
  const report = { timestamp: new Date().toISOString(), cfg: CFG, steps: [], pass: false };
  try {
    // 1. load the REAL injection (wraps RTCPeerConnection + message handler)
    const injOk = loadRealInjection();
    if (!injOk) throw new Error('real injection did not install');
    // diagnostics: tap message dispatch + injection stats loop (proves pcs non-empty)
    window.__msgCount = 0;
    window.addEventListener('message', function(e){ if(e.data && e.data.type==='sharkord-set-video-bitrate') window.__msgCount++; });
    window.__statsCount = 0;
    window.addEventListener('message', function(e){ if(e.data && e.data.type==='sharkord-rtc-stats') window.__statsCount++; });
    // 2. now wrap RTCPeerConnection AGAIN (on top of the injection's wrap) to capture
    //    PCs for verification. The injection's wrap runs first; ours wraps it.
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(){ const pc = new (Function.prototype.bind.apply(OrigPC,[null].concat(Array.from(arguments)))); capturedPcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = OrigPC.prototype;

    // 3. connect + produce an H264 simulcast stream
    const closeClient = createWSClient({ url: 'wss://' + CFG.host, connectionParams: async () => ({ token: CFG.token }) });
    const trpc = createTRPCProxyClient({ links: [wsLink({ client: closeClient })] });
    out('connecting tRPC ws -> wss://' + CFG.host);
    const hs = await trpc.others.handshake.query();
    await trpc.others.joinServer.query({ handshakeHash: hs.handshakeHash });
    out('joined -> voice channel ' + CFG.channel);
    const { routerRtpCapabilities } = await trpc.voice.join.mutate({ channelId: CFG.channel, state: {} });
    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities });
    const transportParams = await trpc.voice.createProducerTransport.mutate({});
    const transport = device.createSendTransport(transportParams);
    transport.on('connect', ({ dtlsParameters }, cb, eb) => trpc.voice.connectProducerTransport.mutate({ dtlsParameters }).then(cb).catch(eb));
    transport.on('produce', async ({ rtpParameters, appData }, cb, eb) => {
      try {
        const qualityLayers = [{ spatialLayer: 0, label: 'Low' }, { spatialLayer: 1, label: 'Medium' }, { spatialLayer: 2, label: 'High' }];
        const id = await trpc.voice.produce.mutate({ transportId: transportParams.id, kind: appData.kind || 'screen', rtpParameters, qualityLayers });
        cb({ id });
      } catch (e) { out('produce err: ' + e.message); eb(e); }
    });
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const wantMime = 'video/' + CFG.codec;
    const preferredCodec = (device.rtpCapabilities.codecs || []).find(c => c.mimeType.toLowerCase() === wantMime.toLowerCase());
    out('preferred codec: ' + (preferredCodec ? preferredCodec.mimeType : 'none'));
    const producer = await transport.produce({
      track, codec: preferredCodec,
      appData: { kind: 'screen', qualityLayers: [{ spatialLayer: 0, label: 'Low' }, { spatialLayer: 1, label: 'Medium' }, { spatialLayer: 2, label: 'High' }] },
      encodings: [
        { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 300000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true },
        { rid: 'mid', scaleResolutionDownBy: 2, maxBitrate: 800000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true },
        { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 4000000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true }
      ]
    });
    out('producer id=' + producer.id + ' encodings=' + producer.rtpParameters.encodings.length);
    await wait(2000);
    var pc = findSimulcastPc();
    if (!pc) throw new Error('no simulcast PC found (captured=' + capturedPcs.length + ')');
    out('found simulcast PC, state=' + pc.connectionState);

    // STEP 1: initial high layer (expect 4000000)
    await wait(1000);
    var init = readHighLayerMaxBitrate(pc);
    out('STEP1 initial: ' + JSON.stringify(init));
    report.steps.push({ step: 1, name: 'initial', high: init });

    // STEP 2: drive the REAL message the wrapper sends: 10 Mbps
    window.postMessage({ type: 'sharkord-set-video-bitrate', bps: 10000000 }, '*');
    out('STEP2 posted sharkord-set-video-bitrate 10Mbps (msgCount so far=' + window.__msgCount + ', statsCount=' + window.__statsCount + ')');
    await wait(2500); // injection handler is sync (updates FORCED_BPS + applyBitrateLimits), setParameters async
    var dbg = window.__sharkordInjDebug ? window.__sharkordInjDebug() : null;
    if (dbg) out('STEP2 injection debug: ' + JSON.stringify({FORCED_BPS:dbg.FORCED_BPS, pcs:dbg.pcs}));
    var after2 = readHighLayerMaxBitrate(pc);
    out('STEP2 after 10Mbps: ' + JSON.stringify(after2) + ' (msgCount=' + window.__msgCount + ', statsCount=' + window.__statsCount + ')');
    report.steps.push({ step: 2, name: 'apply-10Mbps', high: after2, msgCount: window.__msgCount, statsCount: window.__statsCount, inj: dbg && {FORCED_BPS:dbg.FORCED_BPS, pcs:dbg.pcs} });

    // STEP 3: Auto (0)
    window.postMessage({ type: 'sharkord-set-video-bitrate', bps: 0 }, '*');
    out('STEP3 posted Auto');
    await wait(2000);
    var after3 = readHighLayerMaxBitrate(pc);
    out('STEP3 after Auto: ' + JSON.stringify(after3));
    report.steps.push({ step: 3, name: 'apply-auto', high: after3 });

    // STEP 4: 6 Mbps
    window.postMessage({ type: 'sharkord-set-video-bitrate', bps: 6000000 }, '*');
    await wait(2000);
    var after4 = readHighLayerMaxBitrate(pc);
    out('STEP4 after 6Mbps: ' + JSON.stringify(after4));
    report.steps.push({ step: 4, name: 'apply-6Mbps', high: after4 });

    // PASS: step2 high.maxBitrate === 10000000 (real injection applied the cap live)
    report.pass = !!(after2 && after2.maxBitrate === 10000000);
    out('=== RESULT === ' + (report.pass ? 'PASS (real injection caps simulcast live)' : 'FAIL'));

    try { await trpc.voice.leave.mutate({}); } catch (e) {}
    try { producer.close(); } catch (e) {}
    closeClient.close();
  } catch (e) {
    out('FATAL: ' + (e && e.message || e));
    report.error = String(e && e.message || e);
    report.stack = e && e.stack;
  }
  out('DONE pass=' + report.pass);
  try { ipcRenderer.send('selftest-report', report); } catch (e) {}
  setTimeout(() => { try { ipcRenderer.send('selftest-report', report); } catch(e){} }, 200);
})();
