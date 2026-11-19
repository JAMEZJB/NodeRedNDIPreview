"use strict";
// ndi-live: a silent, low-latency live preview of an NDI source, served as Motion-JPEG over HTTP so a plain
// <img src="..."> shows it in any browser. It is a preview for checking a picture, not a programme monitor.
//
//   GET <httpNodeRoot>/ndi-live/<node id>.mjpg   the live picture (multipart/x-mixed-replace)
//   GET <httpNodeRoot>/ndi-live/<node id>.jpg    one still of the same picture
//
// The NDI receiver runs only while someone is watching: the first viewer starts it, and it stops a few seconds
// after the last viewer leaves. Each frame is encoded once (in the NDI host process) and the same bytes go to every
// viewer; a viewer that falls behind skips frames instead of building a queue.
// These endpoints sit on Node-RED's normal HTTP node server, so httpNodeAuth (if set) protects them too.
const { getClient } = require("../lib/host-client");
const { createVLog, bytes, short } = require("../lib/vlog");
const { registerAdmin, watchRuntime, statusForRuntime, CHECKING } = require("../lib/admin");

const BOUNDARY = "ndipreviewframe";
const STOP_GRACE_MS = 5000;
const FRESH_MS = 2000;
// verbose logging: one summary line this often while streaming (tests may shorten it, only with the add-on stand-in)
const SUMMARY_MS = (process.env.NDI_PREVIEW_TEST_ADDON && Number(process.env.NDI_PREVIEW_TEST_SUMMARY_MS)) || 10000;
const STUCK_MS = 10000;          // a viewer that has not taken a frame for this long is disconnected
const HOST_STOPPED = "the NDI helper has stopped; restart Node-RED";
const liveNodes = new Map();
let routed = false;

function joinUrl(root, rest) {
  const r = typeof root === "string" ? root : "/";
  return (r.endsWith("/") ? r : r + "/") + rest;
}

