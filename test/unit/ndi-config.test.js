"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { prepareNdiConfig, withTcpReceive } = require("../../lib/ndi-config");

test("TCP receive is switched on and the rest of the configuration is kept", () => {
  const cfg = withTcpReceive({ ndi: { groups: { recv: "cams" }, networks: { discovery: "127.0.0.1" }, tcp: { send: { x: 1 } } } });
  assert.deepStrictEqual(cfg.ndi.groups, { recv: "cams" });
  assert.deepStrictEqual(cfg.ndi.networks, { discovery: "127.0.0.1" });
  assert.strictEqual(cfg.ndi.tcp.recv.enable, true);
  assert.deepStrictEqual(cfg.ndi.tcp.send, { x: 1 });
  assert.strictEqual(cfg.ndi.rudp.recv.enable, false);
  assert.strictEqual(cfg.ndi.multicast.recv.enable, false);
  assert.strictEqual(withTcpReceive(null).ndi.tcp.recv.enable, true);
});

test("a private copy is written for the host only; process.env is not changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndi-preview-cfg-"));
  try {
    const before = process.env.NDI_CONFIG_DIR;
    const r = prepareNdiConfig(path.join(dir, "cfg"), {});
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.env.NDI_CONFIG_DIR, path.join(dir, "cfg"));
    const written = JSON.parse(fs.readFileSync(path.join(dir, "cfg", "ndi-config.v1.json"), "utf8"));
    assert.strictEqual(written.ndi.tcp.recv.enable, true);
    assert.strictEqual(process.env.NDI_CONFIG_DIR, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a configuration the user (or a test) chose is left alone", () => {
  const r = prepareNdiConfig("/nonexistent-should-not-be-written", { NDI_CONFIG_DIR: "/somewhere" });
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(r.env, {});
});
