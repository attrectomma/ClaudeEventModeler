// Headless-Chrome screenshots, and the one bug that made half of them lies.
//
// Shared by tools/design.mjs (static design pages) and tools/review.mjs (the running app), because a
// design shot and an implementation shot are only comparable if they were taken the same way.
//
// THE BUG, MEASURED RATHER THAN SUSPECTED. `chrome --headless=new --window-size=390,200` reports
// `window.innerWidth = 500`. Windows will not make a real window narrower than about 500px, so Chrome
// lays the page out at 500 and then crops the screenshot to the 390 that was asked for. Every mobile
// shot this kit produced before this module was therefore a CROP OF A 500px LAYOUT: it invented
// right-edge clipping that did not exist, and would equally have hidden clipping that did. It cost one
// wrong diagnosis and two rounds of CSS "fixes" to a page that had been correct all along.
//
// `--headless=old` is NOT a way out; modern Chrome ignores it and silently gives you =new. Both
// invocations produced byte-identical output.
//
// THE FIX: render the page inside an <iframe> of the requested width, in a window wide enough to be
// legal, and screenshot the iframe's area. An iframe gets a real layout viewport at its own width, so
// the page inside genuinely believes it is 390px wide. tools/design.mjs's index.html had been using
// iframes at native width all along — the technique was in the repo, just not in the capture path.

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
export const BROWSER = BROWSERS.find((p) => existsSync(p));
export const browserHelp = () =>
  `no Chrome or Edge found. Looked in:\n  ${BROWSERS.join("\n  ")}`;

// Below this, a real Chrome window cannot be made and the crop lies. Measured at 500 on this machine;
// 520 leaves a little room rather than sitting exactly on the boundary.
const MIN_HONEST_WIDTH = 520;

export const label = (w) => (w <= 600 ? "mobile" : w <= 1100 ? "tablet" : "desktop");

const asFileUrl = (p) => (/^https?:\/\//i.test(p) ? p : `file:///${p.replace(/\\/g, "/")}`);

function chrome(args) {
  return spawnSync(BROWSER, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
    "--force-device-scale-factor=1", "--default-background-color=ffffffff",
    // Local files loaded inside a local iframe need this, and it is harmless for http:// targets.
    "--allow-file-access-from-files",
    ...args,
  ], { encoding: "utf8" });
}

/**
 * Capture one page at one width. Returns the output path, or null with the reason logged.
 *
 * `settleMs` matters for a running app and not at all for a static file: a React page that fetches
 * on mount paints an empty table first, so a shot taken too early is of the loading state. Chrome's
 * --virtual-time-budget advances the clock rather than sleeping, so this costs no wall time.
 */
