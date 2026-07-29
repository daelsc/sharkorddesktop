#!/usr/bin/env python3
"""CDP driver for the native Sharkov app.

Attaches to the running native Sharkov.exe (launched with
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333), drives the SPA:
  1. seeds sessionStorage['sharkord-token'] with the bot JWT and reloads (skips connect UI)
  2. joins the target channel's voice room
  3. enables camera and/or screen share
  4. waits, then dumps a summary of the outbound-rtp stats from the in-page hook state

Usage: python scripts/native_selftest_driver.py --channel-index 0 --camera --duration 20
"""
import asyncio, base64, json, sys, time, argparse, urllib.request
import websockets

CDP_HOST = "127.0.0.1"
CDP_PORT = 9333
APP_URL_HINT = "sharkord.thesemite.com"


class Cdp:
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self._id = 0
        self._pending = {}

    async def connect(self):
        self.ws = await websockets.connect(self.ws_url, max_size=64 * 1024 * 1024)
        self.recv_task = asyncio.create_task(self._pump())

    async def _pump(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg and msg["id"] in self._pending:
                self._pending.pop(msg["id"]).set_result(msg)

    async def call(self, method, params=None):
        self._id += 1
        mid = self._id
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        resp = await asyncio.wait_for(fut, 30)
        if "error" in resp:
            raise RuntimeError(f"{method}: {resp['error']}")
        return resp.get("result", {})

    async def eval(self, expr, await_promise=False):
        r = await self.call("Runtime.evaluate", {
            "expression": expr, "awaitPromise": await_promise, "returnByValue": True})
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:500])
        return r.get("result", {}).get("value")

    async def close(self):
        self.recv_task.cancel()
        try:
            await self.ws.close()
        except Exception:
            pass


async def find_target():
    """Find the WebView2 page target showing the SPA."""
    for attempt in range(20):
        try:
            with urllib.request.urlopen(f"http://{CDP_HOST}:{CDP_PORT}/json/list", timeout=2) as r:
                targets = json.loads(r.read())
            pages = [t for t in targets if t.get("type") == "page"]
            for t in pages:
                if APP_URL_HINT in (t.get("url") or ""):
                    return t
            if pages:
                return pages[0]
        except Exception:
            pass
        await asyncio.sleep(1)
    raise SystemExit("no CDP page target found — is the app running with remote-debugging-port=9333?")


# --- JS snippets run inside the SPA page ---

SEED_TOKEN = """
(token => {{
  sessionStorage.setItem('sharkord-token', token);
  localStorage.setItem('sharkord-identity', json => json)(localStorage.getItem('sharkord-identity'));
  return 'seeded';
}})
"""

# Returns {ok, state} describing where the SPA is.
PROBE_STATE = """
(() => {
  const q = s => document.querySelector(s);
  return {
    url: location.href,
    connectScreen: !!q('[data-testid="connect-identity-input"]'),
    serverView: !!q('[data-testid="server-view"]'),
    channelCount: document.querySelectorAll('[data-testid="channel-item"]').length,
    bodyTextSample: (document.body ? document.body.innerText : '').slice(0, 300)
  };
})()
"""

# Click channel item at index, return its text.
JOIN_CHANNEL = """
(idx => {
  const items = [...document.querySelectorAll('[data-testid="channel-item"]')];
  if (idx >= items.length) return { ok: false, count: items.length,
      texts: items.map(i => i.innerText.slice(0, 60)) };
  items[idx].scrollIntoView(); items[idx].click();
  return { ok: true, text: items[idx].innerText.slice(0, 60) };
})
"""

# List buttons/icons after channel join so we can find voice-join/camera/screen controls.
DUMP_CONTROLS = """
(() => {
  const els = [...document.querySelectorAll('button,[role="button"]')].slice(0, 80);
  return els.map(e => ({
    testid: e.getAttribute('data-testid'), title: e.getAttribute('title'),
    aria: e.getAttribute('aria-label'),
    text: (e.innerText || '').slice(0, 40).trim(),
    cls: (e.className || '').toString().slice(0, 60)
  })).filter(x => x.testid || x.title || x.aria || x.text);
})()
"""

CLICK_BY_TEXT = """
(needle => {
  const els = [...document.querySelectorAll('button,[role="button"]')];
  const hit = els.find(e => ((e.innerText||'') + ' ' + (e.title||'') + ' ' + (e.getAttribute('aria-label')||''))
                    .toLowerCase().includes(needle.toLowerCase()));
  if (!hit) return { ok: false };
  hit.click();
  return { ok: true, clicked: (hit.innerText || hit.title || hit.getAttribute('aria-label') || '').slice(0, 60) };
})
"""

