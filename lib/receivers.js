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

const keyOf = (source, bandwidth) =>
  JSON.stringify([source.name || "", source.address || "", bandwidth === "highest" ? "highest" : "lowest"]);

class Receiver {
  constructor(addon, key, source, bandwidth, label) {
    this.addon = addon;
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
    if (!this.h) { this.h = this.addon.open(this.opts); this.openedAt = Date.now(); this.lastFrame = null; this.lastNewAt = 0; }
    return this.h;
  }

  // The newest frame, or null when none has arrived yet. Never waits. NDI's FrameSync repeats the last frame until
  // a new one arrives (also after the source has gone), so an unchanged frame is not copied again, and lastNewAt
  // says when the picture last really changed.
  poll() {
    const since = this.lastFrame ? this.lastFrame.timestamp : undefined;
    const f = this.addon.grab(this.ensureOpen(), since);
    if (f === false) return this.lastFrame;                 // nothing new since the frame we already have
    if (f) { this.lastFrame = f; this.lastNewAt = Date.now(); }
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

  close() {
    if (this.h) { try { this.addon.close(this.h); } catch (e) { /* already closed */ } }
    this.h = null;
    this.lastFrame = null;
  }
}

class ReceiverPool {
  constructor(addon, { sweepMs = 1000 } = {}) {
    this.addon = addon;
    this.receivers = new Map();
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref?.();
  }

  get(source, bandwidth, label) {
    const bw = bandwidth === "highest" ? "highest" : "lowest";
    const key = keyOf(source, bw);
    let r = this.receivers.get(key);
    if (!r) { r = new Receiver(this.addon, key, source, bw, label || "Node-RED NDI Preview"); this.receivers.set(key, r); }
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
      if (!r.needed(now)) { r.close(); this.receivers.delete(key); }
    }
  }

  openCount() { let n = 0; for (const r of this.receivers.values()) if (r.open) n++; return n; }

  closeAll() {
    clearInterval(this.timer);
    for (const r of this.receivers.values()) r.close();
    this.receivers.clear();
  }
}

module.exports = { ReceiverPool, keyOf };