module.exports = function (RED) {
  registerAdmin(RED);

  if (!routed && RED.httpNode) {
    routed = true;
    RED.httpNode.get("/ndi-live/:file", (req, res) => {
      const m = /^([A-Za-z0-9_.-]{1,64})\.(mjpg|jpg)$/.exec(req.params.file || "");   // older flows have dotted ids
      const n = m && liveNodes.get(m[1]);
      if (!n) { res.status(404).type("text/plain").send("No NDI live preview with that id is deployed."); return; }
      if (m[2] === "mjpg") n.serveStream(req, res); else n.serveStill(req, res);
    });
  }

  function NdiLiveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const client = getClient(RED);
    const source = { name: config.source || "", address: config.address || "" };
    const bandwidth = config.bandwidth === "highest" ? "highest" : "lowest";
    const fps = Math.max(1, Math.min(15, Math.round(Number(config.fps) || 10)));
    const width = Math.max(32, Math.min(1280, Number(config.width) || 640));
    const quality = Math.max(10, Math.min(95, Number(config.quality) || 60));
    const maxViewers = Math.max(1, Math.min(32, Math.round(Number(config.maxViewers) || 4)));
    const timeoutMs = Math.max(1000, (Number(config.timeout) || 5) * 1000);
    const label = "Node-RED " + (config.name || "NDI Preview") + " (live preview)";
    const streamUrl = joinUrl(RED.settings.httpNodeRoot, `ndi-live/${node.id}.mjpg`);
    const stillUrl = joinUrl(RED.settings.httpNodeRoot, `ndi-live/${node.id}.jpg`);

    const verbose = config.verbose === true || config.verbose === "true";   // a flow saved without it means off
    const vlog = createVLog((s) => node.log(s), { on: verbose });
    client.setVerbose(node.id, verbose);
    const shown = short(source.name || source.address);
    vlog.line("config", `ndi-live "${short(config.name || node.id)}" started: source "${short(source.name)}"${source.address ? `, address ${short(source.address)}` : ""}, ` +
      `${fps} frames/s, ${width} px wide, quality ${quality}, ${bandwidth === "highest" ? "full" : "proxy"} stream, at most ${maxViewers} viewers, ` +
      `no-video limit ${timeoutMs / 1000} s, stream at ${streamUrl}, verbose logging on`);

    const viewers = new Set();
    const win = { frames: 0, bytes: 0, skipped: 0, since: Date.now() };   // counters for the summary line
    let summaryTimer = null;
    let rt = null, streaming = false, paused = false, closed = false, stopTimer = null, hostFailed = false;
    let stillPending = null;               // one still grab at a time, shared by every .jpg request
    let last = null;                       // { jpeg, meta, at }
    let state = "idle", stateError = null;
    let frameTimes = [];
    let statusTimer = null;

    function measuredFps() {
      const now = Date.now();
      frameTimes = frameTimes.filter((t) => now - t < 2000);
      return Math.round(frameTimes.length / 2);
    }

    function showStatus() {
      if (closed) return;
      if (hostFailed) { node.status(statusForRuntime({ ok: false, host: true, failed: true })); return; }
      if (rt && !rt.ok) { node.status(statusForRuntime(rt)); return; }
      if (!RED.httpNode) { node.status({ fill: "red", shape: "ring", text: "HTTP endpoints are off (httpNodeRoot)" }); return; }
      if (!source.name && !source.address) { node.status({ fill: "grey", shape: "ring", text: "no source set" }); return; }
      if (paused) { node.status({ fill: "grey", shape: "ring", text: "paused" }); return; }
      const v = `${viewers.size} viewer${viewers.size === 1 ? "" : "s"}`;
      if (!streaming) { node.status({ fill: "grey", shape: "ring", text: `idle · ${v}` }); return; }
      if (state === "novideo" || state === "error") { node.status({ fill: "red", shape: "ring", text: `${(stateError || "no video").slice(0, 40)} · ${v}` }); return; }
      if (state === "live") { node.status({ fill: "green", shape: "dot", text: `live · ${v} · ${measuredFps()} fps` }); return; }
      node.status({ fill: "blue", shape: "ring", text: `connecting · ${v}` });
    }

    function info() {
      const error = hostFailed ? HOST_STOPPED : rt && !rt.ok ? rt.error : null;
      return {
        payload: streamUrl,
        ndi: {
          source: source.name || source.address, stream: streamUrl, still: stillUrl, viewers: viewers.size,
          live: streaming, paused, maxViewers, fps, width, bandwidth, runtime: rt ? rt.version || null : null,
          ...(error ? { error } : {}),
        },
      };
    }

    // The node sends info() when the flow starts, and again whenever what it says about the NDI Runtime changes
    // (for example the helper answered late, or stopped), so a flow showing it never keeps a stale answer.
    let announced = null;
    function announce() {
      if (closed) return;
      const { runtime, error } = info().ndi;
      const key = JSON.stringify([runtime, error || null]);
      if (key === announced) return;
      announced = key;
      node.send(info());
    }

    function startStream() {
      clearTimeout(stopTimer); stopTimer = null;
      if (streaming || paused || closed) return;
      streaming = true; state = "starting"; stateError = null;
      vlog.line("receiver", `live preview starting for "${shown}": the first viewer arrived`);
      Object.assign(win, { frames: 0, bytes: 0, skipped: 0, since: Date.now() });
      if (verbose && !summaryTimer) {
        summaryTimer = setInterval(summarise, SUMMARY_MS);
        summaryTimer.unref?.();
      }
      if (!statusTimer) { statusTimer = setInterval(showStatus, 1000); statusTimer.unref?.(); }
      showStatus();
      client.liveStart(node.id, { source, bandwidth, fps, width, quality, label, timeoutMs }).catch((e) => {
        if (closed) return;
        vlog.line("receiver", `live preview could not start (${e.code || "error"}): ${short(e.message)}; viewers are disconnected`);
        if (e.code === "ENORUNTIME") { rt = { ok: false, error: e.message }; announce(); }
        node.warn(`NDI live "${source.name || source.address}": ${e.message}`);
        stopStream();
        endViewers();
      });
    }

    function summarise() {
      if (!streaming) return;
      const secs = (Date.now() - win.since) / 1000;
      vlog.line("frame", `live "${shown}" last ${Math.round(secs)} s: ${win.frames} frames from the NDI helper (${Math.round(win.frames / secs * 10) / 10}/s) ` +
        `to ${viewers.size} viewer${viewers.size === 1 ? "" : "s"}${win.frames ? `, average ${bytes(Math.round(win.bytes / win.frames))}` : ", none arrived"}, ${win.skipped} not sent to a slow viewer, state ${state}`);
      Object.assign(win, { frames: 0, bytes: 0, skipped: 0, since: Date.now() });
    }

    function stopStream(why) {
      clearTimeout(stopTimer); stopTimer = null;
      clearInterval(statusTimer); statusTimer = null;
      clearInterval(summaryTimer); summaryTimer = null;
      if (streaming) {
        vlog.line("receiver", `live preview stopping: ${typeof why === "string" ? why : "told to stop"}`);
        streaming = false; client.liveStop(node.id);
      }
      state = "idle";
      showStatus();
    }

    function endViewers() {
      for (const res of viewers) vlog.line("http", `viewer ${res.viewerAddr} disconnected by the node (${res.sent || 0} frames sent to it)`);
      for (const res of viewers) { try { res.end(); } catch (e) { /* already gone */ } }
      viewers.clear();
      showStatus();
    }

    function writeFrame(res, jpeg) {
      if (res.writableNeedDrain) {                        // this viewer is behind: skip, never queue
        win.skipped++;
        if (!res.stuckSince) res.stuckSince = Date.now();
        else if (Date.now() - res.stuckSince > STUCK_MS) {
          vlog.line("http", `viewer ${res.viewerAddr} has taken no frame for ${STUCK_MS / 1000} s: disconnecting it to free its place`);
          res.destroy();   // gone quiet: free its place
        }
        return;
      }
      res.sent = (res.sent || 0) + 1;
      res.stuckSince = 0;
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write("\r\n");
    }

    function onFrame(stream, jpeg, meta) {
      if (stream !== node.id || closed) return;
      last = { jpeg, meta, at: Date.now() };
      win.frames++; win.bytes += jpeg.length;
      frameTimes.push(last.at);
      for (const res of viewers) writeFrame(res, jpeg);
    }
    function onLiveStatus(stream, s, error) {
      if (stream !== node.id || closed) return;
      if (state !== s) vlog.line("receiver", `live preview "${shown}": ${state} -> ${s}${error ? ` (${short(error)})` : ""}`);
      state = s; stateError = error;
      if (s === "novideo" || s === "error") node.warn(`NDI live "${source.name || source.address}": ${error}`);
      showStatus();
    }
    function onHostState(s, why) {
      if (closed) return;
      if (s === "failed") { vlog.line("host", `the NDI helper gave up: ${short(why)}; viewers are disconnected and this node stays stopped`); hostFailed = true; node.error(why); stopStream(); endViewers(); announce(); }
    }
    client.on("frame", onFrame);
    client.on("liveStatus", onLiveStatus);
    client.on("state", onHostState);

    function refuse(res, code, text) {
      res.status(code).set({ "Cache-Control": "no-store", "Retry-After": "5" }).type("text/plain").send(text);
    }

    const from = (req) => (req.socket && req.socket.remoteAddress) || "unknown address";
    function refuseNote(req, res, code, text) {
      vlog.rate("refuse", "http", `request from ${from(req)} for ${req.path} refused with ${code}: ${text}`);
      refuse(res, code, text);
    }

    node.serveStream = (req, res) => {
      if (hostFailed) { refuseNote(req, res, 503, "The NDI helper has stopped; restart Node-RED."); return; }
      if (paused) { refuseNote(req, res, 503, "This NDI live preview is paused."); return; }
      if (rt && !rt.ok) { refuseNote(req, res, 503, "The NDI Runtime is not installed on the Node-RED computer (see ndi.video)."); return; }
      if (!source.name && !source.address) { refuseNote(req, res, 503, "No NDI source is set."); return; }
      if (viewers.size >= maxViewers) { refuseNote(req, res, 503, `This NDI live preview already has ${maxViewers} viewers.`); return; }
      res.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        Connection: "close",
        "X-Content-Type-Options": "nosniff",
      });
      viewers.add(res);
      res.viewerAddr = from(req);
      const joined = Date.now();
      vlog.line("http", `viewer ${res.viewerAddr} connected to the live stream (viewers now ${viewers.size} of ${maxViewers})`);
      const gone = () => {
        if (!viewers.delete(res)) return;
        vlog.line("http", `viewer ${res.viewerAddr} left after ${Math.round((Date.now() - joined) / 100) / 10} s, ${res.sent || 0} frames sent to it (viewers now ${viewers.size})`);
        if (!viewers.size && streaming && !stopTimer) vlog.line("receiver", `no viewers left: the live preview stops in ${STOP_GRACE_MS / 1000} s unless someone returns`);
        showStatus();
        if (!viewers.size && streaming && !stopTimer) { stopTimer = setTimeout(() => stopStream(`no viewers for ${STOP_GRACE_MS / 1000} s`), STOP_GRACE_MS); stopTimer.unref?.(); }
      };
      res.on("close", gone);
      res.on("error", gone);
      startStream();
      if (last && Date.now() - last.at < FRESH_MS) writeFrame(res, last.jpeg);
      showStatus();
    };

    node.serveStill = async (req, res) => {
      const t0 = Date.now();
      if (hostFailed) { refuseNote(req, res, 503, "The NDI helper has stopped; restart Node-RED."); return; }
      if (paused) { refuseNote(req, res, 503, "This NDI live preview is paused."); return; }
      const send = (jpeg) => res.status(200).set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(jpeg);
      if (last && Date.now() - last.at < FRESH_MS) {
        vlog.rate("still", "http", `still asked for by ${from(req)}: sent the live picture, ${Date.now() - last.at} ms old, ${bytes(last.jpeg.length)}`);
        send(last.jpeg); return;
      }
      try {
        // many requests at once share one grab, so a burst of stills cannot queue up work in the NDI helper
        if (!stillPending) {
          stillPending = client.grab({ owner: node.id + ":still", source, bandwidth, width, quality, timeoutMs, idleMs: STOP_GRACE_MS, label })
            .finally(() => { stillPending = null; });
        }
        const r = await stillPending;
        vlog.rate("still", "http", `still asked for by ${from(req)}: no live picture is fresh, so one was grabbed: ${bytes(r.jpeg.length)}, ${r.meta.thumbWidth}x${r.meta.thumbHeight}, ${Date.now() - t0} ms`);
        send(r.jpeg);
      } catch (e) {
        vlog.rate("still-fail", "http", `still asked for by ${from(req)}: no picture after ${Date.now() - t0} ms: ${short(e.message)}`);
        refuse(res, 503, `No picture: ${e.message}`);
      }
    };

    node.on("input", (msg, send, done) => {
      const cmd = typeof msg.payload === "string" ? msg.payload.trim().toLowerCase() : "";
      if (cmd === "stop" || msg.payload === false) {
        vlog.line("config", `a message${typeof msg.topic === "string" && msg.topic ? ` (topic "${short(msg.topic, 80)}")` : ""} said stop: ${viewers.size} viewer(s) disconnected, new ones refused`);
        paused = true; endViewers(); stopStream("a message said stop"); client.drop(node.id + ":still");
      } else if (cmd === "start" || msg.payload === true) { vlog.line("config", "a message said start: viewers are allowed again"); paused = false; showStatus(); }
      send({ ...RED.util.cloneMessage(msg), ...info() });
      done();
    });

    node.on("close", (removed, done) => {
      vlog.line("config", `closing (${removed ? "the node was deleted" : "redeploy or Node-RED stopping"}): ${viewers.size} viewer(s) disconnected, live preview stopped`);
      client.setVerbose(node.id, false);
      closed = true;
      clearInterval(summaryTimer);
      liveNodes.delete(node.id);
      client.off("frame", onFrame);
      client.off("liveStatus", onLiveStatus);
      client.off("state", onHostState);
      clearTimeout(stopTimer); clearInterval(statusTimer);
      for (const res of viewers) { try { res.end(); } catch (e) { /* already gone */ } }
      viewers.clear();
      const stops = [streaming ? client.liveStop(node.id) : null, client.drop(node.id + ":still")];
      Promise.all(stops).then(() => done(), () => done());
    });

    liveNodes.set(node.id, node);
    node.status(CHECKING);
    watchRuntime(RED, () => closed, (r) => {
      if (r.ok || !r.host || r.failed) rt = r;               // a host hiccup is not final: it is checked again
      vlog.line("host", r.ok ? `runtime check: NDI Runtime ${r.version} is available` : `runtime check: ${short(r.error)}${r.host && !r.failed ? "; will ask again in 10 s" : "; this node stays idle"}`);
      if (r.failed) hostFailed = true;
      if (!r.ok && r.host && !r.failed) node.status(statusForRuntime(r)); else showStatus();
      announce();                                            // tells the flow where the preview is
    });
  }

  RED.nodes.registerType("ndi-live", NdiLiveNode);
};
