#!/bin/bash
# The gate: run before every hand-over and release.
#
#   scripts/check.sh            everything this computer can run
#   scripts/check.sh --unit     syntax and unit tests only (no NDI, no native build; any OS)
#
# Options: --runtimes "<dylib> <dylib>"   the NDI runtimes for the macOS end-to-end test
#          (default: /usr/local/lib/libndi.dylib, plus the NDI SDK's own runtime when the SDK is installed)
#
# Every test runs under a process cap and a time limit, and under the loopback network guard (test/netguard.js).
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE" || exit 1
MODE=full
RUNTIMES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --unit) MODE=unit ;;
    --runtimes) shift; RUNTIMES="${1:-}" ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# a process cap for everything below, and a time limit for the whole gate (macOS has no `timeout`)
ulimit -u $(( $(ps -u "$(id -u)" | wc -l) + 150 )) 2>/dev/null || true
LIMIT_S=900
# one process, holding none of the gate's output open; it ends the whole gate if the limit is reached
perl -e 'sleep shift; kill "TERM", -getpgrp()' "$LIMIT_S" </dev/null >/dev/null 2>&1 &
WATCHDOG=$!
trap 'kill "$WATCHDOG" 2>/dev/null' EXIT

FAILED=0
step() { echo; echo "=== $*"; }
fail() { echo "FAIL: $*"; FAILED=1; }

step "package.json: no runtime dependencies"
node -e '
  const p = require("./package.json");
  const bad = ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"].filter((k) => p[k] && Object.keys(p[k]).length);
  if (bad.length) { console.error("has " + bad.join(", ")); process.exit(1); }
  for (const [k, v] of Object.entries(p.devDependencies || {})) if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error("dev dependency not pinned exactly: " + k + "@" + v); process.exit(1); }
  console.log("ok");' || fail "package.json"

step "syntax"
for f in $(git ls-files -co --exclude-standard -- '*.js'); do node --check "$f" || fail "syntax: $f"; done
echo "ok"

step "vendored encoder is byte-identical to jpeg-js 0.4.4"
SUM=$(shasum -a 256 lib/vendor/jpeg-encoder.js | awk '{print $1}')
[ "$SUM" = "00bde8df2517eca556669ab6fc27b414e9ba3fc52a0a71e1e37ec7c5f19c3d34" ] && echo ok || fail "lib/vendor/jpeg-encoder.js changed ($SUM)"

