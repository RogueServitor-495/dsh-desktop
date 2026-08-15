// DSH Manager app icon generator — zero dependencies (node zlib).
// Design: dark gradient squircle, terminal card with prompt chevron and
// blinking cursor, green "running" status dot.
import zlib from "node:zlib";
import fs from "node:fs";

const S = 1024;
const px = Buffer.alloc(S * S * 4);

const table = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const da = px[i + 3] / 255;
  const sa = a / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => Math.round(a + (b - a) * clamp01(t));
const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
};
const distToSeg = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((x - ax) * dx + (y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px2 = ax + t * dx - x, py2 = ay + t * dy - y;
  return Math.sqrt(px2 * px2 + py2 * py2);
};
const distToPoint = (x, y, cx, cy) => Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));

// ── 1. background squircle: vertical gradient ────────────────────────────────
const X0 = 64, X1 = 960, Y0 = 64, Y1 = 960, R = 205;
const TOP = [38, 50, 72];    // #263248
const BOT = [12, 16, 24];    // #0c1018
for (let y = 0; y < S; y++) {
  const t = (y - Y0) / (Y1 - Y0);
  const rr = lerp(TOP[0], BOT[0], t);
  const gg = lerp(TOP[1], BOT[1], t);
  const bb = lerp(TOP[2], BOT[2], t);
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x + 0.5, y + 0.5, X0, Y0, X1, Y1, R)) {
      // soft radial brightening toward the top-center
      const d = distToPoint(x, y, S / 2, Y0 + (Y1 - Y0) * 0.28);
      const glow = Math.max(0, 1 - d / (S * 0.75)) * 14;
      setPx(x, y, Math.min(255, rr + glow), Math.min(255, gg + glow), Math.min(255, bb + glow), 255);
    }
  }
}
// subtle inner border
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const inInner = inRoundedRect(x + 0.5, y + 0.5, X0 + 7, Y0 + 7, X1 - 7, Y1 - 7, R - 7);
    const inOuter = inRoundedRect(x + 0.5, y + 0.5, X0, Y0, X1, Y1, R);
    if (inOuter && !inInner) blend(x, y, 255, 255, 255, 26);
  }
}

// ── 2. terminal card ─────────────────────────────────────────────────────────
const CX0 = 268, CY0 = 296, CX1 = 756, CY1 = 728, CR = 66;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x + 0.5, y + 0.5, CX0, CY0, CX1, CY1, CR)) {
      blend(x, y, 15, 20, 30, 238);
    }
  }
}
// card border
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const inInner = inRoundedRect(x + 0.5, y + 0.5, CX0 + 5, CY0 + 5, CX1 - 5, CY1 - 5, CR - 5);
    const inOuter = inRoundedRect(x + 0.5, y + 0.5, CX0, CY0, CX1, CY1, CR);
    if (inOuter && !inInner) blend(x, y, 82, 106, 146, 170);
  }
}
// title bar strip (subtle)
for (let y = CY0; y < CY0 + 84; y++) {
  for (let x = CX0; x < CX1; x++) {
    if (inRoundedRect(x + 0.5, y + 0.5, CX0, CY0, CX1, CY1, CR)) {
      blend(x, y, 255, 255, 255, 7);
    }
  }
}

// ── 3. green "running" status dot (top-right of the card) ────────────────────
const DOT_X = CX1 - 52, DOT_Y = CY0 + 42, DOT_R = 26;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = distToPoint(x + 0.5, y + 0.5, DOT_X, DOT_Y);
    if (d <= DOT_R * 2.2) {
      const halo = clamp01(1 - d / (DOT_R * 2.2)) * 90;
      blend(x, y, 52, 201, 143, Math.round(halo * 0.35));
    }
    if (d <= DOT_R) {
      const core = clamp01(1 - d / DOT_R);
      blend(x, y, 52, 201, 143, Math.round(140 + core * 115));
    }
  }
}

// ── 4. prompt chevron + cursor ───────────────────────────────────────────────
const BLUE = [90, 166, 255];
const chevron = [
  [352, 452, 468, 512],
  [352, 572, 468, 512],
];
const TH = 42;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let hit = false;
    for (const [ax, ay, bx, by] of chevron) {
      if (distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by) <= TH) { hit = true; break; }
    }
    if (hit) blend(x, y, BLUE[0], BLUE[1], BLUE[2], 255);
  }
}
// cursor bar (blinking-block style, rounded)
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (x >= 526 && x <= 566 && y >= 440 && y <= 584) {
      const inBar = inRoundedRect(x + 0.5, y + 0.5, 526, 440, 566, 584, 16);
      if (inBar) blend(x, y, BLUE[0], BLUE[1], BLUE[2], 235);
    }
  }
}

// ── encode PNG ───────────────────────────────────────────────────────────────
function encodePng(buf, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    buf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
fs.writeFileSync(process.argv[2], encodePng(px, S));
console.log("wrote", process.argv[2], px.length * 4, "bytes");

// ASCII preview (64x32) to sanity-check the layout
const W = 64, H = 32;
let art = "";
for (let row = 0; row < H; row++) {
  let line = "";
  for (let col = 0; col < W; col++) {
    const x = Math.floor(((col + 0.5) / W) * S);
    const y = Math.floor(((row + 0.5) / H) * S);
    const i = (y * S + x) * 4;
    const a = px[i + 3] / 255;
    const lum = (px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1) * a;
    if (a < 0.08) line += " ";
    else if (lum < 34) line += ".";
    else if (lum < 70) line += ":";
    else if (lum < 110) line += "o";
    else if (lum < 160) line += "O";
    else line += "@";
  }
  art += line + "\n";
}
console.log(art);

// ── tray icon: 32x32 monochrome template (black chevron on alpha) ─────────────
const TS = 32;
const trayPx = Buffer.alloc(TS * TS * 4);
const tBars = [
  [tS(10), tS(12), tS(20), tS(16)],
  [tS(10), tS(20), tS(20), tS(16)],
];
function tS(v) { return v; }
const tHalf = 2.6;
for (let y = 0; y < TS; y++) {
  for (let x = 0; x < TS; x++) {
    let hit = false;
    for (const [ax, ay, bx, by] of tBars) {
      if (distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by) <= tHalf) { hit = true; break; }
    }
    const i = (y * TS + x) * 4;
    if (hit) { trayPx[i] = 0; trayPx[i + 1] = 0; trayPx[i + 2] = 0; trayPx[i + 3] = 255; }
  }
}
if (process.argv[3]) {
  fs.writeFileSync(process.argv[3], trayPx);
  console.log("wrote", process.argv[3], trayPx.length, "bytes");
}
if (process.argv[4]) {
  fs.writeFileSync(process.argv[4], encodePng(trayPx, TS));
  console.log("wrote", process.argv[4], "png");
}
