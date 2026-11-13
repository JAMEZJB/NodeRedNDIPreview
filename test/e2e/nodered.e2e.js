"use strict";
// END-TO-END, LOOPBACK ONLY: the real add-on and NDI Runtime against the test sender on 127.0.0.1.
// Started by test/e2e/run-mac.sh, which runs this inside test/e2e/loopback.sb with a loopback-only NDI
// configuration and passes the sender's address in E2E_SENDER (127.0.0.1:port).
const test = require("node:test");
const assert = require("node:assert");

const SENDER = process.env.E2E_SENDER || "";
if (!/^127\.0\.0\.1:\d+$/.test(SENDER)) throw new Error("E2E_SENDER must be a 127.0.0.1:port address (run test/e2e/run-mac.sh)");
if (!process.env.NDI_CONFIG_DIR) throw new Error("NDI_CONFIG_DIR must point at the loopback configuration (run test/e2e/run-mac.sh)");
delete process.env.NDI_PREVIEW_TEST_ADDON;
const { startNodeRed, get, sleep, until } = require("../fixtures/nodered");
const { getClient } = require("../../lib/host-client");

const isJpeg = (b) => Buffer.isBuffer(b) && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;
const countParts = (buf) => buf.toString("latin1").split("--ndipreviewframe\r\n").length - 1;

let nr;
test.before(async () => {
  nr = await startNodeRed([
    { id: "T1", type: "ndi-thumbnail", source: "", address: SENDER, interval: 1, width: 320, quality: 70, bandwidth: "lowest", idle: 30, timeout: 3, wires: [["sink"]] },
    { id: "T2", type: "ndi-thumbnail", source: "", address: "127.0.0.1:1", interval: 0, width: 320, quality: 70, bandwidth: "lowest", idle: 0, timeout: 1, wires: [["sink"]] },
    { id: "L1", type: "ndi-live", source: "", address: SENDER, fps: 10, width: 640, quality: 60, bandwidth: "lowest", maxViewers: 4, timeout: 5, wires: [["sink"]] },
  ]);
});
test.after(async () => { if (nr) await nr.stop(); });

test("the runtime loads", async () => {
  const rt = JSON.parse((await get(`${nr.base}/admin/ndi-preview/runtime`)).body);
  assert.strictEqual(rt.ok, true, JSON.stringify(rt));
  if (process.env.E2E_PIDFILE) require("fs").writeFileSync(process.env.E2E_PIDFILE, `${process.pid},${getClient(nr.RED).pid}`);
  console.log("# runtime:", rt.version);
});

test("stills from the proxy stream", async () => {
  const stills = () => nr.sink.filter((m) => m.statusCode === 200 && Buffer.isBuffer(m.payload));
  assert.ok(await until(() => stills().length >= 3, 15000), "three stills");
  const m = stills()[0];
  assert.ok(isJpeg(m.payload));
  assert.strictEqual(m.headers["content-type"], "image/jpeg");
  assert.strictEqual(m.ndi.thumbWidth, 320);
  assert.ok(m.ndi.width >= 320 && m.ndi.height >= 180, `${m.ndi.width}x${m.ndi.height}`);
  assert.strictEqual(m.ndi.connections, 1);
  console.log("# received", `${m.ndi.width}x${m.ndi.height}`, m.ndi.fourCC, `${m.ndi.fps} fps`, `${m.ndi.bytes} bytes`, `first grab ${m.ndi.grabMs} ms`);
});

test("a source that does not answer: one clear error", async () => {
  nr.RED.nodes.getNode("T2").receive({ payload: "go" });
  assert.ok(await until(() => nr.sink.some((m) => m.ndi && m.ndi.source === "127.0.0.1:1"), 20000));
  const m = nr.sink.find((x) => x.ndi && x.ndi.source === "127.0.0.1:1");
  assert.strictEqual(m.payload, null);
  assert.ok(m.ndi.error);
});

test("live Motion-JPEG preview, sharing the stills' receiver", async () => {
  const r = await get(`${nr.base}/api/ndi-live/L1.mjpg`, 2500);
  assert.strictEqual(r.status, 200);
  const parts = countParts(r.body);
  assert.ok(parts >= 12, `about 10 frames a second, got ${parts} in 2.5 s`);
  console.log("# live:", parts, "frames in 2.5 s,", r.body.length, "bytes");
  const client = getClient(nr.RED);
  const watching = get(`${nr.base}/api/ndi-live/L1.mjpg`, 1500);
  await sleep(700);
  const st = await client.status();
  assert.strictEqual(st.streams, 1);
  assert.strictEqual(st.receivers, 1, "one NDI receiver for the still and the live preview of the same source");
  await watching;
});

test("everything disconnects when nothing needs the source", async () => {
  const client = getClient(nr.RED);
  nr.RED.nodes.getNode("T1").receive({ payload: "stop" });
  let st = await client.status();
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && (st.streams || st.receivers)) { await sleep(250); st = await client.status(); }
  assert.strictEqual(st.streams, 0);
  assert.strictEqual(st.receivers, 0);
});

test("the source picker answers (discovery stays on loopback)", async () => {
  const r = await get(`${nr.base}/admin/ndi-preview/sources`);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(JSON.parse(r.body)));
});
