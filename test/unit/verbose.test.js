"use strict";
// Verbose logging, inside a real (embedded, loopback-only) Node-RED with the synthetic add-on: no NDI, no network.
// Lines the nodes write through node.log / RED.log are captured by the test harness (test/fixtures/nodered.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
delete process.env.NDI_PREVIEW_RUNTIME;
process.env.NDI_PREVIEW_TEST_SUMMARY_MS = "2000";    // the 10-second summaries, every 2 s here (test mode only)
const { startNodeRed, get, sleep, until } = require("../fixtures/nodered");
const { createVLog, short } = require("../../lib/vlog");

const SRC = "SYNTHETIC (Pattern)";
const ROOT = path.join(__dirname, "..", "..");
const AREAS = /\[(config|host|discovery|receiver|frame|http|live)\] /;
const thumb = (id, extra) => ({ id, type: "ndi-thumbnail", name: "node " + id, source: SRC, address: "", interval: 0, width: 320, quality: 70, bandwidth: "lowest", idle: 0, timeout: 1, wires: [["sink"]], ...extra });
const live = (id, extra) => ({ id, type: "ndi-live", name: "node " + id, source: SRC, address: "", fps: 10, width: 320, quality: 60, bandwidth: "lowest", maxViewers: 2, timeout: 2, wires: [["sink"]], ...extra });
const has = (nr, re) => nr.logs.some((l) => re.test(l));
const ours = (nr) => nr.logs.filter((l) => AREAS.test(l));

test("the checkbox is in both editors, off by default, with its help line", () => {
  for (const f of ["ndi-thumbnail", "ndi-live"]) {
    const html = fs.readFileSync(path.join(ROOT, "nodes", `${f}.html`), "utf8");
    assert.match(html, /verbose: \{ value: false \}/);
    assert.match(html, /id="node-input-verbose"/);
    assert.ok(html.includes("Verbose logging (for troubleshooting)"));
    assert.ok(html.includes("Records every step in the Node-RED log so a problem can be traced. Turn it off when you have what you need."));
  }
});

test("a rate-limited line is bounded and says how many were left out; control characters cannot forge a line", () => {
  const out = [];
  const v = createVLog((s) => out.push(s), { on: true });
  for (let i = 0; i < 500; i++) v.rate("k", "frame", "x", 60000);
  assert.strictEqual(out.length, 1);
  v.line("frame", "a\n[host] forged");
  assert.ok(!out[1].includes("\n"));
  for (const c of ["\r", "\u0085", "\u2028", "\u2029", "\u202e"]) {
    v.line("frame", `a${c}[host] forged`);
    assert.ok(!out[out.length - 1].includes(c), "no " + JSON.stringify(c));
  }
  assert.strictEqual(short("x".repeat(5000)).length, 200, "a value from outside is capped");
  const off = [];
  const q = createVLog((s) => off.push(s));
  q.line("frame", "x"); q.rate("k", "frame", "x"); q.raw("[frame] x");
  assert.strictEqual(off.length, 0, "off by default");
});

let nr;
test.before(async () => {
  nr = await startNodeRed([
    thumb("V1", { verbose: true }),
    thumb("V2", { verbose: true, source: "synthetic-novideo" }),
    thumb("V3", { verbose: true, source: "synthetic-absent" }),
    thumb("V4", { verbose: true, source: "" }),
    thumb("B1", { verbose: true, idle: 30 }),
    live("VL", { verbose: true }),
    live("BL", { verbose: true, fps: 15 }),
  ]);
});
let stopped = false;
async function stopOnce() { if (nr && !stopped) { stopped = true; await nr.stop(); } }
test.after(stopOnce);

