"use strict";
// Both nodes inside a real (embedded, loopback-only) Node-RED, with the synthetic add-on: no NDI, no network.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
delete process.env.NDI_PREVIEW_RUNTIME;
const { startNodeRed, get, sleep, until } = require("../fixtures/nodered");
const { getClient } = require("../../lib/host-client");

const SRC = "SYNTHETIC (Pattern)";
const isJpeg = (b) => Buffer.isBuffer(b) && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;
const countParts = (buf) => buf.toString("latin1").split("--ndipreviewframe\r\n").length - 1;

let nr;
test.before(async () => {
  nr = await startNodeRed([
    { id: "T1", type: "ndi-thumbnail", name: "timer", source: SRC, address: "", interval: 1, width: 320, quality: 70, bandwidth: "lowest", idle: 30, timeout: 2, wires: [["sink"]] },
    { id: "T2", type: "ndi-thumbnail", name: "no video", source: "synthetic-novideo", address: "", interval: 0, width: 320, quality: 70, bandwidth: "lowest", idle: 0, timeout: 0.5, wires: [["sink"]] },
    { id: "L1", type: "ndi-live", name: "live", source: SRC, address: "", fps: 10, width: 320, quality: 60, bandwidth: "lowest", maxViewers: 2, timeout: 5, wires: [["sink"]] },
  ]);
});
test.after(async () => { if (nr) await nr.stop(); });

test("ndi-thumbnail sends JPEG stills shaped like an http request reply", async () => {
  const stills = () => nr.sink.filter((m) => m.statusCode === 200 && m.ndi && m.ndi.source === SRC);
  assert.ok(await until(() => stills().length >= 2, 6000), "two stills");
  const m = stills()[0];
  assert.ok(isJpeg(m.payload));
  assert.strictEqual(m.statusCode, 200);
  assert.strictEqual(m.headers["content-type"], "image/jpeg");
  assert.strictEqual(m.ndi.thumbWidth, 320);
  assert.strictEqual(m.ndi.runtime, "synthetic 6.0");
  assert.ok(nr.statuses.some((s) => s.id === "T1" && s.fill === "green"));
});

test("ndi-thumbnail reports a source without video, once", async () => {
  nr.RED.nodes.getNode("T2").receive({ payload: "go" });
  assert.ok(await until(() => nr.sink.some((m) => m.ndi && m.ndi.source === "synthetic-novideo"), 15000));
  const m = nr.sink.find((x) => x.ndi && x.ndi.source === "synthetic-novideo");
  assert.strictEqual(m.payload, null);
  assert.match(m.ndi.error, /no video/);
  assert.strictEqual(m.ndi.misses, 1);
});

test("ndi-live announces where its preview is", async () => {
  assert.ok(await until(() => nr.sink.some((m) => m.payload === "/api/ndi-live/L1.mjpg"), 5000));
  const m = nr.sink.find((x) => x.payload === "/api/ndi-live/L1.mjpg");
  assert.strictEqual(m.ndi.still, "/api/ndi-live/L1.jpg");
  assert.strictEqual(m.ndi.maxViewers, 2);
});

test("ndi-live streams Motion-JPEG, limits viewers, and serves a still", async () => {
  const url = `${nr.base}/api/ndi-live/L1.mjpg`;
  const [a, b] = await Promise.all([get(url, 1500), get(url, 1500), (async () => {
    await sleep(500);
    const c = await get(url);                         // a third viewer while two are watching
    assert.strictEqual(c.status, 503);
    assert.match(c.body.toString(), /already has 2 viewers/);
  })()]);
  for (const r of [a, b]) {
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /^multipart\/x-mixed-replace; boundary=ndipreviewframe/);
    assert.strictEqual(r.headers["cache-control"], "no-store, no-cache, must-revalidate");
    const parts = countParts(r.body);
    assert.ok(parts >= 6, `about 10 frames a second, got ${parts} in 1.5 s`);
  }
  const first = a.body.indexOf(Buffer.from([0xff, 0xd8]));
  assert.ok(first > 0, "a JPEG inside the stream");
  const still = await get(`${nr.base}/api/ndi-live/L1.jpg`);
  assert.strictEqual(still.status, 200);
  assert.strictEqual(still.headers["content-type"], "image/jpeg");
  assert.ok(isJpeg(still.body));
  assert.strictEqual((await get(`${nr.base}/api/ndi-live/nope.mjpg`)).status, 404);
  assert.strictEqual((await get(`${nr.base}/api/ndi-live/..%2Fsecret.mjpg`)).status, 404);
});

test("ndi-live stops receiving a few seconds after the last viewer leaves", async () => {
  const client = getClient(nr.RED);
  await get(`${nr.base}/api/ndi-live/L1.mjpg`, 600);
  assert.strictEqual((await client.status()).streams, 1);
  let streams = 1;
  const t0 = Date.now();
  while (Date.now() - t0 < 9000 && streams > 0) { await sleep(250); streams = (await client.status()).streams; }
  assert.strictEqual(streams, 0, "stopped after the grace time");
  assert.ok(Date.now() - t0 >= 3500, "not before the grace time");
});

test("ndi-live stop ends viewers and refuses new ones; start allows them again", async () => {
  const url = `${nr.base}/api/ndi-live/L1.mjpg`;
  const watching = get(url, 4000);
  await sleep(500);
  nr.RED.nodes.getNode("L1").receive({ payload: "stop" });
  const r = await watching;
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await get(url)).status, 503);
  nr.RED.nodes.getNode("L1").receive({ payload: "start" });
  const again = await get(url, 800);
  assert.strictEqual(again.status, 200);
  assert.ok(countParts(again.body) >= 2);
});

test("the editor's endpoints: runtime and source discovery", async () => {
  const rt = JSON.parse((await get(`${nr.base}/admin/ndi-preview/runtime`)).body);
  assert.strictEqual(rt.ok, true);
  assert.strictEqual(rt.version, "synthetic 6.0");
  const list = JSON.parse((await get(`${nr.base}/admin/ndi-preview/sources`)).body);
  assert.deepStrictEqual(list, [{ name: SRC, address: "127.0.0.1:5961" }]);
});