# Snapshot of in-page WebRTC hook state + outbound-rtp summary.
RTC_SNAPSHOT = """
(async () => {
  const hookInstalled = !!window.__sharkordRtcStatsHooked;
  const pcs = [];
  // Reach into every RTCPeerConnection we can find. The hook keeps its own list, but
  // that list is inside a closure; rebuild by stats-diffing each sender we can find via
  // a fresh grab on the prototype chain is not possible — so rely on the hook having run
  // (hookInstalled) plus live getStats on any PC the SPA exposes globally if any.
  const out = { hookInstalled, pcs: [] };
  // fallback: query via getUserMedia-held streams is impossible; use window.__sharkordPcs if exposed
  const list = window.__sharkordPcs || [];
  for (const pc of list) {
    const stats = await pc.getStats();
    const rows = [];
    stats.forEach(s => {
      if (s.type === 'outbound-rtp') rows.push({
        kind: s.kind || s.mediaType, codecId: s.codecId,
        encoderImplementation: s.encoderImplementation || '',
        framesPerSecond: s.framesPerSecond || 0,
        frameWidth: s.frameWidth || 0, frameHeight: s.frameHeight || 0,
        bytesSent: s.bytesSent || 0,
        qualityLimitationReason: s.qualityLimitationReason || '',
        scalabilityMode: s.scalabilityMode || '', rid: s.rid || ''
      });
      if (s.type === 'codec') rows.push({ codecMime: s.mimeType, codecId: s.id, _codec: true });
    });
    pcs.push({ state: pc.connectionState, rows });
  }
  out.pcs = pcs;
  return out;
})()
"""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token-file", default=".bot-token")
    ap.add_argument("--channel-index", type=int, default=0)
    ap.add_argument("--channel-needle", default="",
                    help="click the channel whose text contains this (overrides --channel-index)")
    ap.add_argument("--camera", action="store_true")
    ap.add_argument("--screen", action="store_true")
    ap.add_argument("--duration", type=int, default=20, help="seconds to stream before snapshot")
    args = ap.parse_args()

    token = open(args.token_file).read().strip()
    target = await find_target()
    print(f"[driver] target: {target.get('title', '?')} — {target.get('url', '?')[:80]}")
    c = Cdp(target["webSocketDebuggerUrl"])
    await c.connect()
    await c.call("Page.enable")
    await c.call("Runtime.enable")

    # 1. seed token + reload to skip connect screen
    state = await c.eval(PROBE_STATE)
    print(f"[driver] before: connectScreen={state['connectScreen']} serverView={state['serverView']}")
    await c.eval(f"(() => {{ sessionStorage.setItem('sharkord-token', {json.dumps(token)}); location.reload(); return 1; }})()")
    await asyncio.sleep(4)
    state = await c.eval(PROBE_STATE)
    print(f"[driver] after login: serverView={state['serverView']} channels={state['channelCount']}")
    if not state["serverView"]:
        print(f"[driver] NOT on server view. Body sample: {state['bodyTextSample']}")
        await c.close(); return 2

    # 2. join channel
    if args.channel_needle:
        sel = f"""
        (() => {{
          const items = [...document.querySelectorAll('[data-testid="channel-item"]')];
          const hit = items.find(i => (i.innerText||'').toLowerCase().includes({json.dumps(args.channel_needle.lower())}));
          if (!hit) return {{ ok: false, texts: items.map(i => (i.innerText||'').slice(0,60)) }};
          hit.scrollIntoView(); hit.click();
          return {{ ok: true, text: (hit.innerText||'').slice(0,60) }};
        }})()
        """
        r = await c.eval(sel)
    else:
        r = await c.eval(f"({JOIN_CHANNEL})({args.channel_index})")
    print(f"[driver] channel click: {r}")
    if not r.get("ok"):
        await c.close(); return 2
    await asyncio.sleep(3)

    # dump controls to discover voice/video buttons
    controls = await c.eval(DUMP_CONTROLS)
    print(f"[driver] {len(controls)} controls on screen:")
    for ctl in controls[:40]:
        print(f"  - {ctl}")

    # 3. voice state: 'Disconnect' title = already connected; else click channel with a
    # voice-join affordance. Use exact title match to avoid the Disconnect trap.
    voice = await c.eval("""(() => {
      const byTitle = t => document.querySelector(`[title="${t}"]`);
      return { connected: !!byTitle('Disconnect'),
               canCamera: !!byTitle('Turn on camera'),
               canScreen: !!byTitle('Start screen share') };
    })()""")
    print(f"[driver] voice state: {voice}")
    if not voice.get("connected"):
        # voice channels join by clicking the channel item itself in Sharkord
        print("[driver] not in voice — channel click above should have joined if it was a voice channel")

    # 4. camera / screen via exact titles
    if args.camera:
        r = await c.eval("""(() => { const b = document.querySelector('[title="Turn on camera"]');
          if (b) { b.click(); return { ok: true }; } return { ok: false }; })()""")
        print(f"[driver] camera: {r}")
        await asyncio.sleep(4)
    if args.screen:
        r = await c.eval("""(() => { const b = document.querySelector('[title="Start screen share"]');
          if (b) { b.click(); return { ok: true }; } return { ok: false }; })()""")
        print(f"[driver] screen share: {r}")
        await asyncio.sleep(5)
        # WebView2 default display-media dialog: list possible pick buttons
        picker = await c.eval(DUMP_CONTROLS)
        print(f"[driver] post-picker controls ({len(picker)}):")
        for ctl in picker[:15]:
            print(f"  - {ctl}")
    await asyncio.sleep(4)

    # expose pc list for snapshot: install a getter that reaches the hook's closure list
    await c.eval("""(() => {
      if (!window.__sharkordPcs) {
        // the hook closure isn't reachable; add a capture overlay for FUTURE PCs is useless
        // mid-test — instead read what our own hook already pushed into DOM: nothing.
        // Best-effort: attach to any videos' srcObject streams to detect streaming at all.
      }
      return [...document.querySelectorAll('video')].map(v => ({
        hasStream: !!v.srcObject, tracks: v.srcObject ? v.srcObject.getTracks().length : 0,
        muted: v.muted, playing: !v.paused, w: v.videoWidth, h: v.videoHeight
      }));
    })()""")

    print(f"[driver] streaming for {args.duration}s ...")
    await asyncio.sleep(args.duration)

    # 5. grab whatever stats reached the host log via the (new) bridge
    videos = await c.eval("""[...document.querySelectorAll('video')].map(v => ({
      hasStream: !!v.srcObject, tracks: v.srcObject ? v.srcObject.getTracks().length : 0,
      muted: v.muted, paused: v.paused, w: v.videoWidth, h: v.videoHeight }))""")
    print(f"[driver] video elements: {videos}")
    await c.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
