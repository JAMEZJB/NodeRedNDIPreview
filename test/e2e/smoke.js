"use strict";
// Smoke test of the REAL add-on and NDI Runtime through the NDI host, on any supported OS (used on Windows, where
// there is no loopback sandbox for a test sender). LOOPBACK ONLY: run it with NDI_CONFIG_DIR pointing at
// test/e2e/ndi-config (loopback discovery, no multicast) and the network guard preloaded:
//   NDI_CONFIG_DIR=test/e2e/ndi-config NODE_OPTIONS="-r ./test/netguard.js" node test/e2e/smoke.js
// It loads the runtime, asks a receiver for a source that does not exist on 127.0.0.1, runs one short discovery
// (pointed at loopback by the configuration), and checks that nothing crashes and every error is readable.
const assert = require("assert");
const path = require("path");

if (!process.env.NDI_CONFIG_DIR) { console.error("set NDI_CONFIG_DIR to test/e2e/ndi-config (loopback only)"); process.exit(2); }
delete process.env.NDI_PREVIEW_TEST_ADDON;
const { HostClient } = require("../../lib/host-client");

(async () => {
  const c = new HostClient({ log: { info: (s) => console.log("info:", s), warn: (s) => console.log("warn:", s) } });
  try {
    const rt = await c.runtime();
    console.log("runtime:", JSON.stringify(rt));
    assert.ok(rt.ok, "the NDI Runtime loads");
    const t0 = Date.now();
    await assert.rejects(
      c.grab({ owner: "smoke", source: { address: "127.0.0.1:1" }, timeoutMs: 1500, idleMs: 0 }),
      (e) => { console.log("no source:", e.message, `(${Date.now() - t0} ms)`); return /source not found|no video/.test(e.message); });
    const list = await c.sources(800);
    console.log("discovery (loopback):", JSON.stringify(list));
    assert.ok(Array.isArray(list));
    const st = await c.status();
    console.log("status:", JSON.stringify({ receivers: st.receivers, streams: st.streams }));
    console.log("SMOKE PASS");
  } catch (e) {
    console.log("SMOKE FAIL:", e.message);
    process.exitCode = 1;
  } finally {
    await c.stop();
  }
})();