test("verbose on: each main thing writes who asked, what, the answer, how long, and the reason", async () => {
  {
    // start: the settings that explain behaviour, the host starting, its handshake and the runtime
    assert.ok(await until(() => has(nr, /\[host\] request #\d+ hello .*NDI Runtime synthetic 6\.0/), 8000), "handshake");
    assert.ok(has(nr, /\[config\] ndi-thumbnail "node V1" started: source "SYNTHETIC \(Pattern\)".*every message|only when a message arrives/));
    assert.ok(has(nr, /\[config\] ndi-live "node VL" started: .*10 frames\/s, 320 px wide.*at most 2 viewers/));
    assert.ok(has(nr, /\[host\] starting the NDI host process: .*host\.js/));
    assert.ok(has(nr, /\[host\] process started, pid \d+; waiting for its first answer/));
    assert.ok(await until(() => has(nr, /\[host\] process \d+ started \(Node\.js/), 3000), "the host's own lines come back over IPC");
    assert.ok(has(nr, /\[host\] NDI Runtime found: version synthetic 6\.0, \/synthetic\/libndi/));

    // a still: asked by which message, which source, the result
    nr.RED.nodes.getNode("V1").receive({ payload: "placeholder-secret-in-payload", topic: "snap-1", credentials: { token: "placeholder-token" } });
    assert.ok(await until(() => has(nr, /\[frame\] still asked by message \(topic "snap-1"\): "SYNTHETIC \(Pattern\)" -> .*320x180 \(stream 640x360 RGBX\), \d+ ms/), 6000), "still line");
    assert.ok(has(nr, /\[receiver\] "SYNTHETIC \(Pattern\)" \(proxy\): connecting/));
    assert.ok(has(nr, /\[receiver\] "SYNTHETIC \(Pattern\)": first frame 640x360 RGBX at 25 frames\/s, \d+ ms after connecting/));
    assert.ok(has(nr, /\[host\] request #\d+ grab \(source "SYNTHETIC \(Pattern\)", 320 px, lowest.*-> ok .*JPEG.*\d+ ms/));
    assert.ok(await until(() => has(nr, /\[receiver\] "SYNTHETIC \(Pattern\)": closed after .*no live preview holds it/), 4000), "receiver closed (idle 0)");

    // a source with no video, one that never answers, and no source at all: each says why
    nr.RED.nodes.getNode("V2").receive({ payload: 1, topic: "t-novideo" });
    assert.ok(await until(() => has(nr, /\[frame\] still asked by message \(topic "t-novideo"\): "synthetic-novideo" gave no picture after \d+ ms \(EFAIL\): connected, but no video arrived within 1000 ms/), 8000), "novideo");
    nr.RED.nodes.getNode("V3").receive({ payload: 1 });
    assert.ok(await until(() => has(nr, /"synthetic-absent" gave no picture .*source not found, or it did not answer/), 8000), "absent");
    nr.RED.nodes.getNode("V4").receive({ payload: 1, topic: "t-none" });
    assert.ok(await until(() => has(nr, /\[frame\] still asked by message \(topic "t-none"\) skipped: no source is set/), 3000), "no source");
    assert.ok(has(nr, /\[host\] request #\d+ grab .*-> failed \(EFAIL\)/));

    // a message that overrides the source says so
    nr.RED.nodes.getNode("V1").receive({ payload: 1, source: SRC });
    assert.ok(await until(() => has(nr, /source taken from msg\.source/), 6000));

    // the host dying: exit code or signal, how many requests it takes down, the restart and the reason
    nr.RED.nodes.getNode("V1").receive({ payload: 1, source: "synthetic-crash" });
    assert.ok(await until(() => has(nr, /\[host\] process \d+ exited \(signal SIGKILL\) after [\d.]+ s; 1 request waiting/), 8000), "exit line");
    assert.ok(has(nr, /\[host\] restart 1 of 4 allowed within a minute: waiting 1 s because the host exited \(signal SIGKILL\)/));

    // discovery: appeared names, from the editor's "Find sources"
    const found = await get(`${nr.base}/admin/ndi-preview/sources`);
    assert.strictEqual(found.status, 200);
    assert.ok(await until(() => has(nr, /\[discovery\] 1 source after listening 2000 ms; appeared: "SYNTHETIC \(Pattern\)" \(127\.0\.0\.1:5961\) \(first search\)/), 4000), "discovery");
    assert.ok(has(nr, /\[http\] editor at \S+ asked for NDI sources: 1 found/));

    // a live preview: a viewer comes, a frame summary, the viewer goes, the receiver stops
    const url = `${nr.base}/api/ndi-live/VL.mjpg`;
    const watch = get(url, 4800);
    assert.ok(await until(() => has(nr, /\[http\] viewer \S+ connected to the live stream \(viewers now 1 of 2\)/), 4000), "viewer in");
    assert.ok(await until(() => has(nr, /\[receiver\] live preview "SYNTHETIC \(Pattern\)": starting -> live/), 4000), "live state");
    assert.ok(has(nr, /\[live\] stream VL starting: source "SYNTHETIC \(Pattern\)", lowest, 10 frames\/s, 320 px/));
    await watch;
    assert.ok(await until(() => has(nr, /\[http\] viewer \S+ left after [\d.]+ s, \d+ frames sent to it \(viewers now 0\)/), 4000), "viewer out");
    assert.ok(has(nr, /\[frame\] live "SYNTHETIC \(Pattern\)" last \d+ s: \d+ frames from the NDI helper \(\d/), "frame-rate summary");
    assert.ok(has(nr, /\[receiver\] "SYNTHETIC \(Pattern\)" last \d+ s: \d+ frames received .*used.*dropped by the NDI Runtime/), "receiver summary");
    assert.ok(await until(() => has(nr, /\[receiver\] live preview stopping: no viewers for 5 s/), 8000), "stop reason");
  }
});

test("verbose on: a burst of messages and of frames writes a bounded number of lines", async () => {
  {
    const before = nr.logs.length;
    const n = nr.RED.nodes.getNode("B1");
    for (let i = 0; i < 200; i++) n.receive({ payload: "placeholder-" + i, topic: "burst" });
    const viewers = [get(`${nr.base}/api/ndi-live/BL.mjpg`, 2500), get(`${nr.base}/api/ndi-live/BL.mjpg`, 2500)];
    const got = await Promise.all(viewers);
    assert.ok(got.every((g) => g.status === 200 && g.body.length > 2000), "both viewers received frames: " + got.map((g) => g.status + "/" + g.body.length));
    await sleep(500);
    const lines = nr.logs.slice(before).filter((l) => AREAS.test(l));
    assert.ok(lines.length < 40, `${lines.length} lines for 200 messages and about 70 frames: ${lines.join("\n")}`);
    assert.ok(!nr.logs.some((l) => /placeholder/.test(l)));
  }
});

test("closing the flow says so, and no message content or image bytes ever reached the log", async () => {
  await stopOnce();
  assert.ok(nr.logs.some((l) => /\[config\] closing \(/.test(l)));
  assert.ok(!nr.logs.some((l) => /placeholder/.test(l)), "a planted placeholder value never appears");
  assert.ok(!nr.logs.some((l) => /\xff\xd8/.test(l)), "no image bytes");
});

