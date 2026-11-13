"use strict";
// The example flows in examples/: public-safe, complete, and working in a real (embedded, loopback-only) Node-RED
// with the synthetic add-on: no NDI, no network.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
delete process.env.NDI_PREVIEW_RUNTIME;
const { startNodeRed, get, until } = require("../fixtures/nodered");

const ROOT = path.join(__dirname, "..", "..");
const DIR = path.join(ROOT, "examples");
const SRC = "SYNTHETIC (Pattern)";
const CORE = new Set(["comment", "inject", "change", "debug", "function", "template", "http in", "http response"]);
const isJpeg = (b) => Buffer.isBuffer(b) && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const flows = Object.fromEntries(files.map((f) => [f, JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))]));

// The keys each node's editor defines (its "defaults" block), so an example sets every setting.
function editorDefaults(type) {
  const html = fs.readFileSync(path.join(ROOT, "nodes", `${type}.html`), "utf8");
  const block = html.match(/defaults:\s*\{([\s\S]*?)\n\s*\},/)[1];
  return [...block.matchAll(/^\s*([A-Za-z]+):\s*\{/gm)].map((m) => m[1]).sort();
}

test("there is one example for each node", () => {
  const types = new Set(Object.values(flows).flat().map((n) => n.type));
  assert.ok(types.has("ndi-thumbnail"), "an ndi-thumbnail example");
  assert.ok(types.has("ndi-live"), "an ndi-live example");
  const pkg = require(path.join(ROOT, "package.json"));
  assert.ok(pkg.files.includes("examples/"), "examples/ is in package.json files");
});

test("examples use only core nodes and this package's nodes, with every setting given", () => {
  for (const [f, nodes] of Object.entries(flows)) {
    assert.ok(Array.isArray(nodes) && nodes.length, f);
    const ids = new Set();
    for (const n of nodes) {
      assert.ok(/^[0-9a-f]{16}$/.test(n.id), `${f}: id ${n.id}`);
      assert.ok(!ids.has(n.id), `${f}: duplicate id ${n.id}`); ids.add(n.id);
      assert.ok(!("z" in n), `${f}: ${n.id} belongs to no tab, so it imports into the current one`);
      assert.ok(CORE.has(n.type) || n.type.startsWith("ndi-"), `${f}: node type ${n.type}`);
      for (const w of (n.wires || []).flat()) assert.ok(nodes.some((m) => m.id === w), `${f}: wire to ${w}`);
      if (n.type.startsWith("ndi-")) {
        const keys = Object.keys(n).filter((k) => !["id", "type", "x", "y", "wires"].includes(k)).sort();
        assert.deepStrictEqual(keys, editorDefaults(n.type), `${f}: ${n.type} settings`);
      }
    }
  }
});

test("examples are public-safe: made-up names, no addresses, no host names", () => {
  for (const [f, nodes] of Object.entries(flows)) {
    const text = JSON.stringify(nodes);
    assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text), `${f}: an IP address`);
    assert.ok(!/\b[a-z0-9-]+\.(local|lan|home|internal|corp)\b/i.test(text), `${f}: a host name`);
    const urls = [...text.matchAll(/https?:\/\/[^\s"\\)]+/g)].map((m) => m[0]);
    for (const u of urls) assert.ok(/^https:\/\/ndi\.video\/|^http:\/\/<node-red>/.test(u), `${f}: link ${u}`);
    for (const n of nodes.filter((m) => m.type.startsWith("ndi-"))) {
      assert.strictEqual(n.address, "", `${f}: no address`);
      assert.match(n.source, /^EXAMPLE-/, `${f}: a made-up source name`);
    }
  }
});

// Both examples deployed together, pointed at the synthetic source.
let nr;
test.before(async () => {
  const all = Object.values(flows).flat().map((n) => {
    if (!n.type.startsWith("ndi-")) return n;
    return { ...n, source: SRC, ...(n.type === "ndi-thumbnail" ? { interval: 1 } : {}) };
  });
  nr = await startNodeRed(all);
});
test.after(async () => { if (nr) await nr.stop(); });

test("thumbnail example: the web endpoint serves the newest still", async () => {
  let r;
  const ok = await until(() => !!(nr.RED.nodes.getNode("a1c0de0000000005")), 3000);
  assert.ok(ok, "the flow is running");
  const t0 = Date.now();
  do { r = await get(`${nr.base}/api/ndi-example/still.jpg`); } while (r.status !== 200 && Date.now() - t0 < 8000);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers["content-type"], "image/jpeg");
  assert.ok(isJpeg(r.body), "a JPEG");
});

test("live example: the page shows the stream, and the stream is live", async () => {
  let r;
  const t0 = Date.now();
  do { r = await get(`${nr.base}/api/ndi-example/live`); } while (!/<img /.test(r.body.toString()) && Date.now() - t0 < 5000);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/html/);
  const html = r.body.toString();
  const src = (html.match(/<img src="([^"]+)"/) || [])[1];
  assert.strictEqual(src, "/api/ndi-live/b2c0de0000000004.mjpg");
  assert.ok(!/not ready yet/.test(html));
  const s = await get(`${nr.base}${src}`, 1500);
  assert.strictEqual(s.status, 200);
  assert.match(s.headers["content-type"], /^multipart\/x-mixed-replace/);
  assert.ok(s.body.toString("latin1").includes("--ndipreviewframe\r\n"), "at least one frame");
});
