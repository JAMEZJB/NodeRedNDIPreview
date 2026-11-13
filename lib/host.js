"use strict";
// The NDI host: a child process that does all the NDI work for one Node-RED, so that a crash or a hang in the NDI
// Runtime can never take Node-RED down. It loads the add-on and the user's NDI Runtime, keeps the shared receivers,
// grabs frames and encodes the JPEGs. Node-RED talks to it over the IPC channel (lib/host-client.js).
//
// This process never starts another process. It exits when Node-RED goes away (the IPC channel closes).

if (process.env.NDI_PREVIEW_HOST !== "1" || typeof process.send !== "function") {
  // Only lib/host-client.js may start this file, with the marker and an IPC channel. Anything else (a test runner,
  // a user typing `node host.js`) gets a refusal, never a running host.
  process.stderr.write("lib/host.js is started by Node-RED NDI Preview itself and cannot be run on its own.\n");
  process.exit(2);
}

const { loadAddon } = require("./addon");
const { ReceiverPool } = require("./receivers");
const { frameToJpeg, fourccName } = require("./frame");

const RUNTIME_HELP = "Install the NDI 6 Runtime (or NDI Tools) from https://ndi.video/tools/ on the Node-RED computer, then restart Node-RED";

let addon = null;
let runtime = null;
let pool = null;

function loadRuntime() {
  if (runtime && runtime.ok) return runtime;
  try {
    if (!addon) addon = loadAddon();
    const r = addon.load(process.env.NDI_PREVIEW_RUNTIME || undefined);
    runtime = r.ok ? r : { ...r, help: RUNTIME_HELP };
  } catch (e) {
    runtime = { ok: false, error: "could not load the NDI preview add-on: " + ((e && e.message) || e), help: RUNTIME_HELP };
  }
  if (runtime.ok && !pool) pool = new ReceiverPool(addon);
  return runtime;
}

// process.send that never throws: the channel can close at any moment (Node-RED stopping)
function send(msg, cb) {
  try {
    if (process.connected) { process.send(msg, cb ? () => cb() : undefined); return; }
  } catch (e) { /* channel closed */ }
  if (cb) cb();
}

