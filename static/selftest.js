// Sharkov codec self-test — runs entirely in a renderer with nodeIntegration:true.
// Performs local WebRTC loopbacks (canvas -> pc1 -> pc2 -> hidden video) for each
// codec, single-stream and 3-layer simulcast, and reports encoderImplementation +
// negotiated mimeType + framesEncoded + bitrate + layer count to the main process.
//
// No network, no clicks, no server. Main process writes the JSON report and quits.
const { ipcRenderer } = require('electron');

const logEl = document.getElementById('log');
function out(msg) {
  console.log(msg);
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- animated source ----
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let frame = 0;
function draw() {
  frame++;
  const t = frame;
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop((Math.sin(t / 30) + 1) / 2, '#0a0a0a');
  g.addColorStop((Math.cos(t / 45) + 1) / 2, '#1e3a5f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#a1e6a1';
  ctx.font = '64px Consolas, monospace';
  ctx.fillText('SHARKOV ' + t, 60 + (t % 200), 360 + Math.sin(t / 10) * 120);
  ctx.strokeStyle = '#e4e4e7';
  ctx.lineWidth = 4;
  ctx.strokeRect(20, 20, 1240, 680);
  requestAnimationFrame(draw);
}
draw();

const VIDEO = document.getElementById('v');

// codec key -> acceptable mimeType(s)
const CODEC_MIMES = {
  H264: ['video/h264'],
  H265: ['video/h265', 'video/hvc1', 'video/hev1'],
  AV1: ['video/av1'],
  VP8: ['video/vp8'],
  VP9: ['video/vp9']
};

function matchCodec(caps, key) {
  if (!caps || !caps.codecs) return [];
  const want = CODEC_MIMES[key].map((m) => m.toLowerCase());
  // Keep real encoder-capable video codecs (exclude RTX / red / ulpfec / comfortnoise)
  return caps.codecs.filter((c) => {
    const m = (c.mimeType || '').toLowerCase();
    return want.includes(m);
  });
}

function classifyHw(encoderImpl, mimeType) {
  const s = (encoderImpl || '').toLowerCase();
  const hw = ['nvidia', 'amf', 'qsv', 'quicksync', 'mediafoundation', 'mf', 'd3d11', 'hw', 'hardware', 'vaapi', 'videotoolbox'];
  const sw = ['openh264', 'libvpx', 'libaom', 'aom', 'software', 'generic', 'external'];
  if (hw.some((k) => s.includes(k))) return true;
  if (sw.some((k) => s.includes(k))) return false;
  return null; // unknown
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Build a fresh MediaStreamTrack from the canvas for each test (independent encoders)
function freshTrack() {
  const stream = canvas.captureStream(30);
  return stream.getVideoTracks()[0];
}

async function gatherStats(pc) {
  const stats = await pc.getStats();
  const outbounds = [];
  stats.forEach((s) => {
    if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
      let codecName = '';
      if (s.codecId) {
        const cs = stats.get(s.codecId);
        if (cs) codecName = cs.mimeType || '';
      }
      const framesEncoded = s.framesEncoded || 0;
      const totalEncodeTime = typeof s.totalEncodeTime === 'number' ? s.totalEncodeTime : 0;
      outbounds.push({
        ssrc: s.ssrc,
        rid: s.rid || null,
        codec: codecName || s.codecId || '',
        encoderImplementation: s.encoderImplementation || s.implementation || '',
        framesEncoded,
        framesSent: s.framesSent || 0,
        width: s.frameWidth || 0,
        height: s.frameHeight || 0,
        fps: s.framesPerSecond || 0,
        bytesSent: s.bytesSent || 0,
        packetsSent: s.packetsSent || 0,
        targetBitrate: s.targetBitrate || 0,
        keyFramesEncoded: s.keyFramesEncoded || 0,
        qpSum: s.qpSum || 0,
        totalEncodeTime,
        // CPU encode ms per encoded frame — the strongest hardware signal this
        // build gives us (encoderImplementation is not exposed). HW NVENC is
        // typically ~1-2 ms/frame at 720p; software (openh264/libvpx) is 5-15+.
        msPerFrame: framesEncoded > 0 ? (totalEncodeTime * 1000) / framesEncoded : 0,
        active: s.active,
        encodingIndex: s.encodingIndex,
        qualityLimitationReason: s.qualityLimitationReason || null
      });
    }
  });
  return outbounds;
}

// Diagnostic dump: expose EVERY field this build puts on outbound-rtp (and list all
// stat types). encoderImplementation is the canonical HW/SW signal, but custom
// Chromium builds (electroncapture) may expose it under another key, or not at all.
// Rather than guess, capture the raw object + every key, plus any stats entry that
// mentions an encoder, so we can see exactly what's available.
async function dumpRawStats(pc) {
  const stats = await pc.getStats();
  const types = {};
  const outbounds = [];
  const encoderHints = [];
  stats.forEach((s) => {
    types[s.type] = (types[s.type] || 0) + 1;
    if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
      // shallow clone, drop giant nested objects
      const clone = {};
      for (const k of Object.keys(s)) {
        const v = s[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) continue;
        clone[k] = v;
      }
      outbounds.push(clone);
    }
    // hunt ANY stats report for encoder-implementation-ish fields
    for (const k of Object.keys(s)) {
      if (/encoder|implementation/i.test(k) && typeof s[k] === 'string' && s[k]) {
        encoderHints.push({ type: s.type, key: k, value: s[k], id: s.id });
      }
    }
  });
  return {
    statTypes: types,
    outboundKeys: outbounds[0] ? Object.keys(outbounds[0]) : [],
    firstOutbound: outbounds[0] || null,
    allOutbounds: outbounds,
    encoderHints
  };
}

// ---- Injection logic check ------------------------------------------------
// Replicates the NEW getWebrtcStatsInjectionCode() applyBitrateLimits decision
// (MUST stay in sync with src/main.ts). Proves the fix autonomously:
//   - a 3-encoding simulcast sender keeps its distinct per-layer maxBitrates
//     (the old code collapsed all to min=max=FORCED_BPS and destroyed simulcast);
//   - a single-encoding sender still gets maxBitrate forced to FORCED_BPS
//     (preserves the "force hardware H264 + fixed bitrate" screen-share behaviour).
async function injectionApplyBitrate(sender, forcedBps) {
  var p = sender.getParameters();
  if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
  // Robust simulcast detection — MUST match isSimulcastSender in src/main.ts.
  // getParameters().encodings collapses to the base layer when upper simulcast
  // layers are inactive (P2P / SFU-not-subscribed), but the base keeps its rid
  // + scaleResolutionDownBy. Detect on those so we never force-collapse a real
  // simulcast sender (the old min=max=FORCED_BPS behaviour destroyed simulcast).
  var isSim = p.encodings.length > 1 || p.encodings.some(function (e) {
    return e.rid || (e.scaleResolutionDownBy && e.scaleResolutionDownBy > 1);
  });
  if (isSim) return { treatedAs: 'simulcast', params: sender.getParameters() };
  var enc = p.encodings[0];
  enc.maxBitrate = forcedBps;
  enc.minBitrate = forcedBps;
  p.degradationPreference = 'maintain-resolution';
  await sender.setParameters(p);
  return { treatedAs: 'single', params: sender.getParameters() };
}

async function runInjectionCheck() {
  out('\n=== INJECTION SIMULCAST-PRESERVATION CHECK ===');
  var FORCED_BPS = 5000000;
  var res = { simulcastPreserved: false, singleForced: false, details: {} };
  var caps = RTCRtpSender.getCapabilities('video');
  var vp8 = caps.codecs.filter(function (c) { return /vp8/i.test(c.mimeType); });

  // --- simulcast sender: 3 encodings, distinct bitrates ---
  try {
    var pc1 = new RTCPeerConnection({ iceServers: [] });
    var pc2 = new RTCPeerConnection({ iceServers: [] });
    pc1.onicecandidate = function (e) { e.candidate && pc2.addIceCandidate(e.candidate).catch(function () {}); };
    pc2.onicecandidate = function (e) { e.candidate && pc1.addIceCandidate(e.candidate).catch(function () {}); };
    var track = freshTrack();
    var tx = pc1.addTransceiver(track, {
      direction: 'sendonly', streams: [new MediaStream([track])],
      sendEncodings: [
        { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 300000, active: true },
        { rid: 'mid', scaleResolutionDownBy: 2, maxBitrate: 800000, active: true },
        { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 4000000, active: true }
      ]
    });
    try { tx.setCodecPreferences(vp8); } catch (e) {}
    pc2.ontrack = function (ev) { try { ev.transceiver.setCodecPreferences(vp8); } catch (e) {} };
    var offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    var answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    // Let the simulcast layers fully activate (same window the codec runs use).
    // Reading getParameters too early shows a transient 1-encoding sender.
    await wait(2500);
    var encBefore = tx.sender.getParameters().encodings || [];
    var before = encBefore.map(function (e) { return e.maxBitrate; });
    res.details.simulcastEncodingsBefore = encBefore.map(function (e) { return { rid: e.rid || null, scale: e.scaleResolutionDownBy || null, active: e.active, maxBitrate: e.maxBitrate || null, minBitrate: e.minBitrate || null }; });
    res.details.simulcastSdpHasSimulcast = /a=simulcast/i.test(offer.sdp || '');
    // Cross-check: getStats outbound-rtp count should equal encodings.length when
    // simulcast is actually negotiated (multiple SSRCs / RIDs).
    var stats = await pc1.getStats();
    var obCount = 0;
    stats.forEach(function (s) { if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) obCount++; });
    var applied = await injectionApplyBitrate(tx.sender, FORCED_BPS);
    var encAfter = applied.params.encodings || [];
    var after = encAfter.map(function (e) { return e.maxBitrate; });
    res.details.simulcast = { before: before, after: after, layersAfter: encAfter.length, statsOutboundCount: obCount, treatedAs: applied.treatedAs };
    // Preserved == the injection treated the simulcast sender as simulcast (did
    // NOT force maxBitrate to FORCED_BPS) and left per-layer bitrates unchanged.
    res.simulcastPreserved = applied.treatedAs === 'simulcast' && after.length > 0 && after.every(function (v, i) { return v === before[i]; }) && after[0] !== FORCED_BPS;
    out('  simulcast treatedAs=' + applied.treatedAs + ' before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after) + ' statsOB=' + obCount + ' preserved=' + res.simulcastPreserved);
    try { track.stop(); } catch (e) {} pc1.close(); pc2.close();
  } catch (e) { res.details.simulcastError = String(e); out('  simulcast check threw: ' + e); }

  // --- single sender: should be forced to FORCED_BPS ---
  try {
    var s1 = new RTCPeerConnection({ iceServers: [] });
    var s2 = new RTCPeerConnection({ iceServers: [] });
    s1.onicecandidate = function (e) { e.candidate && s2.addIceCandidate(e.candidate).catch(function () {}); };
    s2.onicecandidate = function (e) { e.candidate && s1.addIceCandidate(e.candidate).catch(function () {}); };
    var tk = freshTrack();
    var stx = s1.addTransceiver(tk, { direction: 'sendonly', streams: [new MediaStream([tk])] });
    var of = await s1.createOffer(); await s1.setLocalDescription(of);
    await s2.setRemoteDescription(of); var an = await s2.createAnswer();
    await s2.setLocalDescription(an); await s1.setRemoteDescription(an);
    await wait(2500);
    var pBefore = stx.sender.getParameters().encodings[0].maxBitrate;
    await injectionApplyBitrate(stx.sender, FORCED_BPS);
    var pAfter = stx.sender.getParameters().encodings[0].maxBitrate;
    res.details.single = { before: pBefore, after: pAfter, forcedBps: FORCED_BPS };
    res.singleForced = pAfter === FORCED_BPS;
    out('  single before=' + pBefore + ' after=' + pAfter + ' forced=' + res.singleForced);
    try { tk.stop(); } catch (e) {} s1.close(); s2.close();
  } catch (e) { res.details.singleError = String(e); out('  single check threw: ' + e); }

  return res;
}

async function runOne(key, simulcast) {
  out(`\n=== ${key} ${simulcast ? 'SIMULCAST(3 layers)' : 'SINGLE'} ===`);
  const caps = RTCRtpSender.getCapabilities('video');
  const preferred = matchCodec(caps, key);
  if (preferred.length === 0) {
    out(`  ${key}: codec not in RTCRtpSender.getCapabilities('video') — NOT SUPPORTED by this build`);
    return { supported: false, reason: 'codec not in capabilities' };
  }
  out(`  capabilities match: ${preferred.map((c) => c.mimeType).join(', ')}`);

  const pc1 = new RTCPeerConnection({ iceServers: [] });
  const pc2 = new RTCPeerConnection({ iceServers: [] });

  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});

  const track = freshTrack();

  let transceiver1;
  if (simulcast) {
    transceiver1 = pc1.addTransceiver(track, {
      direction: 'sendonly',
      streams: [new MediaStream([track])],
      sendEncodings: [
        { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 300000 },
        { rid: 'mid', scaleResolutionDownBy: 2, maxBitrate: 800000 },
        { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 4000000 }
      ]
    });
  } else {
    transceiver1 = pc1.addTransceiver(track, {
      direction: 'sendonly',
      streams: [new MediaStream([track])]
    });
  }

  // force codec on sender
  try { transceiver1.setCodecPreferences(preferred); }
  catch (e) { out('  setCodecPreferences(sender) threw: ' + e.message); }

  // For simulcast, explicitly mark every encoding active. Without an SFU
  // subscribing to layers, Chromium P2P loopback otherwise parks the upper
  // layers (mid/high) at framesEncoded=0. Forcing active makes the loopback
  // exercise all encoders so we can see encoderImplementation per layer.
  if (simulcast) {
    try {
      const params = transceiver1.sender.getParameters();
      if (params && params.encodings) {
        params.encodings = params.encodings.map((e) => ({ ...e, active: true }));
        await transceiver1.sender.setParameters(params);
        out('  setParameters: forced ' + params.encodings.length + ' encodings active:true');
      }
    } catch (e) { out('  setParameters(active) threw: ' + e.message); }
  }

  let recvTransceiver = null;
  pc2.ontrack = (ev) => {
    recvTransceiver = ev.transceiver;
    try { recvTransceiver.setCodecPreferences(preferred); }
    catch (e) { out('  setCodecPreferences(recv) threw: ' + e.message); }
    if (ev.streams && ev.streams[0]) { VIDEO.srcObject = ev.streams[0]; }
  };

  const connStates = [];
  pc1.addEventListener('connectionstatechange', () => connStates.push(pc1.connectionState));

  try {
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  } catch (e) {
    out('  negotiation FAILED: ' + e.message);
    try { track.stop(); } catch {}
    try { pc1.close(); pc2.close(); } catch {}
    return { supported: false, reason: 'negotiation failed: ' + e.message };
  }

  // give the encoder time to actually encode frames
  const samples = [];
  const start = Date.now();
  for (let i = 0; i < 10; i++) {
    await wait(700);
    const ob = await gatherStats(pc1);
    samples.push({ t: Date.now() - start, outbound: ob });
  }

  // pick the most-encoded outbound (or all for simulcast)
  const last = samples[samples.length - 1].outbound;
  const negotiated = last.map((o) => o.codec).filter(Boolean);
  const negotiatedCodec = negotiated[0] || '';
  const encImpl = last.map((o) => o.encoderImplementation).filter(Boolean)[0] || '';
  const hardware = classifyHw(encImpl, negotiatedCodec);

  // raw diagnostic dump — only populated for the first run (H264 single) to
  // keep the report small, but enough to see every field this build exposes.
  const statsDump = (key === 'H264' && !simulcast) ? await dumpRawStats(pc1) : null;

  const result = {
    supported: last.length > 0,
    negotiatedCodec,
    encoderImplementation: encImpl,
    hardware,
    connStates,
    layers: last.length,
    detail: last,
    statsDump
  };
  out(`  negotiatedCodec=${negotiatedCodec} encoderImplementation=${encImpl} hardware=${hardware} layers=${last.length}`);
  if (simulcast) {
    last.forEach((l) => out(`    layer rid=${l.rid} ${l.width}x${l.height} enc=${l.encoderImplementation} frames=${l.framesEncoded}`));
  } else if (last[0]) {
    out(`    ${last[0].width}x${last[0].height} framesEncoded=${last[0].framesEncoded} fps=${last[0].fps}`);
  }

  try { track.stop(); } catch {}
  try { pc1.close(); pc2.close(); } catch {}
  return result;
}

