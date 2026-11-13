"use strict";
// The network guard itself: it must refuse before any packet leaves. 192.0.2.1 is TEST-NET-1, a documentation
// address that is never routed; the guard throws before a socket is even created for it.
const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const dgram = require("dgram");
const dns = require("dns");
const http = require("http");

// the refusals below are deliberate: keep them out of the gate's violation report
delete process.env.NETGUARD_REPORT;

if (!net.Socket.prototype.connect.toString().includes("violation")) {
  // The gate preloads the guard; when a file is run on its own, load it here.
  require("../netguard");
}
const { isLoopback } = require("../netguard");

test("loopback addresses are recognised", () => {
  for (const h of ["127.0.0.1", "127.5.6.7", "::1", "[::1]", "localhost"]) assert.ok(isLoopback(h), h);
  for (const h of ["192.0.2.1", "10.0.0.1", "0.0.0.0", "::", "example.com", "", null]) assert.ok(!isLoopback(h), String(h));
});

test("non-loopback TCP, UDP, multicast, DNS, listening and fetch are refused", async () => {
  assert.throws(() => net.connect({ host: "192.0.2.1", port: 9 }), /netguard/);
  assert.throws(() => http.get("http://192.0.2.1:9/"), /netguard/);
  const u = dgram.createSocket("udp4");
  try {
    assert.throws(() => u.send(Buffer.from("x"), 9, "192.0.2.1"), /netguard/);
    assert.throws(() => u.addMembership("239.255.0.1"), /netguard/);
    assert.throws(() => u.bind(0), /netguard/);
  } finally { u.close(); }
  assert.throws(() => dns.lookup("example.com", () => {}), /netguard/);
  assert.throws(() => net.createServer().listen(0), /netguard/);
  assert.throws(() => net.createServer().listen(0, "0.0.0.0"), /netguard/);
  await assert.rejects(fetch("http://192.0.2.1:9/"), /netguard/);
});

test("loopback still works", async () => {
  const s = net.createServer((c) => c.end("ok"));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const got = await new Promise((resolve, reject) => {
    const c = net.connect({ host: "127.0.0.1", port: s.address().port });
    let d = ""; c.on("data", (x) => (d += x)); c.on("end", () => resolve(d)); c.on("error", reject);
  });
  s.close();
  assert.strictEqual(got, "ok");
});
