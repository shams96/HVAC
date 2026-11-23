// Rasterise public/favicon.svg into PNG sizes and a PNG-in-ICO file. Run: node scripts/build-favicons.mjs
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
const svg = readFileSync("public/favicon.svg");
const png = (n) => sharp(svg, { density: 384 }).resize(n, n).png().toBuffer();
writeFileSync("public/apple-touch-icon.png", await png(180));
writeFileSync("public/icon-192.png", await png(192));
writeFileSync("public/icon-512.png", await png(512));
const sizes = [16, 32, 48];
const imgs = await Promise.all(sizes.map(png));
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => { const e = Buffer.alloc(16); e[0] = s; e[1] = s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12); offset += imgs[i].length; return e; });
writeFileSync("public/favicon.ico", Buffer.concat([head, ...dir, ...imgs]));
// Preview sheet for review only (not shipped): lockups on ivory and ink, plus favicon at 16/32/64.
const logo = readFileSync("public/brand/logo.svg"), dark = readFileSync("public/brand/logo-on-dark.svg");
const l = await sharp(logo, { density: 288 }).resize({ height: 160 }).png().toBuffer();
const d = await sharp(dark, { density: 288 }).resize({ height: 160 }).png().toBuffer();
const f = await Promise.all([16, 32, 64].map(png));
const sheet = sharp({ create: { width: 1100, height: 520, channels: 3, background: "#f6eedd" } });
writeFileSync(process.env.PREVIEW, await sheet.composite([
  { input: l, left: 40, top: 40 },
  { input: await sharp({ create: { width: 1100, height: 240, channels: 3, background: "#0b2a2a" } }).png().toBuffer(), left: 0, top: 280 },
  { input: d, left: 40, top: 320 },
  { input: f[0], left: 700, top: 60 }, { input: f[1], left: 760, top: 60 }, { input: f[2], left: 820, top: 60 },
]).png().toBuffer());
