// Sharkov LIVE codec self-test — runs in a renderer with nodeIntegration + GPU flags.
// Connects to a real sharkord mediasoup server over tRPC/WebSocket, joins a voice
// channel, produces a simulcast (or single) video stream from a canvas, and samples
// the underlying RTCPeerConnection's getStats() to prove 3-layer simulcast actually
// encodes on all layers + infer hardware via totalEncodeTime-per-frame (this custom
// Electron build does NOT expose outbound-rtp.encoderImplementation).
//
// No clicks, no GUI. Main process passes config via the URL query string and writes
// the JSON report on the 'selftest-report' IPC, then quits.
const { ipcRenderer } = require('electron');
const fs = require('fs');
const { createTRPCProxyClient, wsLink, createWSClient } = require('@trpc/client');
const mediasoupClient = require('mediasoup-client');

const logEl = document.getElementById('log');
function out(msg) {
  console.log(msg);
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- config from query string ----
const qs = new URLSearchParams(location.search);
const CFG = {
  host: qs.get('host') || 'sharkord.thesemite.com',
  token: qs.get('token') || '',
  channel: parseInt(qs.get('channel') || '5', 10),
  codec: (qs.get('codec') || 'VP8').toUpperCase(), // VP8 | AV1 | H264 | H265 | VP9
  kind: qs.get('kind') || 'screen',                // 'video' | 'screen'
  simulcast: (qs.get('simulcast') !== '0'),
  svc: qs.get('svc') || '',                        // e.g. 'L3T3' -> single SVC encoding (AV1/VP9)
  sampleMs: parseInt(qs.get('sampleMs') || '15000', 10)
};
out('CFG: ' + JSON.stringify({ ...CFG, token: CFG.token ? '<' + CFG.token.length + ' chars>' : '<none>' }));

// ---- animated source ----
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let frame = 0;
function draw() {
  frame++;
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop((Math.sin(frame / 30) + 1) / 2, '#0a0a0a');
  g.addColorStop((Math.cos(frame / 45) + 1) / 2, '#1e3a5f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#a1e6a1';
  ctx.font = '64px Consolas, monospace';
  ctx.fillText('SHARKOV-LIVE ' + frame, 60 + (frame % 200), 360 + Math.sin(frame / 10) * 120);
  ctx.strokeStyle = '#e4e4e7';
  ctx.lineWidth = 4;
  ctx.strokeRect(20, 20, 1240, 680);
  requestAnimationFrame(draw);
}
draw();

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- stats parsing (same shape as the loopback self-test) ----
async function gatherOutbound(stats) {
  const outbounds = [];
  stats.forEach((s) => {
    if (s.type !== 'outbound-rtp') return;
    if (s.kind !== 'video' && s.mediaType !== 'video') return;
    let codecName = '';
    if (s.codecId) { const cs = stats.get(s.codecId); if (cs) codecName = cs.mimeType || ''; }
    const framesEncoded = s.framesEncoded || 0;
    const totalEncodeTime = typeof s.totalEncodeTime === 'number' ? s.totalEncodeTime : 0;
    outbounds.push({
      ssrc: s.ssrc, rid: s.rid || null, codec: codecName || s.codecId || '',
      encoderImplementation: s.encoderImplementation || '',
      framesEncoded, framesSent: s.framesSent || 0,
      width: s.frameWidth || 0, height: s.frameHeight || 0,
      fps: s.framesPerSecond || 0, bytesSent: s.bytesSent || 0,
      packetsSent: s.packetsSent || 0, targetBitrate: s.targetBitrate || 0,
      keyFramesEncoded: s.keyFramesEncoded || 0, qpSum: s.qpSum || 0,
      totalEncodeTime, active: s.active, encodingIndex: s.encodingIndex,
      qualityLimitationReason: s.qualityLimitationReason || null,
      msPerFrame: framesEncoded > 0 ? (totalEncodeTime * 1000) / framesEncoded : 0
    });
  });
  return outbounds;
}

function classifyHw(msPerFrame, width, height) {
  // HW NVENC at 720p ~1-2 ms/frame; software encoders 5-15+ at 720p. Per-pixel
  // normalize so smaller simulcast layers compare fairly.
  const px = (width || 1) * (height || 1);
  const usPerPx = msPerFrame ? (msPerFrame * 1000) / px : 0;
  if (usPerPx > 0 && usPerPx < 4) return 'likely-hardware'; // <~2ms at 720p
  if (usPerPx >= 8) return 'likely-software';
  return 'uncertain';
}

async function main() {
  out('Sharkov LIVE self-test starting');
  if (!CFG.token) { throw new Error('no token in query string'); }
  out('webgl2: ' + !!document.createElement('canvas').getContext('webgl2'));

  const report = {
    timestamp: new Date().toISOString(),
    cfg: { ...CFG, token: '<redacted>' },
    server: { host: CFG.host },
    routerCodecs: [],
    layers: []
  };

  // ---- tRPC over WebSocket ----
  out('connecting tRPC ws -> wss://' + CFG.host);
  const wsClient = createWSClient({
    url: 'wss://' + CFG.host,
    connectionParams: async () => ({ token: CFG.token }),
    onClose: (cause) => out('ws closed: ' + cause?.code + ' ' + (cause?.reason || ''))
  });
  const trpc = createTRPCProxyClient({ links: [wsLink({ client: wsClient })] });

  let device, transport, producer;
  try {
    // 1. handshake + joinServer (read publicSettings.webRtcSimulcastEnabled)
    out('-> others.handshake');
    const hs = await trpc.others.handshake.query();
    out('   handshakeHash ok, hasPassword=' + hs.hasPassword);
    out('-> others.joinServer');
    const joined = await trpc.others.joinServer.query({ handshakeHash: hs.handshakeHash });
    report.server.simulcastEnabled = joined.publicSettings?.webRtcSimulcastEnabled;
    report.server.webRtcMaxBitrate = joined.publicSettings?.webRtcMaxBitrate;
    report.server.name = joined.serverName;
    out('   server simulcastEnabled=' + report.server.simulcastEnabled + ' maxBitrate=' + report.server.webRtcMaxBitrate);

    // 2. join voice channel -> routerRtpCapabilities
    out('-> voice.join (channel ' + CFG.channel + ')');
    const vj = await trpc.voice.join.mutate({
      channelId: CFG.channel,
      state: { micMuted: true, soundMuted: true }
    });
    const routerRtpCapabilities = vj.routerRtpCapabilities;
    if (!routerRtpCapabilities) throw new Error('voice.join returned no routerRtpCapabilities: ' + JSON.stringify(vj).slice(0, 300));
    out('   got routerRtpCapabilities');

    // 3. load mediasoup device
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities });
    report.routerCodecs = (device.rtpCapabilities.codecs || []).map((c) => c.mimeType);
    out('   router codecs: ' + report.routerCodecs.join(', '));

    // 4. create producer transport
    out('-> voice.createProducerTransport');
    const params = await trpc.voice.createProducerTransport.mutate();
    out('   transport id=' + params.id + ' iceServers=' + (params.iceServers || []).length);
    transport = device.createSendTransport(params);

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      out('-> voice.connectProducerTransport');
      try { await trpc.voice.connectProducerTransport.mutate({ dtlsParameters }); callback(); }
      catch (e) { out('   connect err: ' + e.message); errback(e); }
    });
    transport.on('connectionstatechange', (s) => out('   transport state=' + s));
    // mediasoup-client requires a 'produce' listener: it fires when a new track is
    // produced so the client can tell the server (voice.produce) and get a producer id.
    transport.on('produce', async ({ rtpParameters, appData }, callback, errback) => {
      out('-> voice.produce (kind=' + (appData && appData.kind) + ', encodings=' + (rtpParameters.encodings || []).length + ')');
      out('   rtpParameters.encodings=' + JSON.stringify((rtpParameters.encodings || []).map((e) => ({ rid: e.rid, scalabilityMode: e.scalabilityMode, maxBitrate: e.maxBitrate, scaleResolutionDownBy: e.scaleResolutionDownBy }))));
      try {
        const mutateInput = { transportId: transport.id, kind: appData.kind, rtpParameters };
        // v0.0.23 server requires qualityLayers (the 'quality layer labels') for
        // SIMULCAST producers (multiple encodings). SVC (single encoding) does not.
        if (appData.qualityLayers) mutateInput.qualityLayers = appData.qualityLayers;
        const id = await trpc.voice.produce.mutate(mutateInput);
        out('   producer id from server=' + id);
        callback({ id });
      } catch (e) { out('   produce err: ' + e.message); errback(e); }
    });

    // 5. produce a video track (simulcast encodings) with a preferred codec
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];

    // pick a preferred codec from the router capabilities
    const wantMime = 'video/' + CFG.codec;
    let preferredCodec = (device.rtpCapabilities.codecs || []).find(
      (c) => c.mimeType.toLowerCase() === wantMime.toLowerCase()
    );
    if (!preferredCodec) {
      out('   WARN: ' + wantMime + ' not in router codecs; producing without explicit codec');
    } else {
      out('   preferred codec: ' + preferredCodec.mimeType);
    }

    const qualityLayers = [
      { spatialLayer: 0, label: 'Low' },
      { spatialLayer: 1, label: 'Medium' },
      { spatialLayer: 2, label: 'High' }
    ];
    const useSvc = !!CFG.svc;
    const produceOpts = {
      track,
      codec: preferredCodec,
      codecOptions: {
        videoGoogleStartBitrate: 1000,
        videoGoogleMaxBitrate: 4000,
        videoGoogleMinBitrate: 200
      },
      // SVC (single encoding, multi-spatial, e.g. AV1 L3T3) is NOT simulcast: no
      // rids, no qualityLayers. Simulcast (3 encodings) needs rids + qualityLayers.
      appData: (CFG.simulcast && !useSvc) ? { kind: CFG.kind, qualityLayers } : { kind: CFG.kind }
    };
    if (useSvc) {
      // Single SVC encoding — AV1/VP9 encode 3 spatial layers in one bitstream.
      // NVENC AV1 does this in hardware (the hardware + multi-layer path).
      produceOpts.encodings = [{ scalabilityMode: CFG.svc, maxBitrate: 4000000, active: true }];
      out('   SVC encodings: ' + JSON.stringify(produceOpts.encodings));
    } else if (CFG.simulcast) {
      // mediasoup requires each simulcast encoding to carry a quality-layer label
      // (rid) + scalabilityMode. The upstream client sets L1T{temporalLayers} (L1T3).
      produceOpts.encodings = [
        { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 300000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true },
        { rid: 'mid', scaleResolutionDownBy: 2, maxBitrate: 800000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true },
        { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 4000000, maxFramerate: 30, scalabilityMode: 'L1T3', active: true }
      ];
    }
    out('-> transport.produce (simulcast=' + CFG.simulcast + ', svc=' + (CFG.svc||'none') + ', kind=' + CFG.kind + ')');
    producer = await transport.produce(produceOpts);
    out('   producer id=' + producer.id + ' rtpParameters.encodings=' + (producer.rtpParameters.encodings || []).length);

    // 6. sample getStats for SAMPLE_MS
    const start = Date.now();
    const samples = [];
    while (Date.now() - start < CFG.sampleMs) {
      await wait(1000);
      let stats;
      try { stats = await transport.getStats(); }
      catch (e) { out('   getStats err: ' + e.message); continue; }
      const ob = await gatherOutbound(stats);
      samples.push({ t: Date.now() - start, outbound: ob });
      const active = ob.filter((o) => o.framesEncoded > 0);
      out('   t=' + (Date.now() - start) + 'ms layers=' + ob.length + ' active=' + active.length +
        ' [' + active.map((a) => (a.rid || '?') + ':' + a.framesEncoded + 'f/' + a.msPerFrame.toFixed(1) + 'ms').join(', ') + ']');
    }

    const last = samples[samples.length - 1] ? samples[samples.length - 1].outbound : [];
    report.layers = last.map((l) => ({
      rid: l.rid, codec: l.codec, framesEncoded: l.framesEncoded, width: l.width, height: l.height,
      fps: l.fps, bytesSent: l.bytesSent, targetBitrate: l.targetBitrate,
      totalEncodeTime: l.totalEncodeTime, msPerFrame: +l.msPerFrame.toFixed(3),
      msPerKpx: l.width ? +((l.msPerFrame * 1000) / (l.width * l.height)).toFixed(3) : 0,
      keyFramesEncoded: l.keyFramesEncoded, qualityLimitationReason: l.qualityLimitationReason,
      active: l.active, encoderImplementation: l.encoderImplementation,
      hardware: classifyHw(l.msPerFrame, l.width, l.height)
    }));
    report.activeLayerCount = report.layers.filter((l) => l.framesEncoded > 0).length;
    report.encodingsConfigured = CFG.simulcast ? 3 : 1;
    out('=== RESULT === activeLayers=' + report.activeLayerCount + '/' + report.encodingsConfigured);
    report.layers.forEach((l) =>
      out('  rid=' + l.rid + ' ' + l.width + 'x' + l.height + ' ' + l.framesEncoded + 'f ' + l.msPerFrame + 'ms/fr ' + l.codec + ' ' + l.hardware));

  } catch (e) {
    out('LIVE TEST ERROR: ' + (e && e.stack || e));
    if (e?.data) out('  data: ' + JSON.stringify(e.data));
    report.error = String(e && e.message || e);
    report.stack = e && e.stack;
  } finally {
    // clean up: close producer, leave, close transport, close ws
    try { if (producer) producer.close(); } catch (e) {}
    try { if (transport) transport.close(); } catch (e) {}
    try {
      if (trpc) await trpc.voice.leave.mutate();
      out('left voice channel');
    } catch (e) {}
    try { wsClient.close(); } catch (e) {}
    out('=== DONE ===');
    ipcRenderer.send('selftest-report', report);
  }
}

main().catch((e) => {
  out('FATAL: ' + (e && e.stack || e));
  ipcRenderer.send('selftest-report', { error: String(e), stack: e && e.stack });
});
