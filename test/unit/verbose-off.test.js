"use strict";
// Verbose logging switched off (a flow saved without the setting, or with it unticked), inside a real (embedded, loopback-only) Node-RED with the synthetic add-on: no NDI, no network.
// Lines the nodes write through node.log / RED.log are captured by the test harness (test/fixtures/nodered.js).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
delete process.env.NDI_PREVIEW_RUNTIME;
const { startNodeRed, get, sleep, until } = require("../fixtures/nodered");

const SRC = "SYNTHETIC (Pattern)";
const AREAS = /\[(config|host|discovery|receiver|frame|http|live)\] /;
const thumb = (id, extra) => ({ id, type: "ndi-thumbnail", name: "node " + id, source: SRC, address: "", interval: 0, width: 320, quality: 70, bandwidth: "lowest", idle: 0, timeout: 1, wires: [["sink"]], ...extra });
const live = (id, extra) => ({ id, type: "ndi-live", name: "node " + id, source: SRC, address: "", fps: 10, width: 320, quality: 60, bandwidth: "lowest", maxViewers: 2, timeout: 2, wires: [["sink"]], ...extra });
const has = (nr, re) => nr.logs.some((l) => re.test(l));
const ours = (nr) => nr.logs.filter((l) => AREAS.test(l));

test("verbose off: the same things write none of the verbose lines, and warnings keep their cause", async () => {
  const nr = await startNodeRed([
    thumb("Q1"),
    thumb("Q2", { verbose: false, source: "synthetic-novideo" }),
    live("QL"),
  ]);
  try {
    assert.ok(await until(() => nr.statuses.some((x) => x.id === "Q1" && x.text !== "checking for the NDI Runtime"), 8000), "the runtime check finished");
    nr.RED.nodes.getNode("Q1").receive({ payload: "placeholder", topic: "q" });
    assert.ok(await until(() => nr.sink.some((m) => m.statusCode === 200), 6000));
    nr.RED.nodes.getNode("Q2").receive({ payload: 1 });
    assert.ok(await until(() => has(nr, /NDI "synthetic-novideo": connected, but no video arrived/), 8000), "the warning, with its cause");
    await get(`${nr.base}/api/ndi-live/QL.mjpg`, 1200);
    await get(`${nr.base}/admin/ndi-preview/sources`);
    await sleep(300);
    assert.deepStrictEqual(ours(nr), [], "no verbose line");
    assert.ok(!nr.logs.some((l) => /\[ndi-preview\] \[/.test(l)));
  } finally {
    await nr.stop();
  }
});

test("with no NDI Runtime, the handshake says so instead of 'ok'", async () => {
  process.env.NDI_PREVIEW_RUNTIME = "/synthetic/missing/libndi";   // the stand-in add-on reports no runtime for this
  const nr = await startNodeRed([thumb("N", { verbose: true })]);
  try {
    assert.ok(await until(() => has(nr, /\[host\] request #\d+ hello -> answered: no NDI Runtime \(synthetic: the NDI Runtime is not installed\)/), 8000));
    assert.ok(!has(nr, /hello -> ok \(no NDI Runtime/));
  } finally {
    delete process.env.NDI_PREVIEW_RUNTIME;
    await nr.stop();
  }
});
