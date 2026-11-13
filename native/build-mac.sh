#!/bin/bash
# Build the add-on for macOS (one universal file, arm64 + x86_64) and the test-only loopback sender.
#
# Needs: Xcode Command Line Tools, Node.js (for its Node-API headers), and the NDI SDK for Apple from ndi.video
# (default /Library/NDI SDK for Apple, or set NDI_SDK_DIR). Only the SDK's HEADERS are used: nothing from the SDK is
# linked into or copied next to the output. No npm packages and no node-gyp are needed.
#
# Output: prebuilds/darwin-universal/ndi_preview.node   (shipped)
#         native/build/darwin/ndi_test_sender           (tests only, never shipped)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${NDI_SDK_DIR:-/Library/NDI SDK for Apple}"
NODE_INC="$(dirname "$(dirname "$(command -v node)")")/include/node"
[ -f "$NODE_INC/node_api.h" ] || { echo "node_api.h not found under $NODE_INC" >&2; exit 1; }
[ -f "$SDK/include/Processing.NDI.Lib.h" ] || { echo "NDI SDK headers not found in $SDK/include (install the NDI SDK from ndi.video, or set NDI_SDK_DIR)" >&2; exit 1; }
echo "NDI SDK: $(cat "$SDK/Version.txt" 2>/dev/null || echo unknown)"
OUT="$HERE/prebuilds/darwin-universal"
TOUT="$HERE/native/build/darwin"
mkdir -p "$OUT" "$TOUT"
FLAGS=(-std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -arch arm64 -arch x86_64 -mmacosx-version-min=11.0
       -I"$NODE_INC" -I"$SDK/include" -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=ndi_preview)
clang "${FLAGS[@]}" -bundle -undefined dynamic_lookup "$HERE/native/ndi_preview.c" -o "$OUT/ndi_preview.node"
clang "${FLAGS[@]}" "$HERE/test/e2e/sender.c" -o "$TOUT/ndi_test_sender"
file "$OUT/ndi_preview.node" "$TOUT/ndi_test_sender"

# The add-on must not link the NDI library, and must not reference any NDI symbol: the runtime is loaded with dlopen.
if otool -L "$OUT/ndi_preview.node" | grep -v ':$' | grep -i ndi; then echo "FAIL: the add-on links an NDI library" >&2; exit 1; fi
if nm -u "$OUT/ndi_preview.node" | grep -i ndilib; then echo "FAIL: the add-on references NDI symbols" >&2; exit 1; fi
echo "ok: linked libraries:"; otool -L "$OUT/ndi_preview.node" | grep -v ':$' | sort -u
