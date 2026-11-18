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

# SANITIZE=1 builds the same test binary with ASan+UBSan. Scoped to this
# C++ memory-safety surface (Issue #64 follow-up): the fake host
# intentionally never frees AE-owned-style handles, so leak detection
# is disabled — UAF/OOB/overflow are still fully checked.
SAN_FLAGS=""
if [ "${SANITIZE:-0}" = "1" ]; then
  SAN_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer"
  OUT="$HERE/build-test-asan"
  mkdir -p "$OUT"
fi

clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
  $SAN_FLAGS \
  -D__MACH__=1 \
  -I"$HEADERS" -I"$HEADERS/SP" -I"$HERE" \
  "$HERE/../src/probe.cpp" "$HERE/fake_host.cpp" "$HERE/test_main.cpp" \
  -o "$OUT/probe_test"

if [ "${SANITIZE:-0}" = "1" ]; then
  ASAN_OPTIONS=detect_leaks=0 "$OUT/probe_test"
else
  "$OUT/probe_test"
fi