export function capture({ url, out, width, height, settleMs = 0 }) {
  mkdirSync(dirname(out), { recursive: true });
  const target = asFileUrl(url);
  const budget = settleMs > 0 ? [`--virtual-time-budget=${settleMs}`] : [];

  if (width >= MIN_HONEST_WIDTH) {
    const r = chrome([...budget, `--screenshot=${out}`, `--window-size=${width},${height}`, target]);
    return existsSync(out) ? out : fail(out, width, r);
  }

  // Narrow: wrap it. The window is legal, the iframe is the width we actually want, and the shot is
  // clipped to the iframe's box — so what lands on disk is a true `width`-wide render.
  const shim = join(tmpdir(), `em-shoot-${width}-${process.pid}-${Math.abs(hash(out))}.html`);
  writeFileSync(shim, `<!doctype html><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; background:#fff; }
  iframe { width:${width}px; height:${height}px; border:0; display:block; }
</style>
<iframe src="${target}"></iframe>
`, "utf8");
  // THE NARROW PATH CANNOT TELL A SETTLED PAGE FROM A LOADING ONE — KIT-FINDINGS BT11.
  //
  // The iframe is a separate document, and --virtual-time-budget advances a clock in the MAIN frame, so it
  // does not wait for the nested document's in-flight fetch. Measured: a backend failing after 3s produced
  // a `loading` picture filed under `--state unreachable`, three runs running, including at --settle 8000.
  // The desktop path uses direct capture and got it right every time.
  //
  // The failure mode is the dangerous kind — not an error, a PLAUSIBLE PICTURE WITH THE WRONG CAPTION, and
  // it goes into review/index.html beside the agreed design as evidence of a state nobody has seen.
  //
  // WARNED RATHER THAN DETECTED, deliberately. Whether a request was still in flight is not observable from
  // the Chrome CLI — the only outputs are the PNG and an exit code — so anything stronger means a second
  // browser invocation or a readiness protocol the page would have to co-operate with. What IS knowable is
  // the condition that makes the shot untrustworthy: this path, against a LIVE url. A static design page
  // fetches nothing and is unaffected, which is why the warning is conditioned on the scheme rather than
  // printed on every narrow capture.
  if (/^https?:/i.test(target)) {
    console.warn(`  ! ${width}px is captured through an <iframe> (Windows will not lay out a real window `
      + `below ~${MIN_HONEST_WIDTH}px), and that path CANNOT wait for the page's own fetch. If this screen `
      + `loads data, the shot may be of the loading state while carrying the name you asked for. The `
      + `desktop shot is authoritative; a ui-journey walk is what actually proves a mobile state.`);
  }

  try {
    const r = chrome([
      ...budget,
      `--screenshot=${out}`,
      // Exactly the iframe's box: no window chrome, no gutter, nothing to crop off afterwards.
      `--window-size=${width},${height}`,
      `--force-device-scale-factor=1`,
      asFileUrl(shim),
    ]);
    // The window is still clamped to ~500 by the OS, but the IFRAME is 390 — so the page inside is
    // laid out at 390 and the crop takes the iframe's own top-left box. That is the whole trick.
    return existsSync(out) ? out : fail(out, width, r);
  } finally {
    try { rmSync(shim, { force: true }); } catch { /* a temp file we could not remove is not an error */ }
  }
}

function fail(out, width, r) {
  console.error(`screenshot failed at ${width}px -> ${out}`);
  if (r?.stderr) console.error(r.stderr.split("\n").slice(0, 4).join("\n"));
  return null;
}

const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

/**
 * A PNG's real pixel size, straight out of the IHDR header — no dependency, no decode.
 *
 * Worth having because a contact sheet that GUESSES row heights from --height misaligns every row the
 * moment one page is taller than another, and silently crops the last one. The shots are on disk; their
 * height is a fact, so read it instead of assuming it.
 */
export function pngSize(path) {
  const b = readFileSync(path);
  // 8-byte signature, then a 4-byte length and "IHDR", then width and height as big-endian uint32.
  if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** A file path as a URL an <img src> inside a temp-file page can actually resolve. */
export const fileUrl = (p) => `file:///${p.replace(/\\/g, "/")}`;

/** Shoot an arbitrary HTML string at an exact size — how both tools build their contact sheets. */
// RELATIVE SUBRESOURCES DO NOT WORK HERE, and the failure is silent.
//
// The markup is written to tmpdir and shot from there, so every relative <img>, <link> or <script> in it
// resolves against %TEMP% rather than against wherever its assets live. Chrome renders a broken-image icon
// and exits 0, so the PNG is produced, the caller reports success, and nobody finds out until a human looks
// at the picture. `design.mjs` built its contact sheet this way from the day it was written and every sheet
// it ever produced was a grid of broken icons.
//
// So: pass ABSOLUTE urls (see fileUrl / asFileUrl, which is what review.mjs does), or — better — write the
// file next to its assets and use `capture({ url: <that file> })` instead, which is what design.mjs does now.
// Reach for this only when the html genuinely has no external references.
export function captureHtml({ html, out, width, height }) {
  const p = join(tmpdir(), `em-sheet-${process.pid}-${Math.abs(hash(out))}.html`);
  writeFileSync(p, html, "utf8");
  try {
    const r = chrome([`--screenshot=${out}`, `--window-size=${width},${height}`, asFileUrl(p)]);
    return existsSync(out) ? out : fail(out, width, r);
  } finally {
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}
