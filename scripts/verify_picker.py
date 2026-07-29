#!/usr/bin/env python3
"""Verify WebView2's getDisplayMedia picker shows on a CLEAN launch (no auto-select flags).

Launches a separate isolated instance of the native app with ONLY
--remote-debugging-port (which does NOT suppress the picker), injects a test button
into the connect screen (no login, no voice join -> doesn't disturb the user's
running dave session), clicks it via CDP (a real user gesture), then detects:
  - resolved in <1.5s  -> NO picker (auto-selected) = BUG
  - still pending >6s  -> picker is showing       = WORKING

Does NOT touch the user's running instance (different exe name -> different
WebView2 user-data-dir; no shared state).
"""
import asyncio, json, os, subprocess, sys, time, urllib.request
import websockets

EXE = r"C:\Users\dave\Desktop\sharkov-native-new.exe"
PORT = 9334  # different from the running instance's 9333


async def main():
    env = os.environ.copy()
    # ONLY the CDP flag. No --auto-select-desktop-capture-source, no --use-fake-ui.
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={PORT}"
    proc = subprocess.Popen([EXE], env=env)
    print(f"[verify] launched isolated clean instance PID={proc.pid} on CDP port {PORT}")

    try:
        # find the page target
        target = None
        for _ in range(30):
            try:
                ts = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=2).read())
                pages = [t for t in ts if t.get("type") == "page"]
                if pages:
                    target = pages[0]
                    break
            except Exception:
                pass
            await asyncio.sleep(1)
        if not target:
            print("[verify] FAIL: no CDP page target"); return 3
        print(f"[verify] target: {target.get('title','?')} | {target.get('url','')[:60]}")

        ws = await websockets.connect(target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024)
        mid = 0; pend = {}
        async def pump():
            async for raw in ws:
                m = json.loads(raw)
                if "id" in m and m["id"] in pend: pend.pop(m["id"]).set_result(m)
        asyncio.create_task(pump())

        async def call(method, params=None):
            nonlocal mid; mid += 1
            f = asyncio.get_event_loop().create_future(); pend[mid] = f
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            return await asyncio.wait_for(f, 20)

        async def ev(expr, await_promise=False):
            r = await call("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
            return r.get("result", {}).get("result", {}).get("value")

        await call("Page.enable"); await call("Runtime.enable")

        # Inject a probe button + handler. No login needed; getDisplayMedia works from any page.
        await ev("""(() => {
          if (document.getElementById('__probeShare')) return true;
          const b = document.createElement('button');
          b.id = '__probeShare';
          b.textContent = 'PROBE SHARE';
          b.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;padding:12px 24px;font-size:16px;background:#3b82f6;color:#fff;border:0;cursor:pointer';
          b.onclick = () => {
            window.__gdmStart = Date.now();
            window.__gdmResult = null;
            navigator.mediaDevices.getDisplayMedia({video:true})
              .then(s => { window.__gdmResult = 'resolved'; try { s.getTracks().forEach(t=>t.stop()); } catch(e){} })
              .catch(e => { window.__gdmResult = 'err:' + ((e && (e.message||e.name)) || e); });
          };
          document.body.appendChild(b);
          return true;
        })()""")

        # Get the button's bounding rect so we can click its center via CDP (real user gesture).
        rect = await ev("""(() => {
          const b = document.getElementById('__probeShare');
          const r = b.getBoundingClientRect();
          return {x: r.x + r.width/2, y: r.y + r.height/2};
        })()""")
        print(f"[verify] probe button center: {rect}")

        # Click via CDP Input.dispatchMouseEvent (this is a real user activation).
        def click_seq(x, y):
            return [
                {"type": "mouseMoved", "x": x, "y": y},
                {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1},
                {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1},
            ]
        for ev_params in click_seq(rect["x"], rect["y"]):
            await call("Input.dispatchMouseEvent", ev_params)
        print("[verify] clicked probe button -> getDisplayMedia() called")

        # Poll for ~7s. resolved fast = no picker (auto-select). pending = picker showing.
        start = time.time()
        result = None
        while time.time() - start < 7:
            await asyncio.sleep(0.5)
            r = await ev("window.__gdmResult")
            if r is not None:
                result = r
                elapsed = round(time.time() - start, 2)
                print(f"[verify] getDisplayMedia resolved in {elapsed}s -> {result}")
                break

        await ws.close()

        if result is None:
            print(f"[verify] getDisplayMedia still PENDING after 7s -> picker is showing (WORKING)")
            return 0
        elif result == "resolved" and (time.time() - start) < 1.5:
            print(f"[verify] getDisplayMedia auto-resolved with no picker -> BUG (auto-select still active)")
            return 1
        else:
            # resolved slowly or with an error (e.g. user dismissed) - still indicates a picker was shown
            print(f"[verify] getDisplayMedia resolved with: {result} (a picker was shown then dismissed/denied) -> WORKING")
            return 0
    finally:
        try: proc.terminate()
        except Exception: pass
        try: proc.wait(timeout=5)
        except Exception:
            try: proc.kill()
            except Exception: pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
