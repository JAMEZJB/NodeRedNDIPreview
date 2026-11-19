"use strict";
// ndi-thumbnail: an NDI source -> a JPEG still (msg.payload, a Buffer) plus frame statistics (msg.ndi).
// The message looks like an http request node's reply (statusCode 200, content-type image/jpeg), so it can feed
// flows that were built for a camera's still-image URL without changes.
// All NDI work happens in the NDI host process (lib/host.js); this file only schedules grabs and sends messages.
const { getClient } = require("../lib/host-client");
const { createVLog, bytes, short } = require("../lib/vlog");
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
    const verbose = config.verbose === true || config.verbose === "true";   // a flow saved without it means off
    const vlog = createVLog((s) => node.log(s), { on: verbose });
    client.setVerbose(node.id, verbose);

    let rt = null, timer = null, busy = false, paused = false, misses = 0, closed = false;
    vlog.line("config", `ndi-thumbnail "${short(config.name || node.id)}" started: source "${short(config.source || "")}"${config.address ? `, address ${short(config.address)}` : ""}, ` +
      `${everyS ? `a still every ${everyS} s` : "a still only when a message arrives"}, ${width} px wide, quality ${quality}, ${bandwidth === "highest" ? "full" : "proxy"} stream, ` +
      `receiver ${idleMs ? `kept open ${idleMs / 1000} s after each grab` : "closed straight after each grab"}, give up after ${timeoutMs / 1000} s, verbose logging on`);

    async function tick(msg, send, done) {
      send = send || node.send.bind(node);
      const asker = msg ? `message${typeof msg.topic === "string" && msg.topic ? ` (topic "${short(msg.topic, 80)}")` : ""}` : "the timer";
      // a still on the timer repeats: one line per 10 s (with a count of those left out); one asked by a message is
      // an event, at most one a second
      const every = msg ? 1000 : 10000;
      const name = (msg && typeof msg.source === "string" && msg.source) || config.source || "";
      const address = (msg && typeof msg.address === "string" && msg.address) || config.address || "";
      if (!name && !address) { vlog.rate("nosrc", "frame", `still asked by ${asker} skipped: no source is set (set one in the node, or send msg.source)`, every); node.status({ fill: "grey", shape: "ring", text: "no source set" }); if (done) done(); return; }
      if (busy) { vlog.rate("busy", "frame", `still asked by ${asker} skipped: the previous grab for "${short(name || address)}" is still running`, every); if (done) done(); return; }                            // never stack grabs
      busy = true;
      const t0 = Date.now();
      const shown = short(name || address);
      const out = msg ? RED.util.cloneMessage(msg) : {};
      try {
        const r = await client.grab({ owner: node.id, source: { name, address }, bandwidth, width, quality, timeoutMs, idleMs, label });
        if (closed) return;
        if (misses) vlog.line("frame", `"${shown}" is delivering pictures again after ${misses} miss${misses === 1 ? "" : "es"} in a row`);
        misses = 0;
        vlog.rate(msg ? "ok" : "ok-timer", "frame", `still asked by ${asker}: "${shown}" -> ${bytes(r.jpeg.length)}, ${r.meta.thumbWidth}x${r.meta.thumbHeight} (stream ${r.meta.width}x${r.meta.height} ${r.meta.fourCC}), ${Date.now() - t0} ms in all (${r.meta.grabMs} ms waiting for the frame)${msg && typeof msg.source === "string" && msg.source ? "; source taken from msg.source" : ""}`, every);
        out.payload = r.jpeg;
        out.statusCode = 200;
        out.headers = { "content-type": "image/jpeg" };
        out.ndi = { source: name || address, ...r.meta };
        node.status({ fill: "green", shape: "dot", text: `${r.meta.width}×${r.meta.height}${r.meta.fps ? " @ " + r.meta.fps : ""} · ${new Date().toLocaleTimeString()}` });
        send(out);
      } catch (e) {
        if (closed) return;
        // the first failure in a row is always shown; repeats of an outage are collapsed (the miss count follows)
        vlog.rate("fail", "frame", `still asked by ${asker}: "${shown}" gave no picture after ${Date.now() - t0} ms (${e.code || "error"}): ${short(e.message)}`, misses ? 10000 : 0);
        if (e.code === "ENORUNTIME") { stopTimer(); rt = { ok: false }; node.status(statusForRuntime({ ok: false })); return; }
        if (e.code === "EHOSTFAILED") { stopTimer(); rt = { ok: false, host: true, failed: true }; node.status(statusForRuntime(rt)); node.error(e.message); return; }
        misses++;
        out.payload = null;
        out.ndi = { source: name || address, error: e.message, misses };
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 48) });
        if (misses > 1 && misses % 10 === 0) vlog.line("frame", `"${shown}": still failing, ${misses} misses in a row`);
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
        vlog.line("frame", `paused by a message${typeof msg.topic === "string" && msg.topic ? ` (topic "${short(msg.topic, 80)}")` : ""} saying stop: timer stopped, receiver released`);
        paused = true; stopTimer(); client.drop(node.id);
        node.status({ fill: "grey", shape: "ring", text: "paused" }); done(); return;
      }
      if (rt && !rt.ok) { vlog.rate("nort", "frame", `message ignored: ${short(rt.error || "the NDI Runtime or the NDI helper is not available")}`, 5000); node.status(statusForRuntime(rt)); done(); return; }   // nothing can run without NDI
      if (cmd === "start" || msg.payload === true) { vlog.line("frame", "resumed by a message saying start"); paused = false; startTimer(); }
      tick(msg, send, done);
    });

    node.on("close", (removed, done) => {
      vlog.line("config", `closing (${removed ? "the node was deleted" : "redeploy or Node-RED stopping"}): timer stopped, receiver released`);
      client.setVerbose(node.id, false);
      closed = true;
      stopTimer();
      client.drop(node.id).then(() => done(), () => done());
    });

    node.status(CHECKING);
    watchRuntime(RED, () => closed, (r) => {
      if (!r.ok) {
        vlog.line("host", `runtime check: ${short(r.error)}${r.host && !r.failed ? "; will ask again in 10 s" : "; this node stays idle"}`);
        node.status(statusForRuntime(r)); if (!r.host || r.failed) rt = r; return;
      }   // a host hiccup is retried
      vlog.line("host", `runtime check: NDI Runtime ${r.version} is available; ${everyS > 0 ? "timer starting" : "waiting for messages"}`);
      rt = r;
      node.status({ fill: "grey", shape: "ring", text: config.source || config.address || "no source set" });
      startTimer();
      if (everyS > 0) setTimeout(() => { if (!paused && !closed) tick(null); }, 500);
    });
  }

  RED.nodes.registerType("ndi-thumbnail", NdiThumbnailNode);
};
