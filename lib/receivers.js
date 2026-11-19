"use strict";
// Shared NDI receivers, one per source and bandwidth, inside the NDI host process.
//
// Every node that shows the same source (stills and live previews alike) uses the same receiver, so each camera
// sees one connection from this computer, however many nodes and viewers there are.
//
// A receiver stays open while something needs it:
//   - a live preview HOLDS it for as long as it runs;
//   - a still grab KEEPS it for that node's idle time after the grab (0 = close straight after).
// When nothing holds or keeps it, it is closed (the sweep runs every second).

const { fourccName } = require("./frame");
const { bytes, short } = require("./vlog");

// a summary of each receiver's traffic this often (tests may shorten it; the add-on stand-in must be in use for that)
const SUMMARY_MS = (process.env.NDI_PREVIEW_TEST_ADDON && Number(process.env.NDI_PREVIEW_TEST_SUMMARY_MS)) || 10000;
// a receiver that is opened and closed for every grab (idle time 0) would log three lines per grab: those lines are
// shown at most once per this many ms for each source, with a count of those left out
const REPEAT_MS = 10000;
const NOOP_LOG = { on: false, line() {}, raw() {}, rate() {} };

const keyOf = (source, bandwidth) =>
  JSON.stringify([source.name || "", source.address || "", bandwidth === "highest" ? "highest" : "lowest"]);

class Receiver {
  constructor(addon, key, source, bandwidth, label, vlog) {
    this.addon = addon;
    this.vlog = vlog || NOOP_LOG;
    this.name = short(source.name || source.address || "(no source)");
    this.bw = bandwidth === "highest" ? "full" : "proxy";
    this.fmt = null;                    // "640x360 UYVY" of the newest frame, to log each change
    this.connected = null;              // last connection state seen, to log each change
    this.sum = { delivered: 0, skipped: 0, bytes: 0 };   // what was handed on since the last summary
    this.sumAt = 0;
    this.sumTotal = 0;                  // the add-on's framesTotal at the last summary
    this.key = key;
    this.opts = { name: source.name || undefined, address: source.address || undefined, bandwidth, label };
    this.h = null;
    this.openedAt = 0;
    this.holders = new Set();           // live streams
    this.keeps = new Map();             // owner -> keep open until (ms since epoch)
    this.lastFrame = null;              // the newest frame seen, shared by everyone using this receiver
    this.lastNewAt = 0;                 // when a frame with a new timestamp last arrived
  }

  get open() { return !!this.h; }

  ensureOpen() {
    if (!this.h) {
      this.h = this.addon.open(this.opts);
      this.openedAt = Date.now(); this.lastFrame = null; this.lastNewAt = 0;
      this.fmt = null; this.connected = null; this.sumAt = this.openedAt; this.sumTotal = 0;
      this.sum = { delivered: 0, skipped: 0, bytes: 0 };
      this.vlog.rate("open:" + this.key, "receiver", `"${this.name}" (${this.bw}): connecting, receiver opened for "${short(this.opts.label)}"`, REPEAT_MS);
    }
    return this.h;
  }

  // The newest frame, or null when none has arrived yet. Never waits. NDI's FrameSync repeats the last frame until
  // a new one arrives (also after the source has gone), so an unchanged frame is not copied again, and lastNewAt
  // says when the picture last really changed.
  poll() {
    const since = this.lastFrame ? this.lastFrame.timestamp : undefined;
    const f = this.addon.grab(this.ensureOpen(), since);
    if (f === false) return this.lastFrame;                 // nothing new since the frame we already have
    if (f) {
      const first = !this.lastFrame;
      this.lastFrame = f; this.lastNewAt = Date.now();
      // log only a new format, never a frame; this runs on every frame, so it compares numbers first
      if (this.vlog.on && (first || f.xres !== this.fx || f.yres !== this.fy || f.fourCC !== this.fc)) {
        const was = this.fmt;
        this.fx = f.xres; this.fy = f.yres; this.fc = f.fourCC;
        this.fmt = `${f.xres}x${f.yres} ${fourccName(f.fourCC)}`;
        const fps = f.frameRateD ? Math.round((f.frameRateN / f.frameRateD) * 100) / 100 : "?";
        if (was) this.vlog.line("receiver", `"${this.name}": format changed from ${was} to ${this.fmt} at ${fps} frames/s`);
        else this.vlog.rate("first:" + this.key, "receiver", `"${this.name}": first frame ${this.fmt} at ${fps} frames/s, ${this.lastNewAt - this.openedAt} ms after connecting`, REPEAT_MS);
      }
    }
    return f;
  }

  stats() {
    if (!this.h) return { connections: 0, framesTotal: 0, framesDropped: 0, connectedForMs: 0 };
    return { ...this.addon.stats(this.h), connectedForMs: Date.now() - this.openedAt };
  }

