// Unit test, no NDI runtime needed: every pixel format the converter accepts lands on the right colour.
const assert = require("assert");
const { frameToJpeg, toThumbRGBA, FOURCC } = require("../../lib/frame");
function solid(fourCC, W, H, px) {                       // px = bytes for one pixel (or one UYVY pair)
  const stride = W * 4, data = Buffer.alloc(stride * H);
  for (let i = 0; i < data.length; i += 4) px.copy(data, i);
  return { xres: W, yres: H, lineStrideBytes: stride, data, fourCC };
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const red = [200, 30, 40];
const cases = {
  RGBX: solid(FOURCC.RGBX, 1920, 1080, Buffer.from([200, 30, 40, 255])),
  BGRA: solid(FOURCC.BGRA, 640, 360, Buffer.from([40, 30, 200, 255])),
  // BT.709 limited range for (200,30,40): Y≈73, Cb≈115, Cr≈202 (computed)
  UYVY: { ...solid(FOURCC.UYVY, 1280, 720, Buffer.from([115, 73, 202, 73])), lineStrideBytes: 1280 * 2 },
};
for (const [k, f] of Object.entries(cases)) {
  const t = toThumbRGBA(f, 320);
  assert.strictEqual(t.width, 320); assert.strictEqual(t.height, 180);
  const px = [...t.data.subarray(0, 3)];
  assert.ok(near(px, red, k === "UYVY" ? 8 : 1), `${k} -> ${px}`);
  const j = frameToJpeg(f, 320, 70);
  // a well-formed baseline JPEG: SOI ... EOI, 320x180 in the SOF0 frame header
  assert.ok(j.jpeg[0] === 0xff && j.jpeg[1] === 0xd8 && j.jpeg.at(-2) === 0xff && j.jpeg.at(-1) === 0xd9, `${k} SOI/EOI`);
  const sof = j.jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0 && j.jpeg.readUInt16BE(sof + 5) === 180 && j.jpeg.readUInt16BE(sof + 7) === 320, `${k} SOF0 size`);
  console.log("ok", k, px.join(","), j.jpeg.length + " bytes");
}
assert.throws(() => toThumbRGBA({ ...cases.RGBX, fourCC: 842094169 }, 320), /unsupported/);
console.log("ok unsupported format rejected");
