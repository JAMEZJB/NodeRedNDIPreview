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
const { createVLog, short } = require("./vlog");

const RUNTIME_HELP = "Install the NDI 6 Runtime (or NDI Tools) from https://ndi.video/tools/ on the Node-RED computer, then restart Node-RED";

let addon = null;
let runtime = null;
let pool = null;

// Verbose lines go to Node-RED over the IPC channel (never stdout, which is not part of the protocol). The client
// switches this on and off (NDI_PREVIEW_VERBOSE at start, then a "verbose" message).
const vlog = createVLog((text) => send({ event: "log", text }), { on: process.env.NDI_PREVIEW_VERBOSE === "1" });
vlog.line("host", `process ${process.pid} started (Node.js ${process.version}, ${process.platform} ${process.arch})`);

function loadRuntime() {
  if (runtime && runtime.ok) return runtime;
  const t0 = Date.now();
  const wanted = process.env.NDI_PREVIEW_RUNTIME;
  vlog.line("host", wanted ? `loading the NDI Runtime from NDI_PREVIEW_RUNTIME=${short(wanted)}` : "loading the NDI Runtime from its usual place");
  let addonFailed = false;
  try {
    if (!addon) addon = loadAddon();
    const r = addon.load(wanted || undefined);
    runtime = r.ok ? r : { ...r, help: RUNTIME_HELP };
  } catch (e) {
    runtime = { ok: false, error: "could not load the NDI preview add-on: " + ((e && e.message) || e), help: RUNTIME_HELP };
    addonFailed = true;
    vlog.line("host", `the add-on failed to load (${(e && e.code) || "error"}): ${short((e && e.message) || e)}; that is this package's own add-on, not the NDI Runtime, so the NDI Runtime was not tried; the nodes stay idle (reinstall the package, then restart Node-RED)`);
  }
  if (addonFailed) { /* said above */ } else if (runtime.ok) vlog.line("host", `NDI Runtime found: version ${runtime.version}, ${runtime.path || "path not reported"}${runtime.loader ? `, loader ${runtime.loader}` : ""} (${Date.now() - t0} ms)`);
  else vlog.line("host", `NDI Runtime not found: ${short(runtime.error)}${runtime.url ? ` (${runtime.url})` : ""}; the nodes stay idle until it is installed and Node-RED is restarted`);
  if (runtime.ok && !pool) pool = new ReceiverPool(addon, { vlog });
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
    r.sum.delivered++; r.sum.bytes += j.jpeg.length;
    return {
      jpeg: j.jpeg,
      meta: {
        ...frameMeta(f), bandwidth, runtime: rt.version,
        thumbWidth: j.width, thumbHeight: j.height, bytes: j.jpeg.length, grabMs: Date.now() - t0, ...r.stats(),
      },
    };
  } catch (e) {
    vlog.rate("grab-fail:" + r.key, "frame", `still from "${short(source.name || source.address)}" failed after ${Date.now() - t0} ms: ${short(e.message)}`, 10000);
    throw e;
  } finally {
    pool.keep(r, owner, idleMs);
    pool.release(r, token);
  }
}

let lastSources = null;     // names seen by the previous discovery, to log only what changed

async function opSources(m) {
  needRuntime();
  const waitMs = clampInt(m.waitMs, 200, 10000, 2000);
  const f = addon.findOpen();
  try {
    await new Promise((res) => setTimeout(res, waitMs));
    const list = addon.findSources(f).map((s) => ({ name: s.name, address: s.address || "" }));
    if (vlog.on) {
      const now = new Set(list.map((s) => s.name));
      const was = lastSources;
      const appeared = list.filter((s) => !was || !was.has(s.name)).map((s) => `"${short(s.name, 100)}"${s.address ? ` (${short(s.address, 60)})` : ""}`);
      const went = was ? [...was].filter((n) => !now.has(n)).map((n) => `"${short(n, 100)}"`) : [];
      if (!was || appeared.length || went.length) {
        vlog.line("discovery", `${list.length} source${list.length === 1 ? "" : "s"} after listening ${waitMs} ms${appeared.length ? `; appeared: ${appeared.join(", ")}` : ""}${went.length ? `; went: ${went.join(", ")}` : ""}${!was ? " (first search)" : ""}`);
      }
      lastSources = now;
    }
    return list;
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
  vlog.line("live", `stream ${id} stopped after ${s.frames} frame${s.frames === 1 ? "" : "s"} sent to Node-RED`);
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
  if (running && running.params === params) {
    vlog.line("live", `stream ${id} start asked again with the same settings: already running, nothing to do`);
    return { stream: id, fps, width, quality, bandwidth };   // already running
  }
  if (running) vlog.line("live", `stream ${id} restarted: its settings changed`);
  stopStream(id);
  vlog.line("live", `stream ${id} starting: source "${short(source.name || source.address)}", ${bandwidth}, ${fps} frames/s, ${width} px, quality ${quality}, no-video limit ${noVideoMs} ms`);
  const r = pool.get(source, bandwidth, m.label);
  const s = { r, holder: Symbol(id), params, lastTs: null, lastNewAt: Date.now(), state: "starting", frames: 0 };
  pool.hold(r, s.holder);
  const status = (state, error) => {
    if (s.state === state) return;
    vlog.line("live", `stream ${id} "${short(source.name || source.address)}": ${s.state} -> ${state}${error ? ` (${short(error)})` : ""}`);
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
    if (inflight >= 2) { r.sum.skipped++; return; }  // Node-RED is behind: skip this frame, never queue
    let j;
    try { j = frameToJpeg(f, width, quality); } catch (e) { status("error", (e && e.message) || String(e)); return; }
    s.frames++;
    r.sum.delivered++; r.sum.bytes += j.jpeg.length;
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
  if (m && typeof m === "object" && m.cmd === "verbose") {
    vlog.on = !!m.on;                       // the pool and its receivers share this logger
    vlog.line("host", "verbose logging on");
    return;
  }
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

function shutdown(why) {
  vlog.line("host", `shutting down (${typeof why === "string" ? why : "Node-RED closed the channel"}): closing ${streams.size} stream(s) and ${pool ? pool.openCount() : 0} receiver(s)`);
  for (const id of [...streams.keys()]) stopStream(id);
  if (pool) pool.closeAll();
  process.exit(0);
}
process.on("disconnect", shutdown);         // Node-RED went away: never linger
process.on("SIGTERM", () => shutdown("SIGTERM"));
