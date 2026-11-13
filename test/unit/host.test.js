"use strict";
// The NDI host process and its client, with the synthetic add-on: no NDI, no network.
// Every process started here is lib/host.js, named explicitly; the gate runs this under a process cap and a time limit.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

process.env.NDI_PREVIEW_TEST_ADDON = path.join(__dirname, "..", "fixtures", "fake-addon.js");
delete process.env.NDI_PREVIEW_RUNTIME;
const { HostClient, HOST_SCRIPT } = require("../../lib/host-client");

const SRC = { name: "SYNTHETIC (Pattern)", address: "" };
const quiet = { info() {}, warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isJpeg = (b) => Buffer.isBuffer(b) && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;

function client(opts = {}) {
  return new HostClient({ log: quiet, backoffBaseMs: 50, marginMs: 1500, ...opts });
}

test("host.js refuses to run unless the client started it", () => {
  const env = { ...process.env };
  delete env.NDI_PREVIEW_HOST;
  const r = spawnSync(process.execPath, [HOST_SCRIPT], { env, timeout: 10000, encoding: "utf8" });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /cannot be run on its own/);
  const r2 = spawnSync(process.execPath, [HOST_SCRIPT], { env: { ...env, NDI_PREVIEW_HOST: "1" }, timeout: 10000, encoding: "utf8" });
  assert.strictEqual(r2.status, 2, "the marker alone is not enough without the IPC channel");
});

test("a client cannot be created inside the host", () => {
  process.env.NDI_PREVIEW_HOST = "1";
  try { assert.throws(() => client(), /inside the NDI host/); } finally { delete process.env.NDI_PREVIEW_HOST; }
});

test("runtime, stills, discovery and status", async () => {
  const c = client();
  try {
    const rt = await c.runtime();
    assert.strictEqual(rt.ok, true);
    assert.strictEqual(rt.version, "synthetic 6.0");
    const g = await c.grab({ owner: "n1", source: SRC, width: 320, quality: 70, timeoutMs: 2000, idleMs: 0 });
    assert.ok(isJpeg(g.jpeg));
    assert.strictEqual(g.meta.width, 640);
    assert.strictEqual(g.meta.thumbWidth, 320);
    assert.strictEqual(g.meta.thumbHeight, 180);
    assert.strictEqual(g.meta.fps, 25);
    assert.strictEqual(g.meta.connections, 1);
    const s = await c.sources(200);
    assert.deepStrictEqual(s, [{ name: "SYNTHETIC (Pattern)", address: "127.0.0.1:5961" }]);
    await sleep(1200);
    assert.strictEqual((await c.status()).receivers, 0, "idle 0: closed after the grab");
    await assert.rejects(c.grab({ owner: "n1", source: { name: "synthetic-novideo" }, timeoutMs: 300 }), /no video/);
    await assert.rejects(c.grab({ owner: "n1", source: {}, timeoutMs: 300 }), (e) => e.code === "ENOSOURCE");
  } finally {
    await c.stop();
  }
});

test("no runtime: says so, never crashes", async () => {
  process.env.NDI_PREVIEW_RUNTIME = "/synthetic/missing/libndi";
  const c = client();
  try {
    const rt = await c.runtime();
    assert.strictEqual(rt.ok, false);
    assert.match(rt.error, /not installed/);
    assert.match(rt.help, /ndi\.video/);
    await assert.rejects(c.grab({ source: SRC }), (e) => e.code === "ENORUNTIME");
    await assert.rejects(c.liveStart("s1", { source: SRC }), (e) => e.code === "ENORUNTIME");
  } finally {
    delete process.env.NDI_PREVIEW_RUNTIME;
    await c.stop();
  }
});

test("live frames, a shared receiver, and stop", async () => {
  const c = client();
  try {
    const frames = [];
    c.on("frame", (id, jpeg, meta) => { if (id === "live-1") frames.push({ jpeg, meta }); });
    await c.liveStart("live-1", { source: SRC, fps: 10, width: 320, quality: 60 });
    await sleep(1100);
    assert.ok(frames.length >= 6 && frames.length <= 12, `about 10 frames a second, got ${frames.length}`);
    assert.ok(isJpeg(frames[0].jpeg));
    assert.strictEqual(frames[0].meta.thumbWidth, 320);
    await c.grab({ owner: "thumb", source: SRC, timeoutMs: 1000, idleMs: 0 });
    assert.strictEqual((await c.status()).receivers, 1, "the still and the live preview share one receiver");
    await c.liveStop("live-1");
    const n = frames.length;
    await sleep(1300);
    assert.ok(frames.length <= n + 1, "no frames after stop");
    const st = await c.status();
    assert.strictEqual(st.streams, 0);
    assert.strictEqual(st.receivers, 0);
  } finally {
    await c.stop();
  }
});

