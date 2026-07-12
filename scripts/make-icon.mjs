// Generates build/icon.png from the same face asset used by the renderer.

import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const SIZE = 512;
const face = readFileSync("src/assets/moss-face.svg", "utf8");

mkdirSync("build", { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(`
    <!doctype html>
    <style>
      html, body {
        width: ${SIZE}px;
        height: ${SIZE}px;
        margin: 0;
        background: transparent;
      }
      .tile {
        box-sizing: border-box;
        display: flex;
        width: ${SIZE}px;
        height: ${SIZE}px;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border: 2px solid rgba(110, 231, 183, 0.28);
        border-radius: 108px;
        background:
          radial-gradient(circle at 50% 34%, rgba(52, 211, 153, 0.32), transparent 48%),
          linear-gradient(145deg, #10231d 0%, #08110f 58%, #050807 100%);
        box-shadow: inset 0 0 70px rgba(16, 185, 129, 0.12);
      }
      .face {
        width: 440px;
        height: 440px;
        transform: translateY(22px);
      }
      .face > svg {
        display: block;
        width: 100%;
        height: 100%;
      }
    </style>
    <div class="tile"><div class="face">${face}</div></div>
  `);
  await page.screenshot({ path: "build/icon.png", omitBackground: true });
} finally {
  await browser.close();
}

console.log(`Wrote build/icon.png (${SIZE}x${SIZE}) from src/assets/moss-face.svg`);
