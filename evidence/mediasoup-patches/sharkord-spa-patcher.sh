#!/bin/bash
# Idempotent sharkord SPA bundle patcher — makes the simulcast codec honor the
# screenCodec device pref instead of hardcoding VP8.
# Safe to run repeatedly: only patches if the original (unpatched) form is found.
# Designed to run from cron every minute so the patch survives container restarts
# (the container re-extracts interface.zip on start, overwriting the patch).
set -e
IFACE=/mnt/user/appdata/sharkord/interface
# Find the currently-served bundle from the latest version dir's index.html
LATEST=$(ls -dv $IFACE/*/ 2>/dev/null | tail -1)
[ -z "$LATEST" ] && { echo "no interface version dir"; exit 0; }
BUNDLE=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$LATEST/index.html" 2>/dev/null | head -1 | sed 's|^/assets/||')
[ -z "$BUNDLE" ] && { echo "no bundle ref in $LATEST/index.html"; exit 0; }
SPA="$LATEST/assets/$BUNDLE"
[ ! -f "$SPA" ] && { echo "bundle not found: $SPA"; exit 0; }

# Idempotent: only patch if the ORIGINAL (unpatched) eo form is present.
if grep -q 'eo=C?CB(i.current):void 0' "$SPA"; then
  cp "$SPA" "$SPA.bak.cronpatch.$(date +%s)" 2>/dev/null || true
  perl -i -pe 's/eo=C\?CB\(i\.current\):void 0/eo=C?(N.screenCodec\&\&N.screenCodec!==Hi.AUTO\&\&i.current?.codecs?(i.current.codecs.find(ea=>ea.mimeType.toLowerCase()===N.screenCodec.toLowerCase())||CB(i.current)):CB(i.current)):void 0/g' "$SPA"
  if grep -q 'eo=C?(N.screenCodec&&N.screenCodec!==Hi.AUTO' "$SPA"; then
    echo "$(date -Is) PATCHED $BUNDLE (simulcast codec now honors screenCodec)"
  else
    echo "$(date -Is) PATCH FAILED for $BUNDLE"
  fi
else
  # already patched (or unknown form) — do nothing
  echo "$(date -Is) already patched (or unrecognized): $BUNDLE"
fi
