"use strict";
// Without the NDI Runtime the nodes say so clearly, send no pictures, and never crash.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
process.env.NDI_PREVIEW_RUNTIME = "/synthetic/missing/libndi";
const { startNodeRed, get, sleep, until } = require("../fixtures/nodered");

let nr;
test.before(async () => {
  nr = await startNodeRed([
    { id: "T1", type: "ndi-thumbnail", source: "SYNTHETIC (Pattern)", address: "", interval: 1, width: 320, quality: 70, bandwidth: "lowest", idle: 30, timeout: 2, wires: [["sink"]] },
    { id: "L1", type: "ndi-live", source: "SYNTHETIC (Pattern)", address: "", fps: 10, width: 320, quality: 60, bandwidth: "lowest", maxViewers: 2, timeout: 5, wires: [["sink"]] },
  ]);
});
test.after(async () => { if (nr) await nr.stop(); });

test("both nodes show 'NDI Runtime not installed' and send no pictures", async () => {
  const notInstalled = (id) => nr.statuses.some((s) => s.id === id && /NDI Runtime not installed \(see ndi\.video\)/.test(s.text));
  assert.ok(await until(() => notInstalled("T1") && notInstalled("L1"), 8000), JSON.stringify(nr.statuses));
  nr.RED.nodes.getNode("T1").receive({ payload: "now" });
  await sleep(2500);
  assert.strictEqual(nr.sink.filter((m) => Buffer.isBuffer(m.payload)).length, 0, "no stills");
  const info = nr.sink.find((m) => m.payload === "/api/ndi-live/L1.mjpg");
  assert.ok(info, "the live node still says where it is");
  assert.match(info.ndi.error, /not installed/);
});

test("the live endpoint refuses with a reason, and the editor gets the install help", async () => {
  const r = await get(`${nr.base}/api/ndi-live/L1.mjpg`);
  assert.strictEqual(r.status, 503);
  assert.match(r.body.toString(), /NDI Runtime is not installed.*ndi\.video/);
  const rt = JSON.parse((await get(`${nr.base}/admin/ndi-preview/runtime`)).body);
  assert.strictEqual(rt.ok, false);
  assert.match(rt.help, /ndi\.video/);
  const s = await get(`${nr.base}/admin/ndi-preview/sources`);
  assert.strictEqual(s.status, 503);
});
