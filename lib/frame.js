"use strict";
// Pure-JS frame helpers: any NDI video frame -> RGBA at thumbnail size -> JPEG Buffer.
// No native code here, so this file is unit-testable without the NDI runtime.
const encodeJpeg = require("./vendor/jpeg-encoder");   // vendored jpeg-js 0.4.4 encoder (lib/vendor/PROVENANCE.md)

const FOURCC = { UYVY: 1498831189, BGRA: 1095911234, BGRX: 1481787202, RGBA: 1094862674, RGBX: 1480738642 };
const fourccName = (v) => Object.keys(FOURCC).find((k) => FOURCC[k] === v) || String(v);

// Box-filter (area average) downscale of a packed 4-byte-per-pixel frame straight into RGBA.
// Handles RGBX/RGBA and BGRX/BGRA (channel swap) and UYVY (4:2:2 -> RGB, BT.709 limited range).
function toThumbRGBA(frame, outW) {
  const { xres: W, yres: H, lineStrideBytes: stride, data, fourCC } = frame;
  const w = Math.max(16, Math.min(outW | 0 || 320, W));
  const h = Math.max(9, Math.round((H * w) / W));
  const out = Buffer.alloc(w * h * 4);
  const bgr = fourCC === FOURCC.BGRX || fourCC === FOURCC.BGRA;
  const uyvy = fourCC === FOURCC.UYVY;
  if (!uyvy && !bgr && fourCC !== FOURCC.RGBX && fourCC !== FOURCC.RGBA) {
    throw new Error(`unsupported pixel format ${fourccName(fourCC)} (ask for colorFormat RGBX_RGBA)`);
  }
  const fx = W / w, fy = H / h;
  // sample a capped grid inside each output cell (≤4×4) — cheap and still smooth for 1080p -> 320
  const sx = Math.max(1, Math.min(4, Math.floor(fx))), sy = Math.max(1, Math.min(4, Math.floor(fy)));
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let j = 0; j < sy; j++) {
        const y = Math.min(H - 1, Math.floor(oy * fy + ((j + 0.5) * fy) / sy));
        const row = y * stride;
        for (let i = 0; i < sx; i++) {
          const x = Math.min(W - 1, Math.floor(ox * fx + ((i + 0.5) * fx) / sx));
          if (uyvy) {
            const p = row + (x >> 1) * 4;                       // U Y0 V Y1
            const Y = (x & 1 ? data[p + 3] : data[p + 1]) - 16, U = data[p] - 128, V = data[p + 2] - 128;
            r += 1.164 * Y + 1.793 * V; g += 1.164 * Y - 0.213 * U - 0.533 * V; b += 1.164 * Y + 2.112 * U;
          } else {
            const p = row + x * 4;
            if (bgr) { b += data[p]; g += data[p + 1]; r += data[p + 2]; }
            else { r += data[p]; g += data[p + 1]; b += data[p + 2]; }
          }
          n++;
        }
      }
      const o = (oy * w + ox) * 4;
      out[o] = clamp(r / n); out[o + 1] = clamp(g / n); out[o + 2] = clamp(b / n); out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function frameToJpeg(frame, outW, quality) {
  const rgba = toThumbRGBA(frame, outW);
  const q = Math.max(10, Math.min(95, quality | 0 || 70));
  return { jpeg: encodeJpeg(rgba, q).data, width: rgba.width, height: rgba.height };
}

module.exports = { toThumbRGBA, frameToJpeg, fourccName, FOURCC };
