"use strict";
// TEST-ONLY: an embedded Node-RED on 127.0.0.1 (random port, temporary user folder) with this package's nodes.
// Every message a "sink" function node receives lands in `sink`; a status node feeds node statuses to `statuses`.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function startNodeRed(flowNodes) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndi-preview-nr-"));
  const sink = [];
  const statuses = [];
  const flows = [
    { id: "tab1", type: "tab", label: "test" },
    { id: "sink", z: "tab1", type: "function", func: "global.get('sink').push(msg); return null;", outputs: 1, wires: [[]] },
    { id: "stat", z: "tab1", type: "status", scope: null, wires: [["statSink"]] },
    { id: "statSink", z: "tab1", type: "function", func: "global.get('statuses').push({ id: msg.status.source.id, text: msg.status.text, fill: msg.status.fill }); return null;", outputs: 1, wires: [[]] },
    ...flowNodes.map((n) => ({ z: "tab1", ...n })),
  ];
  fs.writeFileSync(path.join(userDir, "flows.json"), JSON.stringify(flows));
  const RED = require("node-red");
  const express = require("express");
  const app = express();
  const server = http.createServer(app);
  const settings = {
    userDir, flowFile: "flows.json", uiHost: "127.0.0.1", uiPort: 0,
    httpAdminRoot: "/admin", httpNodeRoot: "/api",
    nodesDir: [path.join(__dirname, "..", "..", "nodes")],
    functionGlobalContext: { sink, statuses }, credentialSecret: false,
    editorTheme: { tours: false }, diagnostics: { enabled: false }, telemetry: { enabled: false },
    externalModules: { autoInstall: false, palette: { allowInstall: false } },
    logging: { console: { level: process.env.NR_LOG_LEVEL || "error" } },
  };
  RED.init(server, settings);
  app.use(settings.httpAdminRoot, RED.httpAdmin);
  app.use(settings.httpNodeRoot, RED.httpNode);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await RED.start();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    RED, sink, statuses, base, port,
    async stop() {
      await RED.stop();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await require("../../lib/host-client").stopShared();
      fs.rmSync(userDir, { recursive: true, force: true });
    },
  };
}

// GET a URL; for a multipart stream, read for `ms` and then hang up
function get(url, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      res.on("end", done);
      if (ms) setTimeout(() => { req.destroy(); done(); }, ms);
    });
    req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(step); }
  return pred();
}

module.exports = { startNodeRed, get, sleep, until };
