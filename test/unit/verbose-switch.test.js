"use strict";
// Verbose logging shared between nodes: the NDI helper's lines are on while any node has the box ticked. Inside a real
// (embedded, loopback-only) Node-RED with the synthetic add-on: no NDI, no network. Its own file, because the editor's
// endpoints are registered once per Node-RED process.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
delete process.env.NDI_PREVIEW_RUNTIME;
const { startNodeRed, get, sleep, until } = require("../fixtures/nodered");

const SRC = "SYNTHETIC (Pattern)";
const AREAS = /\[(config|host|discovery|receiver|frame|http|live)\] /;
const thumb = (id, extra) => ({ id, type: "ndi-thumbnail", name: "node " + id, source: SRC, address: "", interval: 0, width: 320, quality: 70, bandwidth: "lowest", idle: 0, timeout: 1, wires: [["sink"]], ...extra });
const has = (nr, re) => nr.logs.some((l) => re.test(l));

// POST a whole flow to the embedded Node-RED's admin API (loopback), as the editor's Deploy button does
function deploy(nr, flows) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(flows);
    const req = http.request(`${nr.base}/admin/flows`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "Node-RED-Deployment-Type": "full" } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end(body);
  });
}

test("the NDI helper's lines stay on while one node wants them, and stop when that node is unticked or deleted", async () => {
  const nr = await startNodeRed([thumb("A", { verbose: true }), thumb("B")]);
  try {
    assert.ok(await until(() => has(nr, /\[host\] request #\d+ hello/), 8000), "on while A is ticked");
    // the probe: the editor's "Find sources", which the shared client logs once per request (no limiter)
    const probes = () => nr.logs.filter((l) => /\[http\] editor at \S+ asked for NDI sources/.test(l)).length;
    const probe = async () => { assert.strictEqual((await get(`${nr.base}/admin/ndi-preview/sources`)).status, 200); await sleep(200); };
    await probe();
    assert.strictEqual(probes(), 1, "logged while A wants verbose");
    nr.RED.nodes.getNode("B").receive({ payload: 1 });
    assert.ok(await until(() => nr.sink.some((m) => m.statusCode === 200), 6000));
    assert.ok(!has(nr, /\[frame\] still asked/), "B's own lines stay off");

    const flows = JSON.parse((await get(`${nr.base}/admin/flows`)).body.toString());
    const list = Array.isArray(flows) ? flows : flows.flows;
    assert.strictEqual(await deploy(nr, list.map((n) => (n.id === "A" ? { ...n, verbose: false } : n))), 204);
    assert.ok(await until(() => has(nr, /\[host\] verbose logging off: no node asks for it any more/), 4000), "the switch-off is said");
    await probe();
    assert.strictEqual(probes(), 1, "A unticked: nothing more");

    assert.strictEqual(await deploy(nr, list), 204);   // A ticked again
    assert.ok(await until(() => nr.logs.filter((l) => /\[host\] verbose logging on/.test(l)).length >= 2, 4000));
    await probe();
    assert.strictEqual(probes(), 2, "A ticked again: on again");
    const after = nr.logs.length;
    assert.strictEqual(await deploy(nr, list.filter((n) => n.id !== "A")), 204);   // A deleted
    assert.ok(await until(() => nr.logs.slice(after).some((l) => /\[config\] closing \(the node was deleted\)/.test(l)), 4000));
    const deleted = nr.logs.length;
    await probe();
    nr.RED.nodes.getNode("B").receive({ payload: 1 });
    await until(() => nr.sink.filter((m) => m.statusCode === 200).length >= 2, 6000);
    await sleep(300);
    assert.deepStrictEqual(nr.logs.slice(deleted).filter((l) => AREAS.test(l)), [], "A deleted: no verbose line");
  } finally {
    await nr.stop();
  }
});
