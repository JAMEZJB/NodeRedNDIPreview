"use strict";
// Where the prebuilt add-on for this computer lives, and loading it. The add-on is only ever loaded inside the NDI
// host process (lib/host.js), never inside Node-RED itself.
const path = require("path");
const fs = require("fs");

const PREBUILDS = path.join(__dirname, "..", "prebuilds");

function platformDir(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return "darwin-universal";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return null;
}

// -> absolute path of the add-on for this computer, or null when there is none
function addonPath() {
  const dir = platformDir();
  if (!dir) return null;
  const p = path.join(PREBUILDS, dir, "ndi_preview.node");
  return fs.existsSync(p) ? p : null;
}

// -> null when this computer can run the nodes, else a sentence saying why not
function unsupportedReason() {
  if (process.env.NDI_PREVIEW_TEST_ADDON) return null;
  if (!platformDir()) {
    return `NDI preview is not available on ${process.platform}-${process.arch}: it runs on macOS and on Windows x64`;
  }
  if (!addonPath()) return `the NDI preview add-on for ${platformDir()} is missing from this installation`;
  return null;
}

// NDI_PREVIEW_TEST_ADDON is for this package's own tests: a JavaScript stand-in with the add-on's API that makes
// synthetic frames and uses no network.
function loadAddon() {
  const fake = process.env.NDI_PREVIEW_TEST_ADDON;
  if (fake) return require(path.resolve(fake));
  const p = addonPath();
  if (!p) throw new Error(unsupportedReason() || "the NDI preview add-on is missing");
  return require(p);
}

module.exports = { addonPath, platformDir, unsupportedReason, loadAddon };
