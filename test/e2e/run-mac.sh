#!/bin/bash
# End-to-end test on macOS, LOOPBACK ONLY, against each NDI runtime given (default: the installed one).
#
# Two fences keep every NDI packet on this computer, even when it is connected to a live network:
#   1. every NDI process (the test sender, Node-RED and its NDI host) runs inside test/e2e/loopback.sb, a macOS
#      sandbox that denies all outbound traffic except to loopback, and denies the Bonjour (mDNS) daemon;
#   2. NDI_CONFIG_DIR points the NDI Runtime at test/e2e/ndi-config: loopback discovery, loopback adapter only,
#      no multicast.
# The JavaScript network guard (test/netguard.js) is loaded too.
#
# usage: test/e2e/run-mac.sh [runtime.dylib ...]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$HERE/test/e2e/loopback.sb"
SENDER_BIN="$HERE/native/build/darwin/ndi_test_sender"
export NDI_CONFIG_DIR="$HERE/test/e2e/ndi-config"
[ "$(uname)" = Darwin ] || { echo "skip: the end-to-end test needs macOS (sandbox-exec)"; exit 0; }
[ -x "$SENDER_BIN" ] || { echo "FAIL: build first (npm run build)"; exit 1; }
[ -f "$HERE/prebuilds/darwin-universal/ndi_preview.node" ] || { echo "FAIL: build first (npm run build)"; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ndi-preview-e2e.XXXXXX")"
SPID=""
cleanup() { [ -n "$SPID" ] && kill "$SPID" 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

RUNTIMES=("$@")
[ ${#RUNTIMES[@]} -gt 0 ] || RUNTIMES=(/usr/local/lib/libndi.dylib)

FAILED=0
for RT in "${RUNTIMES[@]}"; do
  echo "=== runtime: $RT"
  if [ ! -f "$RT" ]; then echo "FAIL: no runtime at $RT"; FAILED=1; continue; fi
  export NDI_PREVIEW_RUNTIME="$RT"
  NDI_PREVIEW_RUNTIME="$RT" sandbox-exec -f "$SB" "$SENDER_BIN" "NDI Preview Test Pattern" 1280 720 25 > "$WORK/sender.log" 2>&1 &
  SPID=$!
  PORT=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    PORT=$(lsof -nP -a -p "$SPID" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{n=split($9,a,":"); print a[n]}' | sort -n | tail -1)
    [ -n "$PORT" ] && break
  done
  if [ -z "$PORT" ]; then echo "FAIL: the test sender is not listening"; cat "$WORK/sender.log"; FAILED=1; kill "$SPID" 2>/dev/null; SPID=""; continue; fi
  echo "sender pid $SPID on 127.0.0.1:$PORT"
  : > "$WORK/sockets.txt"
  E2E_SENDER="127.0.0.1:$PORT" E2E_PIDFILE="$WORK/hostpid" NETGUARD_REPORT="$WORK/netguard.jsonl" \
    NODE_OPTIONS="-r $HERE/test/netguard.js" sandbox-exec -f "$SB" node --test "$HERE/test/e2e/nodered.e2e.js" &
  TPID=$!
  # sample every NDI process's sockets once a second while the test runs
  while kill -0 "$TPID" 2>/dev/null; do
    PIDS="$SPID,$TPID"; [ -s "$WORK/hostpid" ] && PIDS="$PIDS,$(cat "$WORK/hostpid")"
    lsof -nP -a -p "$PIDS" -i 2>/dev/null | awk 'NR>1{print $1, $2, $8, $9, $10}' >> "$WORK/sockets.txt"
    sleep 1
  done
  wait "$TPID" || FAILED=1
  if [ -s "$WORK/netguard.jsonl" ]; then echo "FAIL: network guard violations:"; cat "$WORK/netguard.jsonl"; FAILED=1; fi
  # any connection to or from an address that is not loopback fails the run
  BAD=$(awk '$4 ~ /->/ {split($4, e, "->"); if (e[2] !~ /^(127\.0\.0\.1|\[::1\]):/) print}' "$WORK/sockets.txt" | sort -u)
  if [ -n "$BAD" ]; then echo "FAIL: non-loopback connections:"; echo "$BAD"; FAILED=1; fi
  echo "sockets seen (sampled $(wc -l < "$WORK/sockets.txt" | tr -d ' ') lines): $(awk '$4 ~ /->/' "$WORK/sockets.txt" | wc -l | tr -d ' ') loopback connections, listeners:"
  awk '$5 == "(LISTEN)" {print "  " $1, $4}' "$WORK/sockets.txt" | sort -u
  kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; SPID=""
done

echo "=== runtime missing"
OUT=$(NDI_PREVIEW_RUNTIME=/nonexistent/libndi.dylib sandbox-exec -f "$SB" node -e '
  const a = require(process.argv[1]); const r = a.load(process.env.NDI_PREVIEW_RUNTIME);
  console.log(JSON.stringify(r)); process.exit(r.ok === false && /could not load/.test(r.error) && r.url ? 0 : 1);' \
  "$HERE/prebuilds/darwin-universal/ndi_preview.node") || FAILED=1
echo "$OUT"

[ $FAILED -eq 0 ] && echo "E2E PASS" || echo "E2E FAIL"
exit $FAILED
