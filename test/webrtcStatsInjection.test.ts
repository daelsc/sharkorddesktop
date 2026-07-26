import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { buildWebrtcStatsInjection, buildSimulcastCodecInjection, forceSdpBandwidth } from '../src/webrtcStatsInjection';

/**
 * A mock RTCPeerConnection + sender that enforces the real WebRTC contract:
 * getParameters() returns a fresh object with an incrementing transactionId, and
 * setParameters(p) REJECTS if p.transactionId is stale (i.e. getParameters was
 * called again before setParameters). This is the exact invariant the
 * applyBitrateLimits simulcast path must respect — calling a helper that does a
 * second getParameters() invalidates the first parameters and setParameters
 * silently rejects.
 */
type Encoding = {
  rid?: string;
  scaleResolutionDownBy?: number;
  maxBitrate?: number;
  minBitrate?: number;
  maxFramerate?: number;
  scalabilityMode?: string;
  active?: boolean;
};
type Params = { encodings: Encoding[]; transactionId: number; degradationPreference?: string };

let nextTxId = 1;
function makeSender(trackKind: string, encodings: Encoding[]) {
  let currentTx = nextTxId++;
  const setCalls: Params[] = [];
  const rejections: string[] = [];
  return {
    track: { kind: trackKind },
    _encodings: encodings,
    getParameters(): Params {
      // Each call invalidates the previous transactionId (real WebRTC behaviour).
      currentTx = nextTxId++;
      return { encodings: encodings.map((e) => ({ ...e })), transactionId: currentTx };
    },
    setParameters(p: Params): Promise<void> {
      if (p.transactionId !== currentTx) {
        rejections.push('stale transactionId ' + p.transactionId + ' (current ' + currentTx + ')');
        return Promise.reject(new Error('InvalidAccessError: transactionId mismatch'));
      }
      // apply: copy the requested encodings back so a subsequent read reflects them
      encodings.splice(0, encodings.length, ...p.encodings.map((e) => ({ ...e })));
      setCalls.push(p);
      return Promise.resolve();
    },
    setCodecPreferences(_c: unknown): void { /* no-op for these tests */ },
    _setCalls: setCalls,
    _rejections: rejections
  };
}

function makePc(senders: ReturnType<typeof makeSender>[]) {
  const listeners: Record<string, Function[]> = {};
  return {
    connectionState: 'new',
    getSenders: () => senders,
    getTransceivers: () => senders.map((s) => ({ sender: s })),
    addEventListener(ev: string, fn: Function) { (listeners[ev] ||= []).push(fn); },
    setLocalDescription(d: any) { return Promise.resolve(d); },
    addTrack() { return {}; },
    createOffer() { return Promise.resolve({}); },
    getStats() { return Promise.resolve(new Map()); },
    _emit(ev: string, ...a: any[]) { (listeners[ev] || []).forEach((f) => f(...a)); }
  };
}

function runInjection(code: string, window: any) {
  const sandbox: any = {
    window,
    setInterval: () => 0,
    clearInterval: () => {},
    console: { log: () => {}, error: () => {} },
    RTCPeerConnection: window.RTCPeerConnection
  };
  vm.runInNewContext(code, sandbox);
  return sandbox;
}

function freshWindow(pc: any) {
  const handlers: { type: string; fn: Function }[] = [];
  const w: any = {
    RTCPeerConnection: function () { return pc; },
    addEventListener(type: string, fn: Function) { handlers.push({ type, fn }); },
    parent: null as any,
    location: { reload: () => {} }
  };
  w.parent = w;
  w.RTCPeerConnection.getCapabilities = () => ({ codecs: [{ mimeType: 'video/H264' }, { mimeType: 'video/rtx' }] });
  w.RTCPeerConnection.prototype = {};
  w._handlers = handlers;
  return w;
}

/* After runInjection, construct a PC so the injection's wrapper pushes it into
   its `pcs` array — the message handlers + stats loop iterate `pcs`, so without a
   constructed PC applyBitrateLimits never runs. The wrapper does `new OrigPC(...)`;
   our mock constructor returns the shared `pc` object, so the wrapped PC IS pc. */
function constructPc(w: any) { return new w.RTCPeerConnection(); }

describe('buildWebrtcStatsInjection — string integrity', () => {
  it('produces valid JS (parses + runs)', () => {
    const code = buildWebrtcStatsInjection({ forcedBps: 0, forcedCodec: 'H264' });
    expect(() => new Function(code)).not.toThrow();
  });
  it('contains NO // line comments (the regression that broke the injection)', () => {
    const code = buildWebrtcStatsInjection({ forcedBps: 0, forcedCodec: 'H264' });
    // The whole string is one line (joined with ''); any // would swallow the rest.
    expect(code.indexOf('//')).toBe(-1);
  });
  it('installs the hook guard and returns without error when RTC is absent', () => {
    const code = buildWebrtcStatsInjection({ forcedBps: 0, forcedCodec: 'H264' });
    const w: any = { addEventListener: () => {}, parent: {}, location: { reload: () => {} } };
    expect(() => vm.runInNewContext(code, { window: w, setInterval: () => 0, console: { log: () => {} } })).not.toThrow();
    expect(w.__sharkordRtcStatsHooked).toBe(true);
  });
});

