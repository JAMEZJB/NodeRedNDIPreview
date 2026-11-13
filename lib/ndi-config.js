"use strict";
// A private copy of the user's NDI configuration with TCP receive switched on, for the NDI host process only.
//
// Why: by default the NDI Runtime receives video over reliable UDP. On Windows, the firewall drops that for a
// program it has no allow rule for, and Node-RED usually has none, so a receiver connects but gets no video. TCP
// receive avoids that. Everything else in the user's configuration (groups, discovery server, extra IPs) is kept.
//
// The copy is used only by the NDI host process (through its environment), never by Node-RED itself. If
// NDI_CONFIG_DIR is already set, the user (or a test) has chosen a configuration, and it is left alone.
const os = require("os");
const path = require("path");
const fs = require("fs");

function userConfigCandidates(env = process.env) {
  const c = [];
  if (process.platform === "win32") c.push(path.join(env.ProgramData || "C:\\ProgramData", "NDI", "ndi-config.v1.json"));
  c.push(path.join(os.homedir(), ".ndi", "ndi-config.v1.json"));
  return c;
}

function withTcpReceive(cfg) {
  const out = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? { ...cfg } : {};
  const ndi = out.ndi && typeof out.ndi === "object" ? { ...out.ndi } : {};
  ndi.tcp = { ...(ndi.tcp || {}), recv: { ...((ndi.tcp || {}).recv || {}), enable: true } };
  ndi.rudp = { ...(ndi.rudp || {}), recv: { ...((ndi.rudp || {}).recv || {}), enable: false } };
  ndi.multicast = { ...(ndi.multicast || {}), recv: { ...((ndi.multicast || {}).recv || {}), enable: false } };
  out.ndi = ndi;
  return out;
}

// -> { env: { NDI_CONFIG_DIR } | {}, applied, dir?, reason? }. Never throws.
function prepareNdiConfig(dir, env = process.env) {
  if (env.NDI_CONFIG_DIR) return { env: {}, applied: false, reason: "NDI_CONFIG_DIR is already set" };
  try {
    let cfg = {};
    for (const c of userConfigCandidates(env)) {
      try { cfg = JSON.parse(fs.readFileSync(c, "utf8").replace(/^\uFEFF/, "")); break; } catch (e) { /* try the next */ }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ndi-config.v1.json"), JSON.stringify(withTcpReceive(cfg), null, 2));
    return { env: { NDI_CONFIG_DIR: dir }, applied: true, dir };
  } catch (e) {
    return { env: {}, applied: false, reason: String((e && e.message) || e) };
  }
}

module.exports = { prepareNdiConfig, withTcpReceive };
