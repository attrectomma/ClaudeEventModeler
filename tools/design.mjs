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
import { tryProjectRoot } from "./project.mjs";
import { BROWSER, browserHelp, capture, captureHtml } from "./shoot.mjs";

const BROWSERS = [];   // kept only so the old help text below still has something to print

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
// `shot` needs a file, but `sheet` and `check` have exactly one sensible target in a one-project
// kit: the project's designs/ and diagrams/. Defaulting removes the kit-relative-path mistake.
const explicit = args[1] && !args[1].startsWith("--") ? args[1] : null;
const PROJ = tryProjectRoot(args)?.root ?? null;
const target = explicit ??
  (cmd === "sheet" && PROJ ? join(PROJ, "designs")
   : cmd === "check" && PROJ ? join(PROJ, "diagrams") : null);
const WIDTHS = flag("widths", "1440,390").split(",").map((n) => +n.trim()).filter(Boolean);
const HEIGHT = +flag("height", "1200");

if (!cmd || !target || !["shot", "sheet", "check"].includes(cmd)) {
  console.error("usage:\n" +
    "  node tools/design.mjs shot  <file.html>    [--widths 1440,390] [--height 1200]\n" +
    "  node tools/design.mjs sheet [designs-dir]  [--widths 1440,390] [--height 1200]\n" +
    "  node tools/design.mjs check [diagrams-dir] [--designs <dir>] [--project <path>]\n" +
    "       sheet and check default to the project's designs/ and diagrams/");
  process.exit(2);
}
if (!BROWSER && cmd !== "check") {
  console.error(browserHelp());
  process.exit(1);
}
const path = resolve(target);
if (!existsSync(path)) {
  console.error(`not found: ${path}`);
  process.exit(1);
}

// Report paths relative to the PROJECT, not to the kit. cwd is the kit copy and the project lives
// somewhere else entirely, so relative(cwd, …) produces ..\..\..\Users\… — technically correct and
// unreadable in a finding.
const rel = (p) => {
  const base = PROJ ?? process.cwd();
  const r = relative(base, p);
  return r.startsWith("..") ? p : r;
};

// A name a width can be talked about by, so a finding can say WHICH viewport broke.
const label = (w) => (w < 500 ? "mobile" : w < 900 ? "tablet" : "desktop");

// --- check: the third leg of the three-way check --------------------------------------------------
//
//   displays= / inputs=   <->   wireframe binds=   <->   HTML data-em
//
// model.mjs already checks the first two against each other. This checks the styled page against
// the model, which is the leg nothing could see before: a design that shows a field the system
// cannot supply looks perfectly fine in a browser and is discovered during implementation.
//
// The unit is the SCREEN SLUG, not the screen cell, and that is the whole reason the slug exists.
// One page serves every slice that screen appears in — the Timesheet hosts book, correct AND remove
// — so the page is checked against the union of those slices' inputs and commands. A page missing
// an affordance the model says the screen offers is a real finding.

