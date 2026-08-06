#!/usr/bin/env node
// Screenshots of the BUILT SOFTWARE, kept somewhere a human can review them.
//
//   node tools/review.mjs shot <url> --screen <slug> [--state <name>] [--widths 1440,390] [--height 1200] [--settle 1200]
//   node tools/review.mjs sheet  [--widths 1440,390]
//   node tools/review.mjs clear
//
// WHY THIS EXISTS. "Never hand over a design nobody has looked at" was already enforced for the static
// design pages by tools/design.mjs. But a static design page is NOT the software: it cannot show a
// wrong API path, an unapplied seed, a state the port forgot, or a layout that only breaks once real
// data of real length arrives. The implementing agents were already screenshotting the running app —
// and dumping the results in a temp folder that died with the session, so the one artifact a human
// needs at review time was the one being thrown away.
//
// So: the same treatment the design gets. A durable folder, a contact sheet per viewport, and an
// index.html that puts the DESIGN and the IMPLEMENTATION side by side for the same screen at the same
// width — which is the only view in which "does the build match what we agreed" is a question a human
// can actually answer.
//
// Shots land in <project>/review/_shots/ and are gitignored, exactly like designs/_shots/: they are
// regenerable evidence, not source. Re-run the tool, do not commit the PNGs.

import { readdirSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, basename, relative } from "node:path";
import { projectRoot } from "./project.mjs";
import { BROWSER, browserHelp, capture, captureHtml, label, pngSize, fileUrl } from "./shoot.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const WIDTHS = flag("widths", "1440,390").split(",").map((n) => +n.trim()).filter(Boolean);
const HEIGHT = +flag("height", "1200");
// A running app fetches on mount, so a shot taken immediately is of the loading state. Chrome advances
// a virtual clock rather than sleeping, so this is free.
const SETTLE = +flag("settle", "1200");

if (!cmd || !["shot", "sheet", "clear"].includes(cmd)) {
  console.error("usage:\n" +
    "  node tools/review.mjs shot <url> --screen <slug> [--state <name>] [--widths 1440,390] [--height 1200] [--settle 1200]\n" +
    "  node tools/review.mjs sheet [--widths 1440,390]\n" +
    "  node tools/review.mjs clear\n\n" +
    "  <url> is the RUNNING app — http://localhost:5173/ or whatever the compose app publishes.\n" +
    "  --screen must be the screen= slug from the model, so the shot pairs with its design.\n" +
    "  --state names a state that has no design counterpart: rejected, pending, empty, page2, …");
  process.exit(2);
}
if (!BROWSER) { console.error(browserHelp()); process.exit(1); }

const PROJ = projectRoot(args);   // returns the path itself, not a {root} — unlike tryProjectRoot
const reviewDir = join(PROJ, "review");
const shotDir = join(reviewDir, "_shots");
const designShots = join(PROJ, "designs", "_shots");
const rel = (p) => relative(process.cwd(), p) || p;

// slug__state-viewport.png. Double underscore because a slug contains single hyphens and a state may
// too, and a filename has to be unambiguously splittable back into its parts.
const SEP = "__";
const shotName = (slug, state, w) => `${slug}${SEP}${state}-${label(w)}.png`;
const parseShot = (f) => {
  const m = /^(.+?)__(.+)-(mobile|tablet|desktop)\.png$/.exec(f);
  return m ? { slug: m[1], state: m[2], viewport: m[3], file: f } : null;
};

