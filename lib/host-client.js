"use strict";
// Node-RED's side of the NDI host (lib/host.js): starts it, talks to it, and restarts it if it dies or hangs.
//
// Safety rules for starting a process:
//   - the program is named explicitly: this Node.js binary (process.execPath) running the absolute path of
//     lib/host.js, with no extra Node flags; never "this program again";
//   - the child carries the NDI_PREVIEW_HOST marker, and this module refuses to start a host from inside a host;
//   - at most one host per Node-RED; restarts back off (1 s, 2 s, 4 s ... 30 s) and stop altogether after
//     MAX_CRASHES crashes inside CRASH_WINDOW_MS, with a clear status, until Node-RED is restarted.
const { fork } = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");
const { prepareNdiConfig } = require("./ndi-config");
const { unsupportedReason } = require("./addon");

const HOST_SCRIPT = path.join(__dirname, "host.js");
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60000;
const PING_MS = 3000;
const HEARTBEAT_MS = 10000;

// Every host this process started, so that none outlives Node-RED: a host stuck in native code cannot see its IPC
// channel close, so it is ended here when Node-RED exits.
const running = new Set();
process.once("exit", () => { for (const c of running) { try { c.kill("SIGKILL"); } catch (e) { /* gone */ } } });

const toBuffer = (u8) => (Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));

class HostClient extends EventEmitter {
  constructor({ configDir, log, maxCrashes = MAX_CRASHES, backoffBaseMs = 1000, marginMs = 10000, heartbeatMs = HEARTBEAT_MS } = {}) {
    super();
    if (process.env.NDI_PREVIEW_HOST === "1") throw new Error("refusing to start an NDI host from inside the NDI host");
    this.configDir = configDir;
    this.maxCrashes = maxCrashes;
    this.backoffBaseMs = backoffBaseMs;
    this.marginMs = marginMs;
    this.heartbeatMs = heartbeatMs;
    this.log = log || { info() {}, warn() {} };
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.live = new Map();           // stream id -> liveStart arguments, replayed after a restart
    this.crashes = [];
    this.nextStartAt = 0;
    this.restartTimer = null;
    this.failed = null;              // a sentence once the host has given up
    this.runtimePromise = null;
    this.stopping = false;
    this.heartbeat = null;
    this.setMaxListeners(0);
  }

  get pid() { return this.child ? this.child.pid : null; }

