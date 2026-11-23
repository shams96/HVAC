// Builds public/og.png (1200x630 share image) from the brand logo. Flat colors only: ivory panel, logo, teal base bar.
import sharp from "sharp";
import { readFileSync } from "node:fs";

const IVORY = "#f6eedd";
const TEAL = "#186767";
const W = 1200, H = 630;
const logo = readFileSync("public/brand/logo.svg");
const logoW = 760; // logo viewBox is 205x64
const logoPng = await sharp(logo, { density: 300 }).resize({ width: logoW }).png().toBuffer();
const meta = await sharp(logoPng).metadata();

await sharp({ create: { width: W, height: H, channels: 3, background: IVORY } })
  .composite([
    { input: logoPng, left: Math.round((W - logoW) / 2), top: Math.round((H - 40 - (meta.height ?? 237)) / 2) },
    { input: { create: { width: W, height: 40, channels: 3, background: TEAL } }, left: 0, top: H - 40 },
  ])
  .png({ compressionLevel: 9 })
  .toFile("public/og.png");
console.log("wrote public/og.png");