class HostError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function needRuntime() {
  const rt = loadRuntime();
  if (!rt.ok) throw new HostError("ENORUNTIME", rt.error);
  return rt;
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function sourceOf(m) {
  const name = typeof m.source?.name === "string" ? m.source.name.trim() : "";
  const address = typeof m.source?.address === "string" ? m.source.address.trim() : "";
  if (!name && !address) throw new HostError("ENOSOURCE", "no NDI source set");
  return { name, address };
}

function frameMeta(f) {
  return {
    width: f.xres, height: f.yres,
    fps: f.frameRateD ? Math.round((f.frameRateN / f.frameRateD) * 100) / 100 : null,
    fourCC: fourccName(f.fourCC),
    lastFrame: f.timestamp > 0 ? new Date(Math.round(f.timestamp / 10000)).toISOString() : new Date().toISOString(),
  };
}

// ---- operations -------------------------------------------------------------------------------------------------

async function opGrab(m) {
  const rt = needRuntime();
  const source = sourceOf(m);
  const bandwidth = m.bandwidth === "highest" ? "highest" : "lowest";
  const width = clampInt(m.width, 32, 1920, 320);
  const quality = clampInt(m.quality, 10, 95, 70);
  const timeoutMs = clampInt(m.timeoutMs, 200, 60000, 3000);
  const idleMs = clampInt(m.idleMs, 0, 3600000, 30000);
  const owner = String(m.owner || "anonymous");
  const r = pool.get(source, bandwidth, m.label);
  const token = Symbol("grab");
  pool.hold(r, token);                                  // not swept while we wait for the first frame
  const t0 = Date.now();
  try {
    const f = await r.waitFrame(timeoutMs);
    const j = frameToJpeg(f, width, quality);
    return {
      jpeg: j.jpeg,
      meta: {
        ...frameMeta(f), bandwidth, runtime: rt.version,
        thumbWidth: j.width, thumbHeight: j.height, bytes: j.jpeg.length, grabMs: Date.now() - t0, ...r.stats(),
      },
    };
  } finally {
    pool.keep(r, owner, idleMs);
    pool.release(r, token);
  }
}

async function opSources(m) {
  needRuntime();
  const waitMs = clampInt(m.waitMs, 200, 10000, 2000);
  const f = addon.findOpen();
  try {
    await new Promise((res) => setTimeout(res, waitMs));
    return addon.findSources(f).map((s) => ({ name: s.name, address: s.address || "" }));
  } finally {
    addon.findClose(f);
  }
}

// ---- live previews ----------------------------------------------------------------------------------------------

const streams = new Map();   // stream id -> { r, timer, ... }
let inflight = 0;            // frame messages not yet handed to the IPC channel

function stopStream(id) {
  const s = streams.get(id);
  if (!s) return false;
  clearInterval(s.timer);
  streams.delete(id);
  pool.release(s.r, s.holder, false);
  return true;
}

function opLiveStart(m) {
  const rt = needRuntime();
  const id = String(m.stream || "");
  if (!id) throw new HostError("EBADARG", "no stream id");
  const source = sourceOf(m);
  const bandwidth = m.bandwidth === "highest" ? "highest" : "lowest";
  const fps = clampInt(m.fps, 1, 15, 10);
  const width = clampInt(m.width, 32, 1280, 640);
  const quality = clampInt(m.quality, 10, 95, 60);
  const noVideoMs = clampInt(m.timeoutMs, 1000, 60000, 5000);
  const params = JSON.stringify([source, bandwidth, fps, width, quality, noVideoMs, m.label || ""]);
  const running = streams.get(id);
  if (running && running.params === params) return { stream: id, fps, width, quality, bandwidth };   // already running
  stopStream(id);
  const r = pool.get(source, bandwidth, m.label);
  const s = { r, holder: Symbol(id), params, lastTs: null, lastNewAt: Date.now(), state: "starting", frames: 0 };
  pool.hold(r, s.holder);
  const status = (state, error) => {
    if (s.state === state) return;
    s.state = state;
    send({ event: "liveStatus", stream: id, state, error: error || null });
  };
  s.timer = setInterval(() => {
    let f;
    try { f = r.poll(); } catch (e) { status("error", (e && e.message) || String(e)); return; }
    const now = Date.now();
    if (!f || f.timestamp === s.lastTs) {
      if (now - s.lastNewAt > noVideoMs) {
        const { connections } = r.stats();
        status("novideo", connections ? "connected, but no video is arriving" : "source not found, or it did not answer");
      }
      return;
    }
    s.lastTs = f.timestamp;
    s.lastNewAt = now;
    if (inflight >= 2) return;                       // Node-RED is behind: skip this frame, never queue
    let j;
    try { j = frameToJpeg(f, width, quality); } catch (e) { status("error", (e && e.message) || String(e)); return; }
    s.frames++;
    status("live");
    inflight++;
    send({ event: "frame", stream: id, jpeg: j.jpeg, meta: { ...frameMeta(f), thumbWidth: j.width, thumbHeight: j.height, bytes: j.jpeg.length, bandwidth, runtime: rt.version } },
      () => { inflight--; });
  }, Math.round(1000 / fps));
  streams.set(id, s);
  return { stream: id, fps, width, quality, bandwidth };
}

function opLiveStop(m) { return { stopped: stopStream(String(m.stream || "")) }; }

function opDrop(m) { if (pool) pool.drop(String(m.owner || "")); return {}; }

function opStatus() {
  return { runtime, receivers: pool ? pool.openCount() : 0, streams: streams.size, pid: process.pid };
}

const OPS = {
  hello: () => loadRuntime(),
  ping: () => ({ pong: Date.now() }),
  grab: opGrab,
  sources: opSources,
  liveStart: opLiveStart,
  liveStop: opLiveStop,
  drop: opDrop,
  status: opStatus,
};

process.on("message", async (m) => {
  if (!m || typeof m !== "object" || m.id === undefined) return;
  const fn = OPS[m.op];
  try {
    if (!fn) throw new HostError("EBADOP", `unknown operation ${m.op}`);
    const result = await fn(m);
    send({ id: m.id, ok: true, result });
  } catch (e) {
    send({ id: m.id, ok: false, code: e.code || "EFAIL", error: (e && e.message) || String(e) });
  }
});

function shutdown() {
  for (const id of [...streams.keys()]) stopStream(id);
  if (pool) pool.closeAll();
  process.exit(0);
}
process.on("disconnect", shutdown);         // Node-RED went away: never linger
process.on("SIGTERM", shutdown);
