"use strict";
// TEST-ONLY stand-in for the native add-on (selected with NDI_PREVIEW_TEST_ADDON). Same API, no NDI, no network:
// it makes synthetic RGBX frames. Some source names act out failures so the tests can check the safety nets:
//   "synthetic-novideo"  connects but never delivers a frame
//   "synthetic-absent"   never connects
//   "synthetic-crash"    kills the host process (as a native crash would)
//   "synthetic-hang"     blocks the host process for good (as a native hang would)
//   "synthetic-dies"     sends video for 300 ms, then disconnects; like NDI's FrameSync it keeps repeating the
//                        last frame afterwards
// A runtime path containing "missing" behaves as if no NDI Runtime were installed.
const FOURCC_RGBX = 1480738642;

let loaded = false;
const open = new Set();
let opened = 0;

module.exports = {
  load(p) {
    if (typeof p === "string" && p.includes("missing")) {
      return { ok: false, error: "synthetic: the NDI Runtime is not installed", url: "http://ndi.link/NDIRedistV6" };
    }
    loaded = true;
    return { ok: true, version: "synthetic 6.0", path: "/synthetic/libndi", loader: "v6" };
  },
  open(opts) {
    if (!loaded) throw new Error("not loaded");
    const name = opts.name || opts.address;
    if (name === "synthetic-crash") process.kill(process.pid, "SIGKILL");
    if (name === "synthetic-hang") { for (;;) { /* a hang */ } }
    const h = { name, bandwidth: opts.bandwidth, t0: Date.now(), closed: false, frames: 0 };
    open.add(h); opened++;
    return h;
  },
  grab(h, since) {
    if (h.closed) return null;
    if (h.name === "synthetic-novideo" || h.name === "synthetic-absent") return null;
    if (Date.now() - h.t0 < 30) return null;                 // the first frame takes a moment, as with NDI
    const W = h.bandwidth === "highest" ? 1280 : 640, H = h.bandwidth === "highest" ? 720 : 360;
    let n = Math.floor((Date.now() - h.t0) / 40);             // a new frame every 40 ms (25 fps)
    if (h.name === "synthetic-dies") n = Math.min(n, 7);      // frozen after ~300 ms
    if (typeof since === "number" && since === (h.t0 + n * 40) * 10000) return false;
    const data = Buffer.alloc(W * H * 4);
    const shade = (n * 7) % 200;
    for (let i = 0; i < data.length; i += 4) { data[i] = 200; data[i + 1] = shade; data[i + 2] = 40; data[i + 3] = 255; }
    h.frames++;
    return { xres: W, yres: H, frameRateN: 25000, frameRateD: 1000, fourCC: FOURCC_RGBX, lineStrideBytes: W * 4,
      timestamp: (h.t0 + n * 40) * 10000, data };
  },
  stats(h) {
    const gone = h.closed || h.name === "synthetic-absent" || (h.name === "synthetic-dies" && Date.now() - h.t0 > 300);
    return { connections: gone ? 0 : 1, framesTotal: h.frames, framesDropped: 0 };
  },
  close(h) { h.closed = true; open.delete(h); },
  findOpen() { return { find: true }; },
  findSources() { return [{ name: "SYNTHETIC (Pattern)", address: "127.0.0.1:5961" }]; },
  findClose() {},
  // for in-process tests
  _openCount() { return open.size; },
  _openedTotal() { return opened; },
};