describe('buildWebrtcStatsInjection — simulcast bitrate cap (live setParameters)', () => {
  function setup(forcedBps: number) {
    const sender = makeSender('video', [
      { rid: 'r0', scaleResolutionDownBy: 4, maxBitrate: 300000, scalabilityMode: 'L1T3', active: true },
      { rid: 'r1', scaleResolutionDownBy: 2, maxBitrate: 800000, scalabilityMode: 'L1T3', active: true },
      { rid: 'r2', scaleResolutionDownBy: 1, maxBitrate: 4000000, scalabilityMode: 'L1T3', active: true }
    ]);
    const pc = makePc([sender]);
    const w = freshWindow(pc);
    const code = buildWebrtcStatsInjection({ forcedBps, forcedCodec: 'H264' });
    runInjection(code, w);
    constructPc(w); // populate the injection's `pcs` array with pc
    // trigger the bitrate apply by emitting the message the wrapper sends
    const h = w._handlers.find((x: any) => x.type === 'message')!;
    return { sender, pc, w, h };
  }

  it('caps the HIGH simulcast layer (r2/scale 1) to the forced bitrate', () => {
    const { sender, h } = setup(0); // start Auto
    h.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 10000000 } });
    // applyBitrateLimits runs synchronously in the handler; setParameters is async but the
    // encodings are mutated before the call. Read back via getParameters (fresh, valid).
    const p = sender.getParameters();
    const high = p.encodings.find((e) => e.scaleResolutionDownBy === 1)!;
    expect(high.rid).toBe('r2');
    expect(high.maxBitrate).toBe(10000000);
    expect(sender._setCalls.length).toBeGreaterThanOrEqual(1);
    expect(sender._rejections).toEqual([]); // no stale-transactionId rejections
  });

  it('Auto (bps=0) REMOVES the high-layer maxBitrate cap', () => {
    const { sender, h } = setup(0); // start Auto
    // first apply a 10M cap so there is something to remove
    h.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 10000000 } });
    let p = sender.getParameters();
    expect(p.encodings.find((e) => e.scaleResolutionDownBy === 1)!.maxBitrate).toBe(10000000);
    // now Auto -> remove the cap
    h.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 0 } });
    p = sender.getParameters();
    expect('maxBitrate' in (p.encodings.find((e) => e.scaleResolutionDownBy === 1)!)).toBe(false);
    expect(sender._rejections).toEqual([]);
  });

  it('does NOT touch the low/mid simulcast layers', () => {
    const { sender, h } = setup(0);
    h.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 6000000 } });
    const p = sender.getParameters();
    expect(p.encodings.find((e) => e.rid === 'r0')!.maxBitrate).toBe(300000); // unchanged
    expect(p.encodings.find((e) => e.rid === 'r1')!.maxBitrate).toBe(800000); // unchanged
    expect(p.encodings.find((e) => e.rid === 'r2')!.maxBitrate).toBe(6000000); // capped
  });

  it('never rejects setParameters due to a stale transactionId (the regression)', () => {
    const { sender, h } = setup(0);
    h.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 8000000 } });
    h.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 4000000 } });
    h.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 0 } });
    expect(sender._rejections).toEqual([]);
    expect(sender._setCalls.length).toBe(3);
  });
});

describe('buildWebrtcStatsInjection — single-stream bitrate force', () => {
  it('forces min=max=FORCED_BPS + maintain-resolution on a single encoding', () => {
    const sender = makeSender('video', [{ maxBitrate: 100000 }]);
    const pc = makePc([sender]);
    const w = freshWindow(pc);
    runInjection(buildWebrtcStatsInjection({ forcedBps: 5000000, forcedCodec: 'H264' }), w);
    constructPc(w);
    // applyBitrateLimits runs on the stats interval, but we can't easily fire that
    // without a real interval. Instead drive via the bitrate message (which calls it).
    w._handlers.find((x: any) => x.type === 'message')!.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 5000000 } });
    expect(sender._setCalls.length).toBe(1);
    const sent = sender._setCalls[0];
    expect(sent.encodings[0].maxBitrate).toBe(5000000);
    expect(sent.encodings[0].minBitrate).toBe(5000000);
    expect(sent.degradationPreference).toBe('maintain-resolution');
    expect(sender._rejections).toEqual([]);
  });
  it('Auto (FORCED_BPS=0) leaves a single stream untouched', () => {
    const sender = makeSender('video', [{ maxBitrate: 100000 }]);
    const pc = makePc([sender]);
    const w = freshWindow(pc);
    runInjection(buildWebrtcStatsInjection({ forcedBps: 0, forcedCodec: 'H264' }), w);
    constructPc(w);
    w._handlers.find((x: any) => x.type === 'message')!.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 0 } });
    expect(sender._setCalls.length).toBe(0); // nothing to change
  });
  it('SVC (single encoding with scalabilityMode) caps maxBitrate only, never sets minBitrate', () => {
    // AV1/VP9 SVC: one encoding with scalabilityMode=L3T3. Forcing minBitrate would
    // destroy the internal spatial-layer allocation; only maxBitrate should change.
    const sender = makeSender('video', [{ scalabilityMode: 'L3T3', maxBitrate: 4000000 }]);
    const pc = makePc([sender]);
    const w = freshWindow(pc);
    runInjection(buildWebrtcStatsInjection({ forcedBps: 6000000, forcedCodec: 'H264' }), w);
    constructPc(w);
    w._handlers.find((x: any) => x.type === 'message')!.fn({ data: { type: 'sharkord-set-video-bitrate', bps: 6000000 } });
    expect(sender._setCalls.length).toBe(1);
    const sent = sender._setCalls[0];
    expect(sent.encodings[0].maxBitrate).toBe(6000000);
    expect('minBitrate' in sent.encodings[0]).toBe(false); // SVC: never set minBitrate
    expect(sent.degradationPreference).toBeUndefined(); // SVC: don't force degradation pref
    expect(sender._rejections).toEqual([]);
  });
});

