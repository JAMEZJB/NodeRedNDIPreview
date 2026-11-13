"use strict";
// TEST-ONLY network guard, preloaded into every test process (NODE_OPTIONS="-r test/netguard.js"; child processes
// inherit it). Every outgoing connection, datagram, multicast join, DNS lookup and listening socket must stay on
// loopback; anything else is refused and recorded in $NETGUARD_REPORT. Tests must never reach a real network.
//
// The NDI Runtime's own sockets are native code, out of this guard's reach: the end-to-end test runs every NDI
// process inside a macOS sandbox that only allows loopback (test/e2e/loopback.sb).
const net = require("net");
const dgram = require("dgram");
const dns = require("dns");
const fs = require("fs");

const LOOPBACK_NAMES = new Set(["localhost", "localhost.", "ip6-localhost"]);
function isLoopback(host) {
  if (host == null || host === "") return false;
  const h = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;
  if (net.isIPv4(h)) return h.startsWith("127.");
  if (net.isIPv6(h)) return h === "::1" || /^::ffff:127\./.test(h);
  return false;
}

function violation(what, target) {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, what, target: String(target) });
  if (process.env.NETGUARD_REPORT) { try { fs.appendFileSync(process.env.NETGUARD_REPORT, line + "\n"); } catch (e) { /* ignore */ } }
  const err = new Error(`netguard: refused ${what} to ${target} (tests stay on loopback)`);
  err.code = "ENETGUARD";
  return err;
}

// TCP and HTTP(S) clients
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  if (opts && typeof opts === "object") {
    if (opts.path) return origConnect.apply(this, args);              // unix socket / named pipe
    const host = opts.host ?? "localhost";
    if (!isLoopback(host)) throw violation("tcp connect", `${host}:${opts.port}`);
  } else if (typeof opts === "number" || /^\d+$/.test(String(opts))) {
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    if (!isLoopback(host)) throw violation("tcp connect", `${host}:${opts}`);
  } else if (typeof opts === "string") {
    return origConnect.apply(this, args);                               // a path
  }
  return origConnect.apply(this, args);
};

// listening sockets: loopback only (an all-interfaces server could be reached from a real network)
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const a = args[0];
  if (a && typeof a === "object" && !Array.isArray(a)) {
    if (!a.path && !a.handle && !a.fd && !isLoopback(a.host)) throw violation("listen", `${a.host || "all interfaces"}:${a.port}`);
  } else if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    const host = typeof args[1] === "string" ? args[1] : null;
    if (!isLoopback(host)) throw violation("listen", `${host || "all interfaces"}:${a}`);
  }
  return origListen.apply(this, args);
};

// UDP
const origSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const host = args.find((x, i) => i > 0 && typeof x === "string");
  if (!isLoopback(host || "localhost")) throw violation("udp send", host);
  return origSend.apply(this, args);
};
const origBind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const a = args[0];
  const host = a && typeof a === "object" ? a.address : typeof args[1] === "string" ? args[1] : null;
  if (!isLoopback(host)) throw violation("udp bind", host || "all interfaces");
  return origBind.apply(this, args);
};
for (const m of ["addMembership", "addSourceSpecificMembership", "setBroadcast"]) {
  const orig = dgram.Socket.prototype[m];
  if (orig) dgram.Socket.prototype[m] = function (...args) { throw violation("udp " + m, args[0]); };
}

// DNS: only names that are loopback
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!isLoopback(host) && !net.isIP(String(host))) throw violation("dns lookup", host);
  if (net.isIP(String(host)) && !isLoopback(host)) throw violation("dns lookup", host);
  return origLookup.call(this, host, ...rest);
};
for (const m of ["resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
  dns[m] = function (host) { throw violation("dns " + m, host); };
  if (dns.promises) dns.promises[m] = async function (host) { throw violation("dns " + m, host); };
}
if (dns.promises) {
  const origP = dns.promises.lookup;
  dns.promises.lookup = async function (host, ...rest) {
    if (!isLoopback(host)) throw violation("dns lookup", host);
    return origP.call(this, host, ...rest);
  };
}

// fetch (undici) is not routed through net.Socket.connect in every Node version: guard it directly
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (!isLoopback(u.hostname)) return Promise.reject(violation("fetch", u.href));
    return origFetch.call(this, input, init);
  };
}

module.exports = { isLoopback };
