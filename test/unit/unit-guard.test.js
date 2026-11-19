"use strict";
// The unit-test guard itself (test/unit-guard.js): it must refuse before anything is loaded or started. Every
// target below is harmless even if the guard were broken: loopback addresses, a missing NDI Runtime path.
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");

// the refusals below are deliberate: keep them out of the gate's violation report
delete process.env.NETGUARD_REPORT;

const childProcess = require("child_process");
if (!childProcess.spawn.toString().includes("spawnRefusal")) {
  // The gate preloads the guard; when a file is run on its own, load it here.
  require("../unit-guard");
}

const ROOT = path.join(__dirname, "..", "..");
const HOST_SCRIPT = path.join(ROOT, "lib", "host.js");
const REAL_ADDON = path.join(ROOT, "prebuilds", "darwin-universal", "ndi_preview.node");

test("the real add-on and any NDI library are refused before they are loaded", () => {
  for (const file of [REAL_ADDON, path.join(ROOT, "prebuilds", "win32-x64", "ndi_preview.node"),
    path.join(os.tmpdir(), "synthetic-missing", "libndi.dylib")]) {
    assert.throws(() => process.dlopen({ exports: {} }, file), (e) => e.code === "EUNITGUARD", file);
  }
});

test("a test that forgets NDI_PREVIEW_TEST_ADDON cannot start the NDI host", () => {
  const env = { ...process.env, NDI_PREVIEW_RUNTIME: "/synthetic/missing/libndi" };
  delete env.NDI_PREVIEW_TEST_ADDON;
  assert.throws(() => childProcess.fork(HOST_SCRIPT, [], { env, execArgv: [], stdio: "ignore" }),
    (e) => e.code === "EUNITGUARD" && /NDI_PREVIEW_TEST_ADDON/.test(e.message));
  assert.throws(() => childProcess.spawnSync(process.execPath, [HOST_SCRIPT], { env, timeout: 5000 }),
    (e) => e.code === "EUNITGUARD");
});

test("the HostClient itself refuses to start a host without the synthetic add-on", async () => {
  const saved = process.env.NDI_PREVIEW_TEST_ADDON;
  const savedRuntime = process.env.NDI_PREVIEW_RUNTIME;
  delete process.env.NDI_PREVIEW_TEST_ADDON;
  process.env.NDI_PREVIEW_RUNTIME = "/synthetic/missing/libndi";
  try {
    const { HostClient } = require("../../lib/host-client");
    const c = new HostClient({ log: { info() {}, warn() {} } });
    assert.throws(() => c._spawn(), (e) => e.code === "EUNITGUARD");
    assert.strictEqual(c.child, null, "no process was started");
  } finally {
    if (saved !== undefined) process.env.NDI_PREVIEW_TEST_ADDON = saved;
    if (savedRuntime === undefined) delete process.env.NDI_PREVIEW_RUNTIME; else process.env.NDI_PREVIEW_RUNTIME = savedRuntime;
  }
});

test("programs other than node, and shell commands, are refused", () => {
  assert.throws(() => childProcess.spawn("curl", ["http://127.0.0.1:9/"]), (e) => e.code === "EUNITGUARD");
  assert.throws(() => childProcess.execFileSync("/usr/bin/true", []), (e) => e.code === "EUNITGUARD");
  assert.throws(() => childProcess.spawnSync(process.execPath, ["-e", "0"], { shell: true }), (e) => e.code === "EUNITGUARD");
  assert.throws(() => childProcess.exec("ping -c 1 127.0.0.1"), (e) => e.code === "EUNITGUARD");
});

test("node itself still runs", () => {
  const r = childProcess.spawnSync(process.execPath, ["-e", "process.exit(7)"], { timeout: 10000 });
  assert.strictEqual(r.status, 7);
});
