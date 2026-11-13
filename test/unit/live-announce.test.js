"use strict";
// ndi-live tells the flow about the NDI Runtime when the flow starts, and again whenever that answer changes:
// a helper that answers late, or a helper that stops. Embedded Node-RED (loopback only) with the synthetic add-on.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
delete process.env.NDI_PREVIEW_RUNTIME;
const { HostClient, getClient } = require("../../lib/host-client");

// The first runtime check meets a helper that does not answer (a transient problem); later checks are real.
const realRuntime = HostClient.prototype.runtime;
let hiccups = 1;
HostClient.prototype.runtime = function (opts) {
  if (hiccups > 0) { hiccups--; return Promise.resolve({ ok: false, host: true, error: "synthetic: the helper did not answer" }); }
  return realRuntime.call(this, opts);
};

const { startNodeRed, until } = require("../fixtures/nodered");
const SRC = "SYNTHETIC (Pattern)";

let nr;
test.before(async () => {
  nr = await startNodeRed([
    { id: "L1", type: "ndi-live", name: "live", source: SRC, address: "", fps: 10, width: 320, quality: 60, bandwidth: "lowest", maxViewers: 2, timeout: 5, wires: [["sink"]] },
  ]);
});
test.after(async () => { if (nr) await nr.stop(); HostClient.prototype.runtime = realRuntime; });

const announces = () => nr.sink.filter((m) => m.ndi && m.ndi.stream);   // no input is sent here

test("a late helper: first 'still checking', then the runtime, each said once", async () => {
  assert.ok(await until(() => announces().length >= 1, 3000), "the first announce");
  const first = announces()[0];
  assert.strictEqual(first.payload, "/api/ndi-live/L1.mjpg");
  assert.strictEqual(first.ndi.runtime, null, "not known yet");
  assert.ok(!("error" in first.ndi), "no error: still checking, not 'not installed'");
  assert.ok(await until(() => announces().length >= 2, 15000), "a second announce once the helper answers");
  const second = announces()[1];
  assert.strictEqual(second.ndi.runtime, "synthetic 6.0");
  assert.ok(!("error" in second.ndi));
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(announces().length, 2, "nothing more while nothing changes");
});

test("a helper that stops: one more announce, with the error", async () => {
  getClient(nr.RED).emit("state", "failed", "synthetic: the helper crashed too often");
  assert.ok(await until(() => announces().length >= 3, 2000));
  const third = announces()[2];
  assert.match(third.ndi.error, /NDI helper has stopped/);
  getClient(nr.RED).emit("state", "failed", "synthetic: again");
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(announces().length, 3, "the same answer is not repeated");
});
