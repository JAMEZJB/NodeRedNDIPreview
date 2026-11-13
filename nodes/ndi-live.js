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
const { registerAdmin, watchRuntime, statusForRuntime, CHECKING } = require("../lib/admin");

const BOUNDARY = "ndipreviewframe";
const STOP_GRACE_MS = 5000;
const FRESH_MS = 2000;
const STUCK_MS = 10000;          // a viewer that has not taken a frame for this long is disconnected
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

    const viewers = new Set();
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
      return {
        payload: streamUrl,
        ndi: {
          source: source.name || source.address, stream: streamUrl, still: stillUrl, viewers: viewers.size,
          live: streaming, paused, maxViewers, fps, width, bandwidth, runtime: rt ? rt.version || null : null,
          ...(rt && !rt.ok ? { error: rt.error } : {}),
        },
      };
    }

    function startStream() {
      clearTimeout(stopTimer); stopTimer = null;
      if (streaming || paused || closed) return;
      streaming = true; state = "starting"; stateError = null;
      if (!statusTimer) { statusTimer = setInterval(showStatus, 1000); statusTimer.unref?.(); }
      showStatus();
      client.liveStart(node.id, { source, bandwidth, fps, width, quality, label, timeoutMs }).catch((e) => {
        if (closed) return;
        if (e.code === "ENORUNTIME") rt = { ok: false, error: e.message };
        node.warn(`NDI live "${source.name || source.address}": ${e.message}`);
        stopStream();
        endViewers();
      });
    }

    function stopStream() {
      clearTimeout(stopTimer); stopTimer = null;
      clearInterval(statusTimer); statusTimer = null;
      if (streaming) { streaming = false; client.liveStop(node.id); }
      state = "idle";
      showStatus();
    }

    function endViewers() {
      for (const res of viewers) { try { res.end(); } catch (e) { /* already gone */ } }
      viewers.clear();
      showStatus();
    }

    function writeFrame(res, jpeg) {
      if (res.writableNeedDrain) {                        // this viewer is behind: skip, never queue
        if (!res.stuckSince) res.stuckSince = Date.now();
        else if (Date.now() - res.stuckSince > STUCK_MS) res.destroy();   // gone quiet: free its place
        return;
      }
      res.stuckSince = 0;
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write("\r\n");
    }

    function onFrame(stream, jpeg, meta) {
      if (stream !== node.id || closed) return;
      last = { jpeg, meta, at: Date.now() };
      frameTimes.push(last.at);
      for (const res of viewers) writeFrame(res, jpeg);
    }
    function onLiveStatus(stream, s, error) {
      if (stream !== node.id || closed) return;
      state = s; stateError = error;
      if (s === "novideo" || s === "error") node.warn(`NDI live "${source.name || source.address}": ${error}`);
      showStatus();
    }
    function onHostState(s, why) {
      if (closed) return;
      if (s === "failed") { hostFailed = true; node.error(why); stopStream(); endViewers(); }
    }
    client.on("frame", onFrame);
    client.on("liveStatus", onLiveStatus);
    client.on("state", onHostState);

    function refuse(res, code, text) {
      res.status(code).set({ "Cache-Control": "no-store", "Retry-After": "5" }).type("text/plain").send(text);
    }

    node.serveStream = (req, res) => {
      if (hostFailed) { refuse(res, 503, "The NDI helper has stopped; restart Node-RED."); return; }
      if (paused) { refuse(res, 503, "This NDI live preview is paused."); return; }
      if (rt && !rt.ok) { refuse(res, 503, "The NDI Runtime is not installed on the Node-RED computer (see ndi.video)."); return; }
      if (!source.name && !source.address) { refuse(res, 503, "No NDI source is set."); return; }
      if (viewers.size >= maxViewers) { refuse(res, 503, `This NDI live preview already has ${maxViewers} viewers.`); return; }
      res.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        Connection: "close",
        "X-Content-Type-Options": "nosniff",
      });
      viewers.add(res);
      const gone = () => {
        if (!viewers.delete(res)) return;
        showStatus();
        if (!viewers.size && streaming && !stopTimer) { stopTimer = setTimeout(stopStream, STOP_GRACE_MS); stopTimer.unref?.(); }
      };
      res.on("close", gone);
      res.on("error", gone);
      startStream();
      if (last && Date.now() - last.at < FRESH_MS) writeFrame(res, last.jpeg);
      showStatus();
    };

    node.serveStill = async (req, res) => {
      if (hostFailed) { refuse(res, 503, "The NDI helper has stopped; restart Node-RED."); return; }
      if (paused) { refuse(res, 503, "This NDI live preview is paused."); return; }
      const send = (jpeg) => res.status(200).set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(jpeg);
      if (last && Date.now() - last.at < FRESH_MS) { send(last.jpeg); return; }
      try {
        // many requests at once share one grab, so a burst of stills cannot queue up work in the NDI helper
        if (!stillPending) {
          stillPending = client.grab({ owner: node.id + ":still", source, bandwidth, width, quality, timeoutMs, idleMs: STOP_GRACE_MS, label })
            .finally(() => { stillPending = null; });
        }
        const r = await stillPending;
        send(r.jpeg);
      } catch (e) {
        refuse(res, 503, `No picture: ${e.message}`);
      }
    };

    node.on("input", (msg, send, done) => {
      const cmd = typeof msg.payload === "string" ? msg.payload.trim().toLowerCase() : "";
      if (cmd === "stop" || msg.payload === false) { paused = true; endViewers(); stopStream(); client.drop(node.id + ":still"); }
      else if (cmd === "start" || msg.payload === true) { paused = false; showStatus(); }
      send({ ...RED.util.cloneMessage(msg), ...info() });
      done();
    });

    node.on("close", (removed, done) => {
      closed = true;
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
    let announced = false;
    watchRuntime(RED, () => closed, (r) => {
      if (r.ok || !r.host || r.failed) rt = r;               // a host hiccup is not final: it is checked again
      if (r.failed) hostFailed = true;
      if (!r.ok && r.host && !r.failed) node.status(statusForRuntime(r)); else showStatus();
      if (!announced) { announced = true; node.send(info()); }   // tells the flow where the preview is
    });
  }

  RED.nodes.registerType("ndi-live", NdiLiveNode);
};
