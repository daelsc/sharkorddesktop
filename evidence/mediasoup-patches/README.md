# mediasoup worker patch — AV1 simulcast support

## What this is
A patched `mediasoup-worker` binary (built from mediasoup **3.19.19**, the exact
version sharkord v0.0.23 embeds) that allows **AV1 for simulcast**.

## The problem (proven from mediasoup C++ source)
mediasoup's `IsValidTypeForCodec()` (in
`worker/include/RTC/RTP/Codecs/Tools.hpp`) hardcodes the codecs allowed for each
Producer type. The SIMULCAST whitelist is **VP8 and H264 only**:

```cpp
case RTC::RtpParameters::Type::SIMULCAST:
  switch (mimeType.subtype) {
    case VP8:
    case H264:  return true;
    default:    return false;   // AV1, VP9, etc. -> "video/X codec not supported for simulcast"
  }
```

So even though AV1 has a full codec handler (used for SVC + single-stream), the
worker rejects AV1 simulcast at `transport.produce()` time. This is compiled C++
in the worker binary sharkord embeds — **not** editable in sharkord's TypeScript
or in the router's `mediaCodecs` config.

## The patch (one line)
Add `AV1` to the SIMULCAST case — see `av1-simulcast.patch`:

```diff
 case RTC::RtpCodecMimeType::Subtype::VP8:
 case RTC::RtpCodecMimeType::Subtype::H264:
+case RTC::RtpCodecMimeType::Subtype::AV1:
 { return true; }
```

## Validation (local, non-destructive)
`ms-av1test.js` creates a router with an AV1 codec and calls
`transport.produce()` with 3 simulcast encodings (rid r0/r1/r2) against the
patched worker:

```
RESULT: AV1 SIMULCAST ACCEPTED
producer id: bdfc3226-...
encodings: 3
```

The gate that previously threw `"video/AV1 codec not supported for simulcast"`
now accepts AV1 simulcast. (This validates the gate; full E2E encoding still
needs a real produce+consume test — the AV1 handler is untested upstream with
multiple RID simulcast encodings.)

## Build
Built in WSL (`snowwhite`, gcc/g++/make/python3) from mediasoup@3.19.19:
```bash
cd /tmp/ms-build && npm install mediasoup@3.19.19   # builds worker
# patch worker/include/RTC/RTP/Codecs/Tools.hpp (add AV1 to SIMULCAST)
cd node_modules/mediasoup/worker && make -j$(nproc)  # incremental rebuild
# output: worker/out/Release/mediasoup-worker
```
Binary: `mediasoup-worker-av1-simulcast` (sha256 c1f919ba…)

## Deployment to duper (restart-safe, reversible)
sharkord re-extracts its embedded worker to the **fixed** name `mediasoup-worker`
on every start (`loadEmbeds()` writes `getExecutableName('mediasoup-worker')`,
which does NOT honor the env var). But `createWorker()` spawns from
`SHARKORD_MEDIASOUP_BIN_NAME` (env-overridden). So:

1. Copy `mediasoup-worker-av1-simulcast` to duper's volume as
   `mediasoup-worker-av1` (container path `/home/bun/.config/sharkord/mediasoup/`,
   host path `/mnt/user/appdata/sharkord/mediasoup/`), chmod +x.
2. Set container env `SHARKORD_MEDIASOUP_BIN_NAME=mediasoup-worker-av1`.
3. Restart the `Sharkord-Custom` container.
4. loadEmbeds re-extracts the original to `mediasoup-worker` (untouched);
   sharkord spawns `mediasoup-worker-av1` (patched). Survives restarts.
5. Revert: unset the env var + restart.

## HEVC / H265 — NOT doable as a patch
mediasoup has **zero H265 support**: not in the codec subtype enum, no
packetizer/depacketizer, no codec handler (0 files mention h265/hevc in the
worker). Adding it requires implementing a new mediasoup codec module (RFC 7798
H.265 RTP packetization, NAL handling, keyframe detection, RTCP feedback) —
substantial upstream mediasoup C++ feature work, not a config or one-line patch.
The sharkord router also has no H265 entry; even if added, the worker can't
recognize it. Hardware CAN do HEVC (NVENC HEVC proven in loopback), but mediasoup
cannot transport it without that upstream work.