async function main() {
  out('Sharkov codec self-test starting');
  let gl = null;
  try { gl = document.createElement('canvas').getContext('webgl2'); } catch {}
  out('webgl2: ' + !!gl);
  const caps = RTCRtpSender.getCapabilities('video');
  out('Available video codecs: ' + (caps ? caps.codecs.map((c) => c.mimeType).join(', ') : 'NONE'));

  const report = {
    timestamp: new Date().toISOString(),
    availableCodecs: caps ? caps.codecs.map((c) => c.mimeType) : [],
    codecs: {}
  };

  for (const key of ['H264', 'H265', 'AV1', 'VP8', 'VP9']) {
    const single = await runOne(key, false);
    const simul = await runOne(key, true);
    report.codecs[key] = { single, simulcast: simul };
    // ship incremental progress so we can read partials if it crashes
    ipcRenderer.send('selftest-progress', { key, single, simulcast: simul });
  }

  const injectionCheck = await runInjectionCheck();
  report.injectionCheck = injectionCheck;

  out('\n=== DONE ===');
  out('injectionCheck: ' + JSON.stringify(report.injectionCheck));
  out(JSON.stringify(report, null, 2));
  ipcRenderer.send('selftest-report', report);
}

main().catch((e) => {
  out('FATAL: ' + (e && e.stack || e));
  ipcRenderer.send('selftest-report', { error: String(e), stack: e && e.stack });
});