  // -> the running child, starting it (after any backoff) when needed
  async _ensure() {
    if (this.stopping) throw Object.assign(new Error("the NDI host has been stopped"), { code: "EHOSTEXIT" });
    if (this.failed) throw Object.assign(new Error(this.failed), { code: "EHOSTFAILED" });
    if (this.child) return this.child;
    const wait = this.nextStartAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.stopping) throw Object.assign(new Error("the NDI host has been stopped"), { code: "EHOSTEXIT" });
    if (this.failed) throw Object.assign(new Error(this.failed), { code: "EHOSTFAILED" });
    if (!this.child) this._spawn();
    return this.child;
  }

  _spawn() {
    const cfg = this.configDir ? prepareNdiConfig(this.configDir) : { env: {}, applied: false, reason: "no folder" };
    const env = { ...process.env, ...cfg.env, NDI_PREVIEW_HOST: "1", ELECTRON_RUN_AS_NODE: "1" };
    const child = fork(HOST_SCRIPT, [], {
      execPath: process.execPath,
      execArgv: [],
      env,
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.child = child;
    this.log.info(`NDI host started (pid ${child.pid})${cfg.applied ? ", TCP receive on" : ""}`);
    let lines = 0;
    const pipe = (stream) => stream.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim() && lines++ < 200) this.log.warn("NDI host: " + line.trim());
      }
    });
    pipe(child.stdout); pipe(child.stderr);
    child.on("message", (m) => this._onMessage(m));
    running.add(child);
    child.on("error", (e) => {
      this.log.warn("NDI host error: " + e.message);
      if (!child.pid || child.exitCode !== null) this._onExit(child, null, null, e.message);   // never started
    });
    child.on("exit", (code, signal) => this._onExit(child, code, signal));
    for (const [id, args] of this.live) this._replay(id, args);
    this._armHeartbeat();
  }

  // a live stream that was running before a restart: start it again, and tell its node if that fails
  _replay(id, args) {
    this._send({ op: "liveStart", stream: id, ...args }).catch((e) => {
      if (this.live.get(id) === args) this.emit("liveStatus", id, "error", e.message);
    });
  }

  // While live previews run, nothing else may ask the host anything, so a hang would go unnoticed: ping it.
  _armHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.child && this.live.size) this._checkAlive(this.child);
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  _onMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.event === "frame") { this.emit("frame", m.stream, toBuffer(m.jpeg), m.meta); return; }
    if (m.event === "liveStatus") { this.emit("liveStatus", m.stream, m.state, m.error); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) {
      const r = m.result;
      if (r && r.jpeg) r.jpeg = toBuffer(r.jpeg);
      p.resolve(r);
    } else {
      p.reject(Object.assign(new Error(m.error), { code: m.code }));
    }
  }

  _onExit(child, code, signal, error) {
    running.delete(child);
    if (this.child !== child) return;
    this.child = null;
    clearInterval(this.heartbeat);
    const why = error ? error : signal ? `signal ${signal}` : `code ${code}`;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(`the NDI host stopped (${why})`), { code: "EHOSTEXIT" })); }
    this.pending.clear();
    if (this.stopping) return;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (this.crashes.length >= this.maxCrashes) {
      this.failed = `the NDI host stopped ${this.crashes.length} times in a minute, so it is not restarted; restart Node-RED to try again`;
      this.log.warn(this.failed);
      this.emit("state", "failed", this.failed);
      return;
    }
    const backoff = Math.min(30000, this.backoffBaseMs * 2 ** (this.crashes.length - 1));
    this.nextStartAt = now + backoff;
    this.log.warn(`the NDI host stopped (${why}); restarting in ${Math.round(backoff / 100) / 10} s`);
    this.emit("state", "restarting", `the NDI host stopped (${why})`);
    this.runtimePromise = null;
    if (this.live.size) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => { this._ensure().catch(() => {}); }, backoff);
      this.restartTimer.unref?.();
    }
  }

  _send(msg, timeoutMs = 10000, watch = true) {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || !child.connected) { reject(Object.assign(new Error("the NDI host is not running"), { code: "EHOSTEXIT" })); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("the NDI host did not answer in time"), { code: "ETIMEOUT" }));
        if (watch) this._checkAlive(child);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { child.send({ ...msg, id }); } catch (e) {
        clearTimeout(timer); this.pending.delete(id);
        reject(Object.assign(new Error("the NDI host is not running"), { code: "EHOSTEXIT" }));
      }
    });
  }

  // a request timed out: if the host does not answer a ping either, it is hung, so end it (it then restarts)
  _checkAlive(child) {
    if (child !== this.child || child.checking) return;
    child.checking = true;
    this._send({ op: "ping" }, PING_MS, false).then(
      () => { child.checking = false; },
      () => {
        if (child === this.child) {
          this.log.warn("the NDI host is not responding; ending it");
          child.kill("SIGKILL");
        }
      });
  }

  async request(op, args = {}, timeoutMs = 10000) {
    await this._ensure();
    return this._send({ op, ...args }, timeoutMs);
  }

  // -> { ok:true, version, path } | { ok:false, error, help?, url? }. Never rejects.
  runtime({ refresh = false } = {}) {
    const why = unsupportedReason();
    if (why) return Promise.resolve({ ok: false, error: why, unsupported: true });
    if (refresh || !this.runtimePromise) {
      const p = this.request("hello", {}, 15000).catch((e) => ({ ok: false, error: e.message, host: true, failed: e.code === "EHOSTFAILED" }));
      this.runtimePromise = p;
      p.then((rt) => { if (!rt.ok && rt.host && this.runtimePromise === p) this.runtimePromise = null; });
    }
    return this.runtimePromise;
  }

  grab(args) {
    const timeoutMs = Math.max(200, Number(args.timeoutMs) || 3000);
    return this.request("grab", args, timeoutMs + this.marginMs);
  }

  sources(waitMs = 2000) { return this.request("sources", { waitMs }, waitMs + this.marginMs); }

  drop(owner) { return this.child ? this._send({ op: "drop", owner }).catch(() => {}) : Promise.resolve(); }

  async liveStart(stream, args) {
    this.live.set(stream, args);
    await this._ensure();
    // stopped while the host was (re)starting: never start a stream nobody owns any more
    if (this.live.get(stream) !== args) return { stream, cancelled: true };
    // (if the host was just started, it already got this stream from the replay; the host treats the repeat as a no-op)
    return this._send({ op: "liveStart", stream, ...args });
  }

  liveStop(stream) {
    this.live.delete(stream);
    return this.child ? this._send({ op: "liveStop", stream }).catch(() => {}) : Promise.resolve();
  }

  status() { return this.request("status"); }

  // end the host (Node-RED is stopping, or a test is done)
  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.heartbeat);
    this.live.clear();
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); }, 3000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
      try { child.disconnect(); } catch (e) { child.kill("SIGKILL"); }
    });
  }
}

// One host per Node-RED: both node types share it.
let shared = null;
function getClient(RED) {
  if (!shared) {
    const userDir = (RED && RED.settings && RED.settings.userDir) || require("os").tmpdir();
    shared = new HostClient({
      configDir: path.join(userDir, "ndi-preview"),
      log: { info: (s) => RED.log.info("[ndi-preview] " + s), warn: (s) => RED.log.warn("[ndi-preview] " + s) },
    });
  }
  return shared;
}

// end the shared host (tests, or a Node-RED that is shutting down its runtime)
async function stopShared() {
  const c = shared;
  shared = null;
  if (c) await c.stop();
}

module.exports = { HostClient, getClient, stopShared, HOST_SCRIPT, MAX_CRASHES };
