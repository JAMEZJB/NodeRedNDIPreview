"use strict";
// TEST-ONLY guard for the unit tests, preloaded next to test/netguard.js by `scripts/check.sh` (NODE_OPTIONS, so
// every child process the tests start carries it too). A unit test must never load the real NDI library: the real
// add-on would load the NDI Runtime, and the Runtime's own discovery sockets are native code that the JavaScript
// network guard cannot see. So, whatever a single test remembers to set up:
//   - loading this package's native add-on, or any native file with "ndi" in its name, is refused;
//   - starting the NDI host (lib/host.js) without NDI_PREVIEW_TEST_ADDON (the synthetic add-on) is refused;
//   - starting any program other than this Node.js binary is refused (no shell, no network tools, no openers).
// A refusal throws before anything is loaded or started and is recorded in $NETGUARD_REPORT, which fails the gate.
// The end-to-end test, which runs the real add-on inside a loopback-only sandbox, does not load this file.
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOST_SCRIPT = path.join(ROOT, "lib", "host.js");
const NODE_BIN = fs.realpathSync(process.execPath);

function refusal(what) {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, what: "unit guard", target: what });
  if (process.env.NETGUARD_REPORT) { try { fs.appendFileSync(process.env.NETGUARD_REPORT, line + "\n"); } catch (e) { /* ignore */ } }
  const err = new Error(`unit guard: refused ${what} (unit tests use the synthetic add-on: set NDI_PREVIEW_TEST_ADDON)`);
  err.code = "EUNITGUARD";
  return err;
}

function real(p) {
  try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
}

// -> a reason to refuse loading this native file, or null
function nativeRefusal(file) {
  const p = real(String(file));
  const inPackage = p.startsWith(ROOT + path.sep) && !p.slice(ROOT.length).split(path.sep).includes("node_modules");
  if (inPackage || /ndi/i.test(path.basename(p))) return `loading the native file ${p}`;
  return null;
}

const origDlopen = process.dlopen;
process.dlopen = function (module, filename, ...rest) {
  const why = nativeRefusal(filename);
  if (why) throw refusal(why);
  return origDlopen.call(this, module, filename, ...rest);
};

function isNode(cmd) {
  if (typeof cmd !== "string" || !cmd) return false;
  return real(cmd) === NODE_BIN;
}

function argsAndOptions(args, options) {
  if (!Array.isArray(args)) return [[], args && typeof args === "object" ? args : {}];
  return [args, options || {}];
}

// -> a reason to refuse starting this program, or null
function spawnRefusal(file, args, options) {
  if (options && options.shell) return `a shell command (${[file, ...args].join(" ").slice(0, 200)})`;
  if (!isNode(file)) return `starting ${file} (only this Node.js binary may be started)`;
  const env = (options && options.env) || process.env;
  if (args.some((a) => typeof a === "string" && real(a) === HOST_SCRIPT) && !env.NDI_PREVIEW_TEST_ADDON) {
    return "starting the NDI host without NDI_PREVIEW_TEST_ADDON (it would load the real NDI library)";
  }
  return null;
}

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const orig = childProcess[name];
  childProcess[name] = function (file, a, b, ...rest) {
    const [args, options] = argsAndOptions(a, b);
    const why = spawnRefusal(file, args, options);
    if (why) throw refusal(why);
    return orig.call(this, file, a, b, ...rest);
  };
}
for (const name of ["exec", "execSync"]) {
  childProcess[name] = function (command) { throw refusal(`a shell command (${String(command).slice(0, 200)})`); };
}
const origFork = childProcess.fork;
childProcess.fork = function (modulePath, a, b, ...rest) {
  const [args, options] = argsAndOptions(a, b);
  const why = spawnRefusal((options && options.execPath) || process.execPath, [String(modulePath), ...args], options);
  if (why) throw refusal(why);
  return origFork.call(this, modulePath, a, b, ...rest);
};

module.exports = { nativeRefusal, spawnRefusal };