  // A current frame: one that arrived within the last timeoutMs, waiting up to timeoutMs for it, so a source that
  // has stopped is reported instead of its last picture being shown again. Rejects with a readable reason.
  async waitFrame(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const f = this.poll();
      // fresh, and still connected: a frame seen for the first time can still be the last one a dead source sent
      if (f && Date.now() - this.lastNewAt <= timeoutMs && this.stats().connections > 0) return f;
      if (Date.now() - t0 >= timeoutMs) {
        const { connections } = this.stats();
        if (f) throw new Error(connections ? `no new video for ${Math.round((Date.now() - this.lastNewAt) / 1000)} s` : "the source has gone");
        throw new Error(connections ? `connected, but no video arrived within ${timeoutMs} ms` : "source not found, or it did not answer");
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  needed(now) {
    if (this.holders.size) return true;
    for (const until of this.keeps.values()) if (until > now) return true;
    return false;
  }

  // the connection comes and goes; log each change, and a summary of the traffic every few seconds
  watch(now) {
    if (!this.h || !this.vlog.on) return;
    let st;
    try { st = this.addon.stats(this.h); } catch (e) { return; }
    const up = st.connections > 0;
    if (this.connected !== up && !(this.connected === null && !up && now - this.openedAt < 1000)) {
      if (this.connected === null && up) this.vlog.rate("conn:" + this.key, "receiver", `"${this.name}": connected to the source`, REPEAT_MS);
      else if (up) this.vlog.line("receiver", `"${this.name}": connection is back`);
      else if (this.connected === null) this.vlog.rate("noconn:" + this.key, "receiver", `"${this.name}": no connection to the source yet (not found, or it did not answer)`, REPEAT_MS);
      else this.vlog.line("receiver", `"${this.name}": connection lost: the source stopped or went away`);
      this.connected = up;
    }
    if (now - this.sumAt >= SUMMARY_MS) {
      const secs = (now - this.sumAt) / 1000;
      const got = st.framesTotal - this.sumTotal;
      const { delivered, skipped, bytes: b } = this.sum;
      if (got || delivered || skipped) {
        this.vlog.line("receiver", `"${this.name}" last ${Math.round(secs)} s: ${got} frames received (${Math.round(got / secs * 10) / 10}/s), ${delivered} used${delivered ? ` (average ${bytes(Math.round(b / delivered))})` : ""}, ${skipped} skipped because Node-RED was behind, ${st.framesDropped} dropped by the NDI Runtime in total`);
      }
      this.sumAt = now; this.sumTotal = st.framesTotal; this.sum = { delivered: 0, skipped: 0, bytes: 0 };
    }
  }

  close(why) {
    if (this.h) {
      this.vlog.rate("close:" + this.key + (why || ""), "receiver", `"${this.name}": closed after ${Math.round((Date.now() - this.openedAt) / 100) / 10} s: ${why || "nothing needs it any more"}`, REPEAT_MS);
      try { this.addon.close(this.h); } catch (e) { /* already closed */ }
    }
    this.h = null;
    this.lastFrame = null;
  }
}

class ReceiverPool {
  constructor(addon, { sweepMs = 1000, vlog } = {}) {
    this.addon = addon;
    this.vlog = vlog || NOOP_LOG;
    this.receivers = new Map();
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref?.();
  }

  get(source, bandwidth, label) {
    const bw = bandwidth === "highest" ? "highest" : "lowest";
    const key = keyOf(source, bw);
    let r = this.receivers.get(key);
    if (!r) { r = new Receiver(this.addon, key, source, bw, label || "Node-RED NDI Preview", this.vlog); this.receivers.set(key, r); }
    return r;
  }

  keep(r, owner, idleMs) {
    const until = Date.now() + Math.max(0, idleMs);
    r.keeps.set(owner, Math.max(r.keeps.get(owner) || 0, until));
  }

  hold(r, holder) { r.holders.add(holder); }

  // now = true closes an unneeded receiver at once; otherwise the next sweep (within a second) does, so a stream that
  // is restarted straight away keeps the same connection to the camera
  release(r, holder, now = true) { r.holders.delete(holder); if (now) this.sweep(); }

  // forget everything an owner kept open (a node was paused, changed or removed)
  drop(owner) {
    for (const r of this.receivers.values()) r.keeps.delete(owner);
    this.sweep();
  }

  sweep() {
    const now = Date.now();
    for (const [key, r] of this.receivers) {
      for (const [owner, until] of r.keeps) if (until <= now) r.keeps.delete(owner);
      if (!r.needed(now)) { r.close("no live preview holds it and no still keeps it open"); this.receivers.delete(key); }
      else r.watch(now);
    }
  }

  openCount() { let n = 0; for (const r of this.receivers.values()) if (r.open) n++; return n; }

  closeAll() {
    clearInterval(this.timer);
    for (const r of this.receivers.values()) r.close("the NDI host is shutting down");
    this.receivers.clear();
  }
}

module.exports = { ReceiverPool, keyOf };
