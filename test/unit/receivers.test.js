"use strict";
// The shared receiver pool, in process, with the synthetic add-on (no NDI, no network).
const test = require("node:test");
const assert = require("node:assert");
const addon = require("../fixtures/fake-addon");
const { ReceiverPool } = require("../../lib/receivers");

addon.load();
const src = { name: "SYNTHETIC (Pattern)", address: "" };

test("one receiver per source and bandwidth, shared", () => {
  const pool = new ReceiverPool(addon, { sweepMs: 60000 });
  const a = pool.get(src, "lowest", "a");
  const b = pool.get({ ...src }, "lowest", "b");
  const c = pool.get(src, "highest", "c");
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  pool.closeAll();
});

test("waitFrame returns a frame, then the receiver closes when its keep expires", async () => {
  const pool = new ReceiverPool(addon, { sweepMs: 60000 });
  const before = addon._openCount();
  const r = pool.get(src, "lowest");
  const f = await r.waitFrame(1000);
  assert.strictEqual(f.xres, 640);
  assert.strictEqual(addon._openCount(), before + 1);
  pool.keep(r, "node-1", 0);
  pool.sweep();
  assert.strictEqual(addon._openCount(), before, "closed once nothing keeps it");
  pool.closeAll();
});

test("a live holder keeps a receiver open; drop() releases only that owner's keep", async () => {
  const pool = new ReceiverPool(addon, { sweepMs: 60000 });
  const r = pool.get(src, "lowest");
  await r.waitFrame(1000);
  const holder = Symbol("live");
  pool.hold(r, holder);
  pool.keep(r, "thumb", 60000);
  pool.drop("thumb");
  assert.ok(r.open, "still held by the live stream");
  pool.release(r, holder);
  assert.ok(!r.open, "closed: no holder, no keep");
  pool.closeAll();
});

test("waitFrame explains no video and no source", async () => {
  const pool = new ReceiverPool(addon, { sweepMs: 60000 });
  await assert.rejects(pool.get({ name: "synthetic-novideo" }, "lowest").waitFrame(200), /connected, but no video/);
  await assert.rejects(pool.get({ name: "synthetic-absent" }, "lowest").waitFrame(200), /source not found/);
  pool.closeAll();
  assert.strictEqual(addon._openCount(), 0);
});

test("a source that stops is reported, not its last picture again", async () => {
  const pool = new ReceiverPool(addon, { sweepMs: 60000 });
  const r = pool.get({ name: "synthetic-dies" }, "lowest");
  const f = await r.waitFrame(500);
  assert.ok(f, "a frame while it is alive");
  await new Promise((res) => setTimeout(res, 700));
  await assert.rejects(r.waitFrame(300), /the source has gone/);
  pool.closeAll();
});

test("an unchanged frame is not copied again", async () => {
  const pool = new ReceiverPool(addon, { sweepMs: 60000 });
  const r = pool.get({ name: "synthetic-dies" }, "lowest");
  await r.waitFrame(500);
  await new Promise((res) => setTimeout(res, 400));
  const a = r.poll(), b = r.poll();
  assert.strictEqual(a, b, "the same object: the add-on said nothing new");
  pool.closeAll();
});
