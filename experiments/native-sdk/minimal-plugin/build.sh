#!/bin/sh
# build.sh — build the ae-a8n minimal read-only AEGP probe plug-in
# (Issue #17, CAP038) into a .plugin bundle on macOS.
#
# This proves the *build/artifact* path only: plug-in load,
# registration and execution inside After Effects remain UNVERIFIED
# and require an authorized real-AE session (see ../LOAD-PROOF.md).
#
# Usage:
#   AE_SDK_ROOT=/path/to/AeSDK ./build.sh [outdir]
#
# AE_SDK_ROOT must point at the After Effects SDK distribution root
# (the directory containing Examples/). The SDK is operator-supplied
# and never vendored (see inventories/sdk/generated/provenance.json).
set -eu

SDK_ROOT="${AE_SDK_ROOT:-}"
if [ -z "$SDK_ROOT" ]; then
  echo "error: AE_SDK_ROOT is not set — point it at the local AE SDK root" >&2
  exit 2
fi
if [ ! -d "$SDK_ROOT/Examples/Headers" ]; then
  echo "error: $SDK_ROOT does not look like an AE SDK root (no Examples/Headers)" >&2
  exit 2
fi

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="${1:-$HERE/build}"
NAME=NativeProbe
PLUGIN="$OUT/$NAME.plugin"
WORK="$OUT/.build-work"

HEADERS="$SDK_ROOT/Examples/Headers"
RES="$SDK_ROOT/Examples/Resources"

rm -rf "$PLUGIN" "$WORK"
mkdir -p "$PLUGIN/Contents/MacOS" "$PLUGIN/Contents/Resources" "$WORK"

echo "=== compiling $NAME (C++, arm64 host) ==="
clang++ -std=c++17 -O2 -Wall -Wextra -Werror \
  -D__MACH__=1 \
  -I"$HEADERS" -I"$HEADERS/SP" \
  -c "$HERE/src/probe.cpp" -o "$WORK/probe.o" \
  > "$OUT/$NAME.compile.log" 2>&1 \
  || { echo "compile FAILED (see $OUT/$NAME.compile.log)"; exit 1; }

echo "=== linking $NAME.bundle ==="
clang -bundle -arch arm64 \
  -o "$PLUGIN/Contents/MacOS/$NAME" "$WORK/probe.o" \
  > "$OUT/$NAME.link.log" 2>&1 \
  || { echo "link FAILED (see $OUT/$NAME.link.log)"; exit 1; }

echo "=== compiling PiPL resource ==="
Rez -useDF -i "$HEADERS" -i "$RES" \
  -o "$PLUGIN/Contents/Resources/$NAME.rsrc" "$HERE/ProbePiPL.r" \
  > "$OUT/$NAME.rez.log" 2>&1 \
  || { echo "Rez FAILED (see $OUT/$NAME.rez.log)"; exit 1; }

cp "$HERE/plugin-Info.plist" "$PLUGIN/Contents/Info.plist"
printf 'AEgxFXTC' > "$PLUGIN/Contents/PkgInfo"

# Ad-hoc "Sign to Run Locally" — same posture as the SDK samples.
# Whether AE accepts ad-hoc signatures is UNVERIFIED until a real
# load test (see ../README.md verification-state table).
codesign --force --sign - "$PLUGIN" > "$OUT/$NAME.codesign.log" 2>&1 \
  || { echo "codesign FAILED (see $OUT/$NAME.codesign.log)"; exit 1; }

rm -rf "$WORK"
echo "=== $NAME.plugin built: $PLUGIN ==="
file "$PLUGIN/Contents/MacOS/$NAME"
