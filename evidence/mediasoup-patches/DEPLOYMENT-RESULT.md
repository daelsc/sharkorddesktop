# AV1 simulcast — deployed & E2E proven on production server

## Status: LIVE on duper (sharkord.thesemite.com)

The patched mediasoup-worker (built from 3.19.19, AV1 added to the SIMULCAST
whitelist) is deployed and running on the production `Sharkord-Custom` container.

## Deployment method (restart-safe, reversible)
The compiled sharkord binary bakes `SHARKORD_MEDIASOUP_BIN_NAME="mediasoup-worker"`
at build time (helpers.ts:162 `define`), so a runtime env var can't redirect the
spawn, and `loadEmbeds()` re-extracts the embedded (unpatched) worker on every
start. Workaround: make the patched worker file **read-only + executable (0555)**
in a **read-only directory (0555)**. loadEmbeds' `fs.writeFile` then fails with
EACCES — and crucially the mediasoup extraction is the ONLY embed that does NOT
`process.exit(1)` on failure (it just logs), so the server continues and spawns
the existing patched binary.

```
container log on restart:
  error: Failed to extract mediasoup worker: EACCES: permission denied,
         open '/home/bun/.config/sharkord/mediasoup/mediasoup-worker'
```
(harmless — expected)

### Files on duper host (/mnt/user/appdata/sharkord/mediasoup/)
- `mediasoup-worker` — PATCHED (0555, spawned by server). md5 73cb3e95...
- `mediasoup-worker.orig` — original unpatched backup (10,026,000 bytes)
- `mediasoup-worker-av1` — patched binary copy (root-owned, for reference)

### Revert
```
ssh duper
cd /mnt/user/appdata/sharkord/mediasoup
chmod 0755 . mediasoup-worker          # make writable again
cp mediasoup-worker.orig mediasoup-worker   # restore original
chmod 0755 mediasoup-worker
docker restart Sharkord-Custom
```

## E2E proof (live self-test against sharkord.thesemite.com)
### AV1 simulcast — NOW WORKS (was rejected before the patch)
- preferred codec: video/AV1
- producer accepted by server (id 1bdfc30e...)
- 3 simulcast layers ACTIVE and encoding, all video/AV1, NVENC hardware:
  - r0: 320x180,  183 frames, 0.86 ms/frame, likely-hardware
  - r1: 640x360,  238 frames, 0.77 ms/frame, likely-hardware
  - r2: 1280x720,  76 frames, 1.28 ms/frame, likely-hardware
- BEFORE: `produce err: video/AV1 codec not supported for simulcast`

### H264 simulcast — regression check PASSED (unchanged)
- 3 layers active, producer accepted (id 50d59edc...)
- NVENC hardware (the original goal) still works.

## Caveats
- The patched worker will be overwritten if sharkord is upgraded/redeployed
  (new image) AND the perms are reset. Re-apply the swap + chmod 0555 after any
  image update, or rebuild from source with the patch baked in.
- AV1's codec handler is unofficially used for multi-RID simulcast here; it
  works in testing but is not an upstream-supported mediasoup configuration.
- HEVC/H265 remains unsupported (mediasoup has no H265 codec implementation at
  all — not a patchable gate).
