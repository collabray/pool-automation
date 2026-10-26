#!/bin/sh
# Builds and runs the portable firmware tests with g++ (address + undefined-behaviour sanitizers). Use `pio test -e native` if you have PlatformIO.
set -e
cd "$(dirname "$0")/.."
OUT=${TMPDIR:-/tmp}/pooltable-native-tests
g++ -std=c++17 -Wall -Wextra -Wno-misleading-indentation -Werror -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=undefined \
  -Itools/unity_shim -Ilib/pooltable_core -Itest/test_native \
  test/test_native/test_main.cpp lib/pooltable_core/sha256.cpp lib/pooltable_core/protocol.cpp lib/pooltable_core/vend_sequencer.cpp lib/pooltable_core/device_core.cpp \
  -o "$OUT"
"$OUT"
