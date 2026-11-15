#!/bin/sh
# run_tests.sh — build and run the NativeProbe mock-host unit tests.
#
# Compiles the REAL src/probe.cpp plus the fake AEGP host
# (fake_host.*) and test_main.cpp with the host clang++, links a plain
# executable and runs it. No After Effects, no GUI, no .plugin bundle.
#
# Requires AE_SDK_ROOT only for the SDK *headers* (compile-time
# contract); the SDK itself is never executed or copied.
#
# Usage:  AE_SDK_ROOT=/path/to/AeSDK ./run_tests.sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SDK_ROOT="${AE_SDK_ROOT:-}"
if [ -z "$SDK_ROOT" ] || [ ! -d "$SDK_ROOT/Examples/Headers" ]; then
  echo "error: AE_SDK_ROOT must point at an AE SDK root (Examples/Headers)" >&2
  exit 2
fi

HEADERS="$SDK_ROOT/Examples/Headers"
OUT="$HERE/build-test"
mkdir -p "$OUT"

clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -D__MACH__=1 \
  -I"$HEADERS" -I"$HEADERS/SP" -I"$HERE" \
  "$HERE/../src/probe.cpp" "$HERE/fake_host.cpp" "$HERE/test_main.cpp" \
  -o "$OUT/probe_test"

"$OUT/probe_test"
