#!/bin/sh
# build-macos.sh — reproducible macOS build probe for the AE SDK samples
# (Issue #17 CAP037 / Issue #18 CAP042 groundwork).
#
# Builds one AEGP sample and one CPU-only Effect sample with xcodebuild.
# This proves the *build* path only: plugin load/registration inside AE is
# a separate real-host gate (CAP040/CAP042) that this script does not claim.
#
# Usage:
#   AE_SDK_ROOT=/path/to/AeSDK ./build-macos.sh [outdir]
#
# AE_SDK_ROOT must point at the After Effects SDK distribution root
# (the directory containing Examples/). The SDK is never vendored; the
# operator supplies it locally (see inventories/sdk/generated/provenance.json).
set -eu

SDK_ROOT="${AE_SDK_ROOT:-}"
if [ -z "$SDK_ROOT" ]; then
  echo "error: AE_SDK_ROOT is not set — point it at the local AE SDK root" >&2
  exit 2
fi
if [ ! -d "$SDK_ROOT/Examples" ]; then
  echo "error: $SDK_ROOT does not look like an AE SDK root (no Examples/)" >&2
  exit 2
fi

OUT="${1:-./build}"
mkdir -p "$OUT"

build() {
  name="$1"; proj="$2"
  echo "=== building $name ==="
  xcodebuild -project "$proj" -scheme "$name" -configuration Debug \
    -derivedDataPath "$OUT/dd-$name" build \
    > "$OUT/$name.build.log" 2>&1 \
    && echo "$name: BUILD SUCCEEDED" \
    || { echo "$name: BUILD FAILED (see $OUT/$name.build.log)"; return 1; }
  # Report the produced bundle without copying SDK-derived artifacts into
  # the repo — paths only, for the evidence record.
  find "$OUT/dd-$name" -name "*.plugin" -type d | head -3
}

FAILED=0
build Sweetie "$SDK_ROOT/Examples/AEGP/Sweetie/Mac/Sweetie.xcodeproj" || FAILED=1
build Checkout "$SDK_ROOT/Examples/Effect/Checkout/Mac/Checkout.xcodeproj" || FAILED=1
exit "$FAILED"
