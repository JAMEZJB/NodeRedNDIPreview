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
const { createVLog, bytes, short } = require("./vlog");

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

// Short, safe descriptions of a request and its answer for the verbose log: names, counts and sizes, never contents.
const srcName = (x) => short((x && (x.name || x.address)) || "(none)");
function describeArgs(m) {
  switch (m.op) {
    case "grab": return ` (source "${srcName(m.source)}", ${m.width} px, ${m.bandwidth || "lowest"}, wait up to ${m.timeoutMs} ms, keep ${m.idleMs} ms)`;
    case "sources": return ` (listening ${m.waitMs} ms)`;
    case "liveStart": return ` (stream ${m.stream}, source "${srcName(m.source)}", ${m.fps} fps, ${m.width} px)`;
    case "liveStop": return ` (stream ${m.stream})`;
    case "drop": return ` (owner ${m.owner})`;
    default: return "";
  }
}
function describeResult(op, r) {
  if (!r) return "";
  if (op === "grab" && r.jpeg) return ` (${bytes(r.jpeg.length)} JPEG, ${r.meta && r.meta.thumbWidth}x${r.meta && r.meta.thumbHeight})`;
  if (op === "sources" && Array.isArray(r)) return ` (${r.length} source${r.length === 1 ? "" : "s"})`;
  if (op === "hello") return r.ok ? ` (NDI Runtime ${r.version})` : "";
  return "";
}
// the hello answer is a success of the request, but "ok" would mislead when it says there is no NDI Runtime
const answered = (op, r) => (op === "hello" && r && r.ok === false ? `answered: no NDI Runtime (${short(r.error)})` : "ok");

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
    // Verbose lines for everything this client and the NDI host do. It is on while at least one node asks for it
    // (setVerbose), and the host process is told, so its own lines come back over the IPC channel.
    this.vlog = createVLog((s) => this.log.info(s));
    this.verboseOwners = new Set();
    this.spawnedAt = 0;
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

  // A node turns verbose logging on or off for itself; it is on here while any node wants it.
  setVerbose(owner, on) {
    const before = this.vlog.on;
    if (on) this.verboseOwners.add(owner); else this.verboseOwners.delete(owner);
    const now = this.verboseOwners.size > 0;
    if (before && !now) this.vlog.line("host", "verbose logging off: no node asks for it any more");
    this.vlog.on = now;
    if (now !== before) {
      if (now) this.vlog.line("host", `verbose logging on (${this.verboseOwners.size} node${this.verboseOwners.size === 1 ? "" : "s"} asking for it)`);
      if (this.child && this.child.connected) { try { this.child.send({ cmd: "verbose", on: this.vlog.on }); } catch (e) { /* host is going away */ } }
    }
  }

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
    const env = { ...process.env, ...cfg.env, NDI_PREVIEW_HOST: "1", ELECTRON_RUN_AS_NODE: "1", NDI_PREVIEW_VERBOSE: this.vlog.on ? "1" : "" };
    this.vlog.line("config", cfg.applied
      ? `NDI configuration copy with TCP receive written to ${cfg.dir} (your own NDI settings are kept)`
      : `NDI configuration left as it is: ${cfg.reason}`);
    this.vlog.line("host", `starting the NDI host process: ${process.execPath} ${HOST_SCRIPT}`);
    this.spawnedAt = Date.now();
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
    this.vlog.line("host", `process started, pid ${child.pid}; waiting for its first answer`);
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
    if (this.live.size) this.vlog.line("host", `restarting ${this.live.size} live stream${this.live.size === 1 ? "" : "s"} that were running before`);
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
    if (m.event === "log") { if (typeof m.text === "string") this.vlog.raw(m.text); return; }
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
    if (this.vlog.on) {
      const waiting = [...this.pending.values()].map((p) => p.what).filter(Boolean);
      this.vlog.line("host", `process ${child.pid || "(never started)"} exited (${why}) after ${Math.round((Date.now() - this.spawnedAt) / 100) / 10} s; ${this.pending.size} request${this.pending.size === 1 ? "" : "s"} waiting for it will fail${waiting.length ? ` (${waiting.slice(0, 5).join("; ")}${waiting.length > 5 ? "; …" : ""})` : ""}${this.stopping ? "; Node-RED asked for this" : ""}`);
    }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(`the NDI host stopped (${why})`), { code: "EHOSTEXIT" })); }
    this.pending.clear();
    if (this.stopping) return;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (this.crashes.length >= this.maxCrashes) {
      this.failed = `the NDI host stopped ${this.crashes.length} times in a minute, so it is not restarted; restart Node-RED to try again`;
      this.log.warn(this.failed);
      this.vlog.line("host", `giving up: ${this.crashes.length} exits within ${CRASH_WINDOW_MS / 1000} s reached the limit of ${this.maxCrashes}; no more restarts until Node-RED restarts`);
      this.emit("state", "failed", this.failed);
      return;
    }
    const backoff = Math.min(30000, this.backoffBaseMs * 2 ** (this.crashes.length - 1));
    this.nextStartAt = now + backoff;
    this.log.warn(`the NDI host stopped (${why}); restarting in ${Math.round(backoff / 100) / 10} s`);
    this.vlog.line("host", `restart ${this.crashes.length} of ${this.maxCrashes - 1} allowed within a minute: waiting ${Math.round(backoff / 100) / 10} s because the host exited (${why})${this.live.size ? `; ${this.live.size} live stream(s) will resume` : "; it restarts when something next needs it"}`);
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
      if (!child || !child.connected) { this.vlog.line("host", `request ${msg.op} not sent: the NDI host is not running`); reject(Object.assign(new Error("the NDI host is not running"), { code: "EHOSTEXIT" })); return; }
      const id = ++this.seq;
      const t0 = Date.now();
      const noisy = msg.op === "ping";               // heartbeats are logged only when they fail
      // grabs repeat on a timer: one line per 10 s with a count of those left out, never one per grab
      const note = (text, key) => { if (!noisy) { if (key) this.vlog.rate(key, "host", text, 10000); else this.vlog.line("host", text); } };
      const what = this.vlog.on ? `${msg.op}${describeArgs(msg)}` : msg.op;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.vlog.line("host", `request #${id} ${what} timed out after ${Date.now() - t0} ms (limit ${timeoutMs} ms)`);
        reject(Object.assign(new Error("the NDI host did not answer in time"), { code: "ETIMEOUT" }));
        if (watch) this._checkAlive(child);
      }, timeoutMs);
      timer.unref?.();
      const wrap = (ok) => (v) => {
        const ms = Date.now() - t0;
        if (ok) note(`request #${id} ${what} -> ${answered(msg.op, v)}${describeResult(msg.op, v)}, ${ms} ms`, msg.op === "grab" ? "req-grab" : null);
        else note(`request #${id} ${what} -> failed (${v.code || "error"}): ${short(v.message)}, ${ms} ms`, msg.op === "grab" ? "req-grab-fail" : null);
        return ok ? resolve(v) : reject(v);
      };
      this.pending.set(id, { resolve: wrap(true), reject: wrap(false), timer, what: msg.op === "ping" ? null : what });
      try { child.send({ ...msg, id }); } catch (e) {
        clearTimeout(timer); this.pending.delete(id);
        this.vlog.line("host", `request #${id} ${msg.op} could not be sent: ${e.message}`);
        reject(Object.assign(new Error("the NDI host is not running"), { code: "EHOSTEXIT" }));
      }
    });
  }

  // a request timed out: if the host does not answer a ping either, it is hung, so end it (it then restarts)
  _checkAlive(child) {
    if (child !== this.child || child.checking) return;
    child.checking = true;
    const t0 = Date.now();
    this._send({ op: "ping" }, PING_MS, false).then(
      () => { child.checking = false; if (this.vlog.on) this.vlog.line("host", `ping answered in ${Date.now() - t0} ms: the host is alive, so the slow request was just slow`); },
      () => {
        if (child === this.child) {
          this.vlog.line("host", `ping not answered within ${PING_MS} ms: the host (pid ${child.pid}) is hung, ending it with SIGKILL; it restarts after a pause`);
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
    this.vlog.line("host", this.child ? `stopping the NDI host process (pid ${this.child.pid}): Node-RED is shutting down its runtime` : "stop requested; no host process is running");
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