test("a crashed host restarts and carries on; live previews resume", async () => {
  const c = client();
  const states = [];
  c.on("state", (s) => states.push(s));
  try {
    await c.runtime();
    const pid1 = c.pid;
    await assert.rejects(c.grab({ source: { name: "synthetic-crash" }, timeoutMs: 1000 }), (e) => e.code === "EHOSTEXIT");
    assert.deepStrictEqual(states, ["restarting"]);
    const g = await c.grab({ owner: "n", source: SRC, timeoutMs: 1000, idleMs: 0 });
    assert.ok(isJpeg(g.jpeg));
    assert.notStrictEqual(c.pid, pid1, "a new host process");

    let got = 0;
    c.on("frame", () => got++);
    await c.liveStart("live-2", { source: SRC, fps: 10 });
    await sleep(400);
    process.kill(c.pid, "SIGKILL");
    await sleep(300);
    const before = got;
    await sleep(1200);
    assert.ok(got > before + 3, `frames resumed after the restart (${before} -> ${got})`);
  } finally {
    await c.stop();
  }
});

test("a host that keeps crashing is given up on, with a clear reason", async () => {
  const c = client({ maxCrashes: 3 });
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(c.grab({ source: { name: "synthetic-crash" }, timeoutMs: 1000 }), (e) => e.code === "EHOSTEXIT");
    }
    await assert.rejects(c.grab({ source: SRC }), (e) => e.code === "EHOSTFAILED" && /restart Node-RED/.test(e.message));
    const rt = await c.runtime({ refresh: true });
    assert.strictEqual(rt.ok, false);
  } finally {
    await c.stop();
  }
});

test("a hung host is ended and replaced", async () => {
  const c = client({ marginMs: 300 });
  try {
    await c.runtime();
    const pid1 = c.pid;
    await assert.rejects(c.grab({ source: { name: "synthetic-hang" }, timeoutMs: 200 }), (e) => e.code === "ETIMEOUT");
    await sleep(3800);                                   // the ping gets no answer within 3 s, so the host is ended
    const g = await c.grab({ owner: "n", source: SRC, timeoutMs: 1000, idleMs: 0 });
    assert.ok(isJpeg(g.jpeg));
    assert.notStrictEqual(c.pid, pid1);
  } finally {
    await c.stop();
  }
});

test("a live stream stopped while the host restarts is never started", async () => {
  const c = client({ backoffBaseMs: 600 });
  try {
    await c.runtime();
    await assert.rejects(c.grab({ source: { name: "synthetic-crash" }, timeoutMs: 1000 }), (e) => e.code === "EHOSTEXIT");
    const starting = c.liveStart("orphan", { source: SRC, fps: 10 });   // waits for the restart
    await sleep(100);
    await c.liveStop("orphan");                                          // the node stops meanwhile
    const r = await starting;
    assert.strictEqual(r.cancelled, true);
    await sleep(300);
    assert.strictEqual((await c.status()).streams, 0, "no stream without an owner");
  } finally {
    await c.stop();
  }
});

test("a host that hangs while only live previews run is found and replaced", async () => {
  const c = client({ heartbeatMs: 500 });
  try {
    await c.runtime();
    const pid1 = c.pid;
    await c.liveStart("hangs", { source: { name: "synthetic-hang" }, fps: 5 });   // hangs on its first frame
    await sleep(5000);                                                            // heartbeat + 3 s ping timeout
    await c.liveStop("hangs");
    const g = await c.grab({ owner: "n", source: SRC, timeoutMs: 1000, idleMs: 0 });
    assert.ok(isJpeg(g.jpeg));
    assert.notStrictEqual(c.pid, pid1, "the hung host was ended");
  } finally {
    await c.stop();
  }
});
