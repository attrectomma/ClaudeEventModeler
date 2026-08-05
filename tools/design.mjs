#!/usr/bin/env node
// Close the loop on a design the way tools/drawio.mjs closes it on a model.
//
//   node tools/design.mjs shot  <file.html> [--widths 1440,390] [--height 1200]
//   node tools/design.mjs sheet <designs-dir> [--widths 1440,390] [--height 1200]
//
// "Never hand over diagram XML you have not rendered" applies just as hard to a design: a human
// cannot read CSS and picture the result, and neither can Claude. `shot` renders one page to PNG
// with headless Chrome. `sheet` renders every screen in a folder at every width, writes a contact
// sheet PNG showing all of them at once, and writes an index.html for the human to open in a real
// browser — because a screenshot cannot be hovered, tabbed through, or resized.
//
// Zero install: Chrome or Edge is already on this machine. No Playwright, no Puppeteer.
//
// Full-page capture is not a Chrome CLI flag, so --height sets the viewport. A page taller than
// that is cut off; a page shorter leaves whitespace. Pass a height that fits the tallest screen.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, basename, dirname, relative } from "node:path";

const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const BROWSER = BROWSERS.find((p) => existsSync(p));

const args = process.argv.slice(2);
const [cmd, target] = args;
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const WIDTHS = flag("widths", "1440,390").split(",").map((n) => +n.trim()).filter(Boolean);
const HEIGHT = +flag("height", "1200");

if (!cmd || !target || !["shot", "sheet"].includes(cmd)) {
  console.error("usage: node tools/design.mjs <shot|sheet> <file.html | designs-dir> [--widths 1440,390] [--height 1200]");
  process.exit(2);
}
if (!BROWSER) {
  console.error(`no Chrome or Edge found. Looked in:\n  ${BROWSERS.join("\n  ")}`);
  process.exit(1);
}
const path = resolve(target);
if (!existsSync(path)) {
  console.error(`not found: ${path}`);
  process.exit(1);
}

// A name a width can be talked about by, so a finding can say WHICH viewport broke.
const label = (w) => (w < 500 ? "mobile" : w < 900 ? "tablet" : "desktop");

function shoot(htmlPath, outPath, width) {
  mkdirSync(dirname(outPath), { recursive: true });
  const r = spawnSync(BROWSER, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
    "--force-device-scale-factor=1", "--default-background-color=ffffffff",
    `--screenshot=${outPath}`, `--window-size=${width},${HEIGHT}`,
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ], { encoding: "utf8" });
  if (!existsSync(outPath)) {
    console.error(`screenshot failed for ${basename(htmlPath)} @ ${width}px`);
    if (r.stderr) console.error(r.stderr.split("\n").slice(0, 5).join("\n"));
    return null;
  }
  return outPath;
}

if (cmd === "shot") {
  const dir = join(dirname(path), "_shots");
  const stem = basename(path, ".html");
  for (const w of WIDTHS) {
    const out = join(dir, `${stem}-${label(w)}.png`);
    if (shoot(path, out, w)) console.log(out);
  }
  process.exit(0);
}

// --- sheet ---------------------------------------------------------------------------------------

const pages = readdirSync(path)
  .filter((f) => f.endsWith(".html") && f !== "index.html" && !f.startsWith("_"))
  .sort();
if (!pages.length) {
  console.error(`${target}: no screen pages (*.html) to render.`);
  process.exit(1);
}

const shotDir = join(path, "_shots");
const shots = [];
for (const p of pages) {
  const stem = basename(p, ".html");
  for (const w of WIDTHS) {
    const out = join(shotDir, `${stem}-${label(w)}.png`);
    if (shoot(join(path, p), out, w)) shots.push({ stem, w, file: basename(out) });
  }
}