// --- clear -----------------------------------------------------------------------------------------
if (cmd === "clear") {
  if (existsSync(shotDir)) rmSync(shotDir, { recursive: true, force: true });
  for (const f of ["index.html", "SHOTS.md"]) {
    const p = join(reviewDir, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  console.log(`cleared ${rel(reviewDir)}`);
  process.exit(0);
}

// --- shot ------------------------------------------------------------------------------------------
if (cmd === "shot") {
  const url = args[1];
  const slug = flag("screen", null);
  const state = flag("state", "default");
  if (!url || url.startsWith("--") || !slug) {
    console.error("shot needs a <url> and --screen <slug>. The slug must match the model's screen= value.");
    process.exit(2);
  }
  mkdirSync(shotDir, { recursive: true });
  let n = 0;
  for (const w of WIDTHS) {
    const out = join(shotDir, shotName(slug, state, w));
    if (capture({ url, out, width: w, height: HEIGHT, settleMs: SETTLE })) {
      console.log(`  ${rel(out)}`);
      n++;
    }
  }
  console.log(`${n} shot(s) of ${slug} (${state}) from ${url}`);
  console.log(`then: node tools/review.mjs sheet`);
  process.exit(n ? 0 : 1);
}

// --- sheet -----------------------------------------------------------------------------------------
if (!existsSync(shotDir)) {
  console.error(`${rel(shotDir)} is empty. Take some shots first:\n` +
    `  node tools/review.mjs shot http://localhost:8080/ --screen <slug>`);
  process.exit(1);
}
const shots = readdirSync(shotDir).map(parseShot).filter(Boolean);
if (!shots.length) { console.error(`no shots in ${rel(shotDir)}`); process.exit(1); }

const slugs = [...new Set(shots.map((s) => s.slug))].sort();
const designFor = (slug, viewport) => {
  const f = join(designShots, `${slug}-${viewport}.png`);
  return existsSync(f) ? f : null;
};

// One contact sheet per viewport, columns at NATIVE width — same reasoning as design.mjs: a 1440px shot
// scaled into a shared column is illegible, which defeats the point of looking at it.
const GAP = 24, CAP = 34, HEAD = 78;
const sheets = [];
for (const w of WIDTHS) {
  const view = label(w);
  const mine = shots.filter((s) => s.viewport === view);
  if (!mine.length) continue;

  // Design first where one exists, then the implementation states — so the eye reads left to right from
  // "what we agreed" to "what got built".
  //
  // Every src is an ABSOLUTE file:// URL. The sheet's HTML is written to a temp directory, so a bare
  // filename resolves against that directory and every image renders as a broken-image icon. Which is
  // exactly what the first run of this tool produced, and exactly the kind of thing only looking catches.
  const cells = [];
  for (const slug of slugs) {
    const d = designFor(slug, view);
    if (d) cells.push({ caption: `${slug} · DESIGN`, path: d, design: true });
    for (const s of mine.filter((x) => x.slug === slug).sort((a, b) =>
      a.state === "default" ? -1 : b.state === "default" ? 1 : a.state.localeCompare(b.state))) {
      cells.push({ caption: `${slug} · ${s.state}`, path: join(shotDir, s.file), design: false });
    }
  }
  for (const c of cells) c.h = pngSize(c.path)?.height ?? HEIGHT;

  const cols = Math.max(1, Math.floor(2560 / w));
  const sheetW = cols * w + (cols + 1) * GAP;
  // Row heights come from the IMAGES, not from --height. Guessing crops the tallest row, and a design
  // page carrying a States panel is routinely taller than the built screen it is compared against.
  let sheetH = HEAD + GAP;
  for (let i = 0; i < cells.length; i += cols) {
    sheetH += Math.max(...cells.slice(i, i + cols).map((c) => c.h)) + CAP + GAP;
  }
  const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; padding:${GAP}px; background:#fff; font:13px/1.4 "Segoe UI", system-ui, sans-serif; color:#111; }
  h1 { font-size:15px; margin:0 0 4px; }
  p.sub { margin:0 0 ${GAP}px; color:#777; font-size:12px; }
  .grid { display:flex; flex-wrap:wrap; gap:${GAP}px; align-items:flex-start; }
  figure { margin:0; width:${w}px; }
  figcaption { font-size:12px; height:${CAP}px; font-weight:600; }
  figcaption.d { color:#7a5cff; }
  figcaption.i { color:#111; }
  figcaption em { display:block; font-weight:400; font-style:normal; color:#999; font-size:11px; }
  img { width:${w}px; display:block; border:1px solid #ddd; }
</style>
<h1>review — ${view} (${w}px)</h1>
<p class="sub">${cells.length} shot(s) at 1:1. Purple caption = the agreed design; black = the built software. Generated by tools/review.mjs; do not edit.</p>
<div class="grid">
${cells.map((c) => `  <figure><figcaption class="${c.design ? "d" : "i"}">${c.caption}<em>${w}px · ${c.h}px tall</em></figcaption><img src="${fileUrl(c.path)}"></figure>`).join("\n")}
</div>
`;
  const out = join(shotDir, `review-sheet-${view}.png`);
  if (captureHtml({ html, out, width: sheetW, height: sheetH })) sheets.push({ view, out, sheetW, sheetH });
}

// The human's entry point, and the thing the whole tool is for: design beside implementation, same
// screen, same width, at 1:1.
const indexHtml = `<!doctype html><meta charset="utf-8">
<title>review — ${basename(PROJ)}</title>
<style>
  body { margin:0; padding:32px; background:#f6f7f8; font:14px/1.5 "Segoe UI", system-ui, sans-serif; color:#111; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 28px; color:#666; font-size:13px; }
  h2 { font-size:15px; margin:34px 0 10px; padding-top:14px; border-top:1px solid #dcdfe3; }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#888; margin:18px 0 8px; font-weight:600; }
  .row { display:flex; gap:18px; align-items:flex-start; flex-wrap:wrap; }
  figure { margin:0; background:#fff; border:1px solid #dcdfe3; border-radius:6px; overflow:hidden; }
  figcaption { font-size:11px; padding:5px 9px; border-bottom:1px solid #eee; color:#555; }
  figure.design figcaption { color:#7a5cff; font-weight:600; }
  img { display:block; max-width:100%; }
  .missing { padding:14px; color:#a00; font-size:12px; background:#fff; border:1px dashed #e0b4b4; border-radius:6px; }
</style>
<h1>review — ${basename(PROJ)}</h1>
<p class="sub">The <strong>design</strong> beside the <strong>built software</strong>, same screen, same width, 1:1.
Generated by <code>tools/review.mjs sheet</code>. Shots are gitignored — re-run the tool rather than committing them.</p>
${slugs.map((slug) => `<h2>${slug}</h2>
${WIDTHS.map((w) => {
  const view = label(w);
  const d = designFor(slug, view);
  const impl = shots.filter((s) => s.slug === slug && s.viewport === view)
    .sort((a, b) => (a.state === "default" ? -1 : b.state === "default" ? 1 : a.state.localeCompare(b.state)));
  if (!d && !impl.length) return "";
  return `  <h3>${view} · ${w}px</h3>
  <div class="row">
${d ? `    <figure class="design"><figcaption>design</figcaption><img src="../designs/_shots/${basename(d)}"></figure>`
     : `    <div class="missing">no design shot for <code>${slug}</code> at ${view}. Run <code>node tools/design.mjs sheet</code>, or this screen was never styled.</div>`}
${impl.map((s) => `    <figure><figcaption>built · ${s.state}</figcaption><img src="_shots/${s.file}"></figure>`).join("\n")}
  </div>`;
}).filter(Boolean).join("\n")}`).join("\n")}
`;
mkdirSync(reviewDir, { recursive: true });
writeFileSync(join(reviewDir, "index.html"), indexHtml, "utf8");

// VS Code's markdown preview (Ctrl+Shift+V) renders these inline, so the set is reviewable without
// leaving the editor. Same third reader design.mjs serves.
writeFileSync(join(reviewDir, "SHOTS.md"), [
  `# review — ${basename(PROJ)}`, "",
  "Generated by `tools/review.mjs sheet`. Preview with **Ctrl+Shift+V**.", "",
  "Purple-captioned shots in the sheets are the agreed design; the rest are the built software.", "",
  ...sheets.map((s) => [`## review sheet — ${s.view}`, "", `![${s.view}](_shots/${basename(s.out)})`, ""]).flat(),
  "## every shot, separately", "",
  ...shots.map((s) => [`### ${s.slug} · ${s.state} · ${s.viewport}`, "", `![${s.slug}](_shots/${s.file})`, ""]).flat(),
].join("\n"), "utf8");

const missing = slugs.flatMap((slug) => WIDTHS
  .filter((w) => !designFor(slug, label(w)))
  .map((w) => `${slug} @ ${label(w)}`));

console.log(`${shots.length} shot(s) of ${slugs.length} screen(s) in ${rel(shotDir)}`);
for (const s of sheets) console.log(`  look at this: ${rel(s.out)}  (${s.sheetW}x${s.sheetH})`);
console.log(`give the human this: ${rel(join(reviewDir, "index.html"))}`);
if (missing.length) {
  console.log(`\nno design shot to compare against for: ${missing.join(", ")}`);
  console.log(`  either the screen was never styled, or tools/design.mjs sheet has not been run.`);
}
