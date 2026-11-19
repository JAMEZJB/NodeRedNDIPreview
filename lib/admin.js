"use strict";
// What both node types share in Node-RED: the editor's admin endpoints and the status texts.
const { getClient } = require("./host-client");
const { short } = require("./vlog");

const NOT_INSTALLED = { fill: "grey", shape: "ring", text: "NDI Runtime not installed (see ndi.video)" };
const CHECKING = { fill: "grey", shape: "ring", text: "checking for the NDI Runtime" };

function statusForRuntime(rt) {
  if (rt.ok) return null;
  if (rt.unsupported) return { fill: "grey", shape: "ring", text: "not available on this computer" };
  if (rt.failed) return { fill: "red", shape: "ring", text: "NDI helper stopped; restart Node-RED" };
  if (rt.host) return { fill: "red", shape: "ring", text: "NDI helper not answering; retrying" };
  return NOT_INSTALLED;
}

let registered = false;
let logged = false;

// The runtime check a node does when it starts. The NDI host is started by the first node (or the editor), not
// when Node-RED loads the palette, so a Node-RED with no NDI nodes deployed runs no extra process.
// The result is logged once.
function checkRuntime(RED) {
  return getClient(RED).runtime().then((rt) => {
    if (!logged && !rt.host) {
      logged = true;
      if (rt.ok) RED.log.info(`[ndi-preview] NDI Runtime ${rt.version} (${rt.path})`);
      else RED.log.warn(`[ndi-preview] ${rt.error}.${rt.help ? " " + rt.help + "." : ""} The NDI preview nodes stay idle.`);
    }
    return rt;
  });
}

// The runtime check for one node: calls onResult with each answer. A problem with the NDI host itself (it did not
// answer, or crashed once) is not final: the check is repeated every 10 s until there is a real answer or the node
// closes. A missing runtime or a host that has given up is final.
function watchRuntime(RED, isClosed, onResult) {
  const attempt = () => {
    if (isClosed()) return;
    checkRuntime(RED).then((rt) => {
      if (isClosed()) return;
      onResult(rt);
      if (!rt.ok && rt.host && !rt.failed) { const t = setTimeout(attempt, 10000); t.unref?.(); }
    });
  };
  attempt();
}

// Registered once, whichever node type loads first.
function registerAdmin(RED) {
  if (registered) return;
  registered = true;

  // Is the NDI Runtime installed on the Node-RED computer? (the editor's banner)
  RED.httpAdmin.get("/ndi-preview/runtime", RED.auth.needsPermission("ndi-preview.read"), async (req, res) => {
    const client = getClient(RED);
    const t0 = Date.now();
    const rt = await client.runtime({ refresh: req.query.refresh === "1" });
    client.vlog.line("http", `editor at ${req.socket && req.socket.remoteAddress} asked whether the NDI Runtime is installed${req.query.refresh === "1" ? " (checking again)" : ""}: ${rt.ok ? `yes, version ${rt.version}` : `no: ${short(rt.error)}`}, ${Date.now() - t0} ms`);
    res.json({ ok: rt.ok, version: rt.version, error: rt.error, help: rt.help, unsupported: !!rt.unsupported });
  });

  // One short NDI discovery from the Node-RED computer (the editor's "Find sources" button).
  RED.httpAdmin.get("/ndi-preview/sources", RED.auth.needsPermission("ndi-preview.read"), async (req, res) => {
    try {
      const client = getClient(RED);
      const from = req.socket && req.socket.remoteAddress;
      const t0 = Date.now();
      const rt = await client.runtime();
      if (!rt.ok) { client.vlog.line("http", `editor at ${from} asked for NDI sources: refused, no NDI Runtime (${short(rt.error)})`); res.status(503).json({ error: rt.error, help: rt.help }); return; }
      const list = await client.sources(2000);
      client.vlog.line("http", `editor at ${from} asked for NDI sources: ${list.length} found, ${Date.now() - t0} ms`);
      res.json(list);
    } catch (e) {
      getClient(RED).vlog.line("http", `editor asked for NDI sources: failed: ${short(e.message)}`);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerAdmin, checkRuntime, watchRuntime, statusForRuntime, NOT_INSTALLED, CHECKING };
