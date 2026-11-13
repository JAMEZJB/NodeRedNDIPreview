"use strict";
// ndi-thumbnail: an NDI source -> a JPEG still (msg.payload, a Buffer) plus frame statistics (msg.ndi).
// The message looks like an http request node's reply (statusCode 200, content-type image/jpeg), so it can feed
// flows that were built for a camera's still-image URL without changes.
// All NDI work happens in the NDI host process (lib/host.js); this file only schedules grabs and sends messages.
const { getClient } = require("../lib/host-client");
const { registerAdmin, watchRuntime, statusForRuntime, CHECKING } = require("../lib/admin");

module.exports = function (RED) {
  registerAdmin(RED);

  function NdiThumbnailNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const client = getClient(RED);
    const everyS = Math.max(0, Number(config.interval) || 0);           // 0 = only when a message arrives
    const width = Math.max(32, Math.min(1920, Number(config.width) || 320));
    const quality = Math.max(10, Math.min(95, Number(config.quality) || 70));
    const timeoutMs = Math.max(500, (Number(config.timeout) || 3) * 1000);
    const idleS = config.idle === "" || config.idle == null ? 30 : Math.max(0, Number(config.idle) || 0);
    const bandwidth = config.bandwidth === "highest" ? "highest" : "lowest";
    // A timer that fires within the idle time keeps the receiver open between grabs; a slower timer connects for
    // each grab. On input only, the receiver stays open for the idle time after each grab.
    const idleMs = everyS > 0 ? (everyS < idleS ? everyS * 1000 + 5000 : 0) : idleS * 1000;
    const label = "Node-RED " + (config.name || "NDI Preview");

    let rt = null, timer = null, busy = false, paused = false, misses = 0, closed = false;

    async function tick(msg, send, done) {
      send = send || node.send.bind(node);
      const name = (msg && typeof msg.source === "string" && msg.source) || config.source || "";
      const address = (msg && typeof msg.address === "string" && msg.address) || config.address || "";
      if (!name && !address) { node.status({ fill: "grey", shape: "ring", text: "no source set" }); if (done) done(); return; }
      if (busy) { if (done) done(); return; }                            // never stack grabs
      busy = true;
      const out = msg ? RED.util.cloneMessage(msg) : {};
      try {
        const r = await client.grab({ owner: node.id, source: { name, address }, bandwidth, width, quality, timeoutMs, idleMs, label });
        if (closed) return;
        misses = 0;
        out.payload = r.jpeg;
        out.statusCode = 200;
        out.headers = { "content-type": "image/jpeg" };
        out.ndi = { source: name || address, ...r.meta };
        node.status({ fill: "green", shape: "dot", text: `${r.meta.width}×${r.meta.height}${r.meta.fps ? " @ " + r.meta.fps : ""} · ${new Date().toLocaleTimeString()}` });
        send(out);
      } catch (e) {
        if (closed) return;
        if (e.code === "ENORUNTIME") { stopTimer(); rt = { ok: false }; node.status(statusForRuntime({ ok: false })); return; }
        if (e.code === "EHOSTFAILED") { stopTimer(); rt = { ok: false, host: true, failed: true }; node.status(statusForRuntime(rt)); node.error(e.message); return; }
        misses++;
        out.payload = null;
        out.ndi = { source: name || address, error: e.message, misses };
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 48) });
        if (misses === 1) node.warn(`NDI "${name || address}": ${e.message}`);   // once per outage, not every tick
        send(out);
      } finally {
        busy = false;
        if (done) done();
      }
    }

    function startTimer() {
      stopTimer();
      if (everyS > 0 && !paused && rt && rt.ok) timer = setInterval(() => tick(null), everyS * 1000);
    }
    function stopTimer() { clearInterval(timer); timer = null; }

    node.on("input", (msg, send, done) => {
      const cmd = typeof msg.payload === "string" ? msg.payload.trim().toLowerCase() : "";
      if (cmd === "stop" || msg.payload === false) {                     // e.g. the page showing it was hidden
        paused = true; stopTimer(); client.drop(node.id);
        node.status({ fill: "grey", shape: "ring", text: "paused" }); done(); return;
      }
      if (rt && !rt.ok) { node.status(statusForRuntime(rt)); done(); return; }   // nothing can run without NDI
      if (cmd === "start" || msg.payload === true) { paused = false; startTimer(); }
      tick(msg, send, done);
    });

    node.on("close", (done) => {
      closed = true;
      stopTimer();
      client.drop(node.id).then(() => done(), () => done());
    });

    node.status(CHECKING);
    watchRuntime(RED, () => closed, (r) => {
      if (!r.ok) { node.status(statusForRuntime(r)); if (!r.host || r.failed) rt = r; return; }   // a host hiccup is retried
      rt = r;
      node.status({ fill: "grey", shape: "ring", text: config.source || config.address || "no source set" });
      startTimer();
      if (everyS > 0) setTimeout(() => { if (!paused && !closed) tick(null); }, 500);
    });
  }

  RED.nodes.registerType("ndi-thumbnail", NdiThumbnailNode);
};