step "unit tests (synthetic add-on, no NDI, loopback guard)"
REPORT="$(mktemp "${TMPDIR:-/tmp}/ndi-preview-netguard.XXXXXX")"
NETGUARD_REPORT="$REPORT" NODE_OPTIONS="-r $HERE/test/netguard.js" node --test test/unit/*.test.js || fail "unit tests"
if [ -s "$REPORT" ]; then fail "network guard violations:"; cat "$REPORT"; fi
rm -f "$REPORT"
if pgrep -f "$HERE/lib/host.js" >/dev/null; then fail "an NDI host process was left running"; pkill -f "$HERE/lib/host.js"; fi

if [ "$MODE" = unit ]; then
  [ $FAILED -eq 0 ] && echo && echo "GATE (unit) PASS" || echo "GATE (unit) FAIL"
  exit $FAILED
fi

step "native add-on: contains no NDI code and links no NDI library"
if [ "$(uname)" = Darwin ]; then
  ADDON=prebuilds/darwin-universal/ndi_preview.node
  if [ ! -f "$ADDON" ]; then fail "$ADDON missing (npm run build)"; else
    lipo -archs "$ADDON" | grep -q "x86_64" && lipo -archs "$ADDON" | grep -q "arm64" || fail "$ADDON is not universal"
    otool -L "$ADDON" | grep -v ':$' | grep -qi ndi && fail "$ADDON links an NDI library"
    nm -u "$ADDON" | grep -qi ndilib && fail "$ADDON references NDI symbols"
    echo "ok: $(lipo -archs "$ADDON"), links: $(otool -L "$ADDON" | grep -v ':$' | awk '{print $1}' | sort -u | tr '\n' ' ')"
  fi
fi
if [ -f prebuilds/win32-x64/ndi_preview.node ]; then
  # the runtime DLL is loaded by path at run time: it must not be an import of the add-on
  IMPORTS=$(objdump -p prebuilds/win32-x64/ndi_preview.node 2>/dev/null | awk '/DLL Name:/ {print $3}' | sort -u | tr '\n' ' ')
  echo "$IMPORTS" | grep -qi ndi && fail "the Windows add-on imports an NDI DLL ($IMPORTS)"
  echo "ok: Windows x64 add-on, imports: ${IMPORTS:-unknown (no objdump)}"
else
  echo "note: prebuilds/win32-x64/ndi_preview.node is not here (built on Windows)"
fi

step "npm package contents"
PACK="$(mktemp "${TMPDIR:-/tmp}/ndi-preview-pack.XXXXXX")"
npm pack --dry-run --json --ignore-scripts > "$PACK" 2>/dev/null || fail "npm pack"
node -e '
  const files = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0].files.map((f) => f.path);
  const must = ["package.json", "README.md", "LICENSE.md", "THIRD-PARTY-NOTICES.md", "CHANGELOG.md",
    "nodes/ndi-thumbnail.js", "nodes/ndi-thumbnail.html", "nodes/ndi-live.js", "nodes/ndi-live.html",
    "lib/host.js", "lib/host-client.js", "lib/vendor/jpeg-encoder.js", "lib/vendor/jpeg-js.LICENSE", "lib/vendor/PROVENANCE.md"];
  const forbidden = [/(^|\/)test\//, /^native\//, /processing\.ndi/i, /libndi/i, /\.(h|dylib|dll|so|lib|pdb)$/i,
    /ndi-config\.v1\.json$/, /(^|\/)\.env/, /\.npmrc$/, /node_modules/];
  let bad = 0;
  for (const m of must) if (!files.includes(m)) { console.error("missing from the package: " + m); bad = 1; }
  for (const f of files) for (const re of forbidden) if (re.test(f)) { console.error("must not be in the package: " + f); bad = 1; }
  const addons = files.filter((f) => f.endsWith(".node"));
  console.log(files.length + " files; add-ons: " + (addons.join(", ") || "none"));
  if (!addons.includes("prebuilds/darwin-universal/ndi_preview.node")) { console.error("the macOS add-on is missing"); bad = 1; }
  if (!addons.includes("prebuilds/win32-x64/ndi_preview.node")) console.log("note: the Windows x64 add-on is not in this package yet");
  process.exit(bad);' "$PACK" || fail "package contents"
rm -f "$PACK"

step "end-to-end (macOS, loopback only)"
if [ "$(uname)" != Darwin ]; then
  echo "skip: macOS only"
elif ! command -v sandbox-exec >/dev/null; then
  fail "sandbox-exec not found"
else
  if [ -z "$RUNTIMES" ]; then
    RUNTIMES="/usr/local/lib/libndi.dylib"
    SDKRT="/Library/NDI SDK for Apple/lib/macOS/libndi.dylib"
  fi
  ARGS=()
  for r in $RUNTIMES; do [ -f "$r" ] && ARGS+=("$r"); done
  [ -n "${SDKRT:-}" ] && [ -f "$SDKRT" ] && ARGS+=("$SDKRT")
  if [ ${#ARGS[@]} -eq 0 ]; then
    echo "skip: no NDI Runtime installed here"
  else
    [ -x native/build/darwin/ndi_test_sender ] || bash native/build-mac.sh >/dev/null || fail "build"
    bash test/e2e/run-mac.sh "${ARGS[@]}" || fail "end-to-end"
  fi
fi
if pgrep -f "ndi_test_sender|$HERE/lib/host.js" >/dev/null; then fail "a test process was left running"; fi

echo
[ $FAILED -eq 0 ] && echo "GATE PASS" || echo "GATE FAIL"
exit $FAILED