// One image per viewport holding every screen at that viewport. Not one image holding everything:
// a 1440px shot scaled into a shared column is illegible, which defeats the entire point of
// looking. Columns are the shot's NATIVE width, and the sheet is shot at whatever size fits all
// of its rows — a fixed --height would silently crop the last row off.
const GAP = 24, CAP = 20, HEAD = 74;
const sheets = [];
for (const w of WIDTHS) {
  const mine = shots.filter((s) => s.w === w);
  if (!mine.length) continue;
  const cols = Math.max(1, Math.floor(2560 / w));
  const rows = Math.ceil(mine.length / cols);
  const sheetW = cols * w + (cols + 1) * GAP;
  const sheetH = HEAD + rows * (HEIGHT + CAP + GAP) + GAP;
  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: ${GAP}px; background: #fff; font: 13px/1.4 "Segoe UI", system-ui, sans-serif; color: #111; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p.sub { margin: 0 0 ${GAP}px; color: #777; font-size: 12px; }
  .grid { display: flex; flex-wrap: wrap; gap: ${GAP}px; align-items: flex-start; }
  figure { margin: 0; width: ${w}px; }
  figcaption { font-size: 12px; color: #333; height: ${CAP}px; font-weight: 600; }
  figcaption span { font-weight: 400; color: #999; }
  img { width: ${w}px; display: block; border: 1px solid #ddd; }
</style>
<h1>${basename(path)} — ${label(w)} (${w}px)</h1>
<p class="sub">${mine.length} screen(s) at 1:1. Generated by tools/design.mjs; do not edit.</p>
<div class="grid">
${mine.map((s) => `  <figure><figcaption>${s.stem} <span>· ${w}px</span></figcaption><img src="${s.file}"></figure>`).join("\n")}
</div>
`;
  const sp = join(shotDir, `_sheet-${label(w)}.html`);
  writeFileSync(sp, html, "utf8");
  const out = join(shotDir, `contact-sheet-${label(w)}.png`);
  // The sheet gets its own viewport, independent of --height, so nothing is cropped.
  const saved = HEIGHT;
  const r = spawnSync(BROWSER, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
    "--force-device-scale-factor=1", "--default-background-color=ffffffff",
    `--screenshot=${out}`, `--window-size=${sheetW},${sheetH}`,
    `file:///${sp.replace(/\\/g, "/")}`,
  ], { encoding: "utf8" });
  if (existsSync(out)) sheets.push({ label: label(w), out, sheetW, sheetH });
  else console.error(`contact sheet failed for ${label(w)}: ${(r.stderr ?? "").split("\n")[0]}`);
}

// The human's entry point. A screenshot cannot be hovered, tabbed through or resized, so the real
// pages stay reachable — live in an iframe, and one click away at full size.
const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>${basename(path)} — screens</title>
<style>
  body { margin: 0; padding: 32px; background: #f6f7f8; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 28px; color: #666; font-size: 13px; }
  section { margin-bottom: 36px; }
  h2 { font-size: 14px; margin: 0 0 8px; }
  h2 a { color: #06c; text-decoration: none; font-weight: 400; font-size: 12px; margin-left: 10px; }
  .frames { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .frame { background: #fff; border: 1px solid #dcdfe3; border-radius: 6px; overflow: hidden; }
  .frame span { display: block; font-size: 11px; color: #888; padding: 5px 9px; border-bottom: 1px solid #eee; }
  iframe { display: block; border: 0; }
</style>
<h1>${basename(path)} — screens</h1>
<p class="sub">Generated by <code>tools/design.mjs sheet</code>. Open any screen on its own to resize it, tab through it, or check hover states.</p>
${pages.map((p) => {
  const stem = basename(p, ".html");
  return `<section>
  <h2>${stem}<a href="${p}" target="_blank">open full size &rarr;</a></h2>
  <div class="frames">
${WIDTHS.map((w) => `    <div class="frame"><span>${label(w)} · ${w}px</span><iframe src="${p}" width="${w}" height="${Math.min(HEIGHT, 900)}"></iframe></div>`).join("\n")}
  </div>
</section>`;
}).join("\n")}
`;
writeFileSync(join(path, "index.html"), indexHtml, "utf8");

console.log(`${shots.length} shot(s) of ${pages.length} screen(s) in ${relative(process.cwd(), shotDir)}`);
for (const s of sheets) console.log(`  look at this: ${relative(process.cwd(), s.out)}  (${s.sheetW}x${s.sheetH})`);
console.log(`give the human this: ${relative(process.cwd(), join(path, "index.html"))}`);