describe('buildWebrtcStatsInjection — SDP bandwidth forcing', () => {
  const singleSdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
  const simulcastSdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=simulcast:prepare rid=low;high\r\n';
  const audioSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  const mixedSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';

  it('injects b=AS:<kbps> after the m=video line on a single-stream SDP', () => {
    const out = forceSdpBandwidth(singleSdp, 6000000);
    expect(out).toContain('b=AS:6000');
    expect(out.indexOf('b=AS:6000')).toBeGreaterThan(out.indexOf('m=video'));
  });
  it('skips simulcast video sections (a=simulcast present) — returned unchanged', () => {
    expect(forceSdpBandwidth(simulcastSdp, 6000000)).toBe(simulcastSdp);
  });
  it('replaces an existing b=AS line instead of duplicating', () => {
    const withBw = 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\nb=AS:1000\r\n';
    const out = forceSdpBandwidth(withBw, 6000000);
    expect((out.match(/b=AS:/g) || []).length).toBe(1);
    expect(out).toContain('b=AS:6000');
    expect(out).not.toContain('b=AS:1000');
  });
  it('leaves audio sections untouched', () => {
    const out = forceSdpBandwidth(audioSdp, 6000000) as string;
    expect(out).toBe(audioSdp);
  });
  it('leaves the audio section untouched in a mixed SDP and caps the video section', () => {
    const out = forceSdpBandwidth(mixedSdp, 4000000);
    expect(out).toContain('b=AS:4000');
    // audio section (before m=video) is unchanged up to the m=video line
    expect(out.startsWith('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).toBe(true);
  });
  it('returns sdp unchanged when forcedBps===0 (Auto)', () => {
    expect(forceSdpBandwidth(singleSdp, 0)).toBe(singleSdp);
  });
  it('returns input unchanged when sdp is falsy', () => {
    expect(forceSdpBandwidth('', 6000000)).toBe('');
    expect(forceSdpBandwidth(null as unknown as string, 6000000)).toBe(null as unknown as string);
  });
  it('the built injection string contains the same b=AS logic', () => {
    const code = buildWebrtcStatsInjection({ forcedBps: 6000000, forcedCodec: 'H264' });
    expect(code).toContain('b=AS:"+bwKbps+"');
    expect(code).toContain('if(/a=simulcast/i.test(sections[i]))continue;');
  });
});

describe('buildSimulcastCodecInjection — H264 default on load', () => {
  function runWithStorage(stored: any) {
    const store: Record<string, string> = {};
    if (stored !== null) store['sharkord-devices-settings'] = JSON.stringify(stored);
    let reloaded = false;
    const w: any = {
      addEventListener: () => {},
      location: { reload: () => { reloaded = true; } }
    };
    const sandbox: any = {
      window: w,
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; }
      },
      console: { log: () => {} }
    };
    vm.runInNewContext(buildSimulcastCodecInjection(), sandbox);
    return { store, reloaded };
  }
  it('writes H264 + reloads when screenCodec is not H264 (fresh install = auto)', () => {
    const { store, reloaded } = runWithStorage({ screenCodec: 'auto' });
    expect(JSON.parse(store['sharkord-devices-settings']).screenCodec).toBe('video/H264');
    expect(reloaded).toBe(true);
  });
  it('is a no-op (no reload) when screenCodec is already H264', () => {
    const { store, reloaded } = runWithStorage({ screenCodec: 'video/H264' });
    expect(reloaded).toBe(false);
    expect(JSON.parse(store['sharkord-devices-settings']).screenCodec).toBe('video/H264');
  });
  it('handles a missing settings key (creates it with H264)', () => {
    const { store, reloaded } = runWithStorage(null);
    expect(JSON.parse(store['sharkord-devices-settings']).screenCodec).toBe('video/H264');
    expect(reloaded).toBe(true);
  });
});