if (cmd === "check") {
  const systemDir = path;
  // Designs are project output, and with the <system> level dropped they sit flat: one page per
  // screen slug at <project>/designs/<slug>.html. Falling back to the diagrams folder's sibling
  // keeps this usable on a bare folder with no project configured.
  const PROJECT = PROJ ?? dirname(systemDir);
  const designs = resolve(PROJECT, flag("designs", "designs"));
  const models = readdirSync(systemDir)
    .filter((f) => f.endsWith(".drawio") && !f.startsWith("_"))
    .map((f) => join(systemDir, f));
  if (!models.length) {
    console.error(`${target}: no models found.`);
    process.exit(1);
  }

  // One parser for the model, and it is not this file's. Shell out to compile rather than
  // re-implementing mxGraph parsing, which would drift.
  const screens = new Map();   // slug -> { displays:Set, inputs:Set, commands:Set, bound:Set, cells:[] }
  for (const m of models) {
    const r = spawnSync(process.execPath, [new URL("model.mjs", import.meta.url).pathname.replace(/^\//, ""), "compile", m], { encoding: "utf8", maxBuffer: 1 << 26 });
    if (r.status !== 0) {
      console.error(`compile failed for ${basename(m)}:\n${r.stderr}`);
      process.exit(1);
    }
    const ir = JSON.parse(r.stdout);
    const byId = new Map(ir.elements.map((e) => [e.id, e]));
    const inside = (o, g) => o.geometry && g &&
      g.x + g.w / 2 >= o.geometry.x && g.x + g.w / 2 <= o.geometry.x + o.geometry.w &&
      g.y + g.h / 2 >= o.geometry.y && g.y + g.h / 2 <= o.geometry.y + o.geometry.h;

    for (const s of ir.elements.filter((e) => e.kind === "screen" && e.screen)) {
      if (!screens.has(s.screen)) {
        screens.set(s.screen, { displays: new Set(), inputs: new Set(), commands: new Set(), bound: new Set(), label: s.label });
      }
      const rec = screens.get(s.screen);
      s.displays.forEach((f) => rec.displays.add(f.name));
      s.inputs.forEach((f) => rec.inputs.add(f.name));
      for (const d of s.downstream) if (byId.get(d)?.kind === "command") rec.commands.add(byId.get(d).label);
      for (const p of ir.elements) {
        if ((p.kind === "field" && p.binds) && inside(s, p.geometry)) rec.bound.add(p.binds);
      }
    }
  }

  const d = [];
  const push = (severity, rule, message) => d.push({ severity, rule, message });
  const attrsOf = (html, name) =>
    new Set([...html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1].trim()).filter(Boolean));

  // Any ported implementation of the same screen. JSX writes data-em exactly as HTML does, so the
  // same extraction works and the port is held to the model too — not just the static design.
  const ports = [];
  const genRoot = join(PROJECT, "generated");
  for (const web of existsSync(genRoot)
    ? readdirSync(genRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
        .map((d) => join(genRoot, d.name, "web", "src")).filter(existsSync)
    : []) {
    for (const f of readdirSync(web)) if (f.endsWith(".tsx")) ports.push(join(web, f));
  }

  const pageFiles = existsSync(designs)
    ? readdirSync(designs).filter((f) => f.endsWith(".html") && f !== "index.html" && !f.startsWith("_"))
    : [];

  for (const [slug, rec] of screens) {
    const file = join(designs, `${slug}.html`);
    if (!existsSync(file)) {
      push("info", "design-not-drawn",
        `screen "${slug}" has no styled page yet (expected ${rel(file)}). The wireframe stands in until it does.`);
      continue;
    }
    // A port counts as the same screen when its file name matches the slug, case-insensitively.
    const portFiles = ports.filter((p) =>
      basename(p, ".tsx").toLowerCase() === slug.replace(/-/g, "").toLowerCase());
    const html = [file, ...portFiles].map((f) => readFileSync(f, "utf8")).join("\n");
    if (portFiles.length) push("info", "design-has-port",
      `${slug} is also implemented at ${portFiles.map((p) => rel(p)).join(", ")}, and its bindings are checked here too.`);
    const shown = attrsOf(html, "data-em");
    const typed = attrsOf(html, "data-em-input");
    const acted = attrsOf(html, "data-em-action");
    const known = new Set([...rec.displays, ...rec.inputs]);

    for (const n of [...shown, ...typed]) {
      if (!known.has(n)) {
        push("error", "design-unknown-field",
          `${slug}.html shows "${n}", which the screen neither displays nor takes as input. The design is showing data the system cannot supply — add it to displays= and give it a View, or drop it.`);
      }
    }
    for (const a of acted) {
      if (!rec.commands.has(a)) {
        push("error", "design-unknown-action",
          `${slug}.html offers "${a}", but this screen triggers ${[...rec.commands].join(", ") || "no command"}. The button and the model disagree.`);
      }
    }
    for (const n of rec.displays) {
      if (!shown.has(n) && !typed.has(n)) {
        push("warn", "design-field-missing",
          `${slug} displays "${n}" but ${slug}.html never shows it. Either draw it, or drop it from displays= — an attribute nothing displays makes its View over-specified.`);
      }
    }
    for (const n of rec.inputs) {
      if (!typed.has(n)) {
        push("warn", "design-input-missing",
          `${slug} takes "${n}" as input but ${slug}.html has no data-em-input for it. A field the user must type and the page does not offer is a dead command.`);
      }
    }
    // The point of the slug: one page carries every affordance of that screen.
    for (const a of rec.commands) {
      if (!acted.has(a)) {
        push("warn", "design-action-missing",
          `${slug} triggers "${a}" somewhere in the model but ${slug}.html offers no such action. One page serves every slice this screen appears in.`);
      }
    }
    const unbound = [...shown, ...typed].filter((n) => known.has(n) && !rec.bound.has(n));
    if (unbound.length) {
      push("info", "design-ahead-of-wireframe",
        `${slug}.html shows ${unbound.join(", ")}, which the wireframe does not draw. Not wrong — the model declares them — but the wireframe and the design disagree about what the screen is.`);
    }
  }

  for (const f of pageFiles) {
    const slug = basename(f, ".html");
    if (!screens.has(slug)) {
      push("error", "design-orphan-page",
        `${f} matches no screen= slug in this system (${[...screens.keys()].join(", ") || "none"}). A page nothing in the model points at will never be generated from.`);
    }
  }

  const icon = { error: "ERROR", warn: " WARN", info: " INFO" };
  const rank = { error: 0, warn: 1, info: 2 };
  d.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule));
  console.log(`${basename(systemDir)} — ${screens.size} screen(s), ${pageFiles.length} styled page(s) in ${rel(designs)}\n`);
  for (const f of d) console.log(`  ${icon[f.severity]}  [design/${f.rule}] ${f.message}`);
  const errors = d.filter((f) => f.severity === "error").length;
  console.log(`\n${errors} error(s), ${d.filter((f) => f.severity === "warn").length} warning(s), ${d.filter((f) => f.severity === "info").length} note(s)`);
  process.exit(errors ? 1 : 0);
}

// Delegates to tools/shoot.mjs, which is where the sub-500px viewport bug is dealt with. This used to
// call Chrome directly with --window-size=<width>, and on Windows that silently produced a CROP OF A
// 500px LAYOUT for any mobile width — inventing clipping that did not exist. See shoot.mjs for the
// measurement. Sharing the capture path also means a design shot and a tools/review.mjs shot of the
// built page are taken identically, which is the only thing that makes them comparable.
function shoot(htmlPath, outPath, width) {
  return capture({ url: htmlPath, out: outPath, width, height: HEIGHT });
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
  // The sheet gets its own viewport, independent of --height, so nothing is cropped. It is always wide,
  // so it never hits the narrow-window problem the individual shots do.
  if (captureHtml({ html, out, width: sheetW, height: sheetH })) {
    sheets.push({ label: label(w), out, sheetW, sheetH });
  } else {
    console.error(`contact sheet failed for ${label(w)}`);
  }
}

// A third reader: VS Code. Markdown preview (Ctrl+Shift+V) renders these inline, so the whole set is
// viewable in the editor without opening each PNG or leaving for a browser. No extension needed;
// kisstkondoros.vscode-gutter-preview additionally shows a thumbnail when hovering an image path.
writeFileSync(join(shotDir, "SHOTS.md"), [
  `# ${basename(path)} — screenshots`, "",
  "Generated by `tools/design.mjs sheet`. Open the preview with **Ctrl+Shift+V**.", "",
  ...sheets.map((s) => [`## contact sheet — ${s.label}`, "", `![${s.label}](${basename(s.out)})`, ""]).flat(),
  "## every screen, separately", "",
  ...shots.map((s) => [`### ${s.stem} · ${label(s.w)} ${s.w}px`, "", `![${s.stem}](${s.file})`, ""]).flat(),
].join("\n"), "utf8");

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

console.log(`${shots.length} shot(s) of ${pages.length} screen(s) in ${rel(shotDir)}`);
for (const s of sheets) console.log(`  look at this: ${rel(s.out)}  (${s.sheetW}x${s.sheetH})`);
console.log(`give the human this: ${rel(join(path, "index.html"))}`);
