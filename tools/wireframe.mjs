#!/usr/bin/env node
// Grow the UI lane and scaffold a low-fidelity wireframe inside every screen cell.
//
//   node tools/wireframe.mjs scaffold <file.drawio>
//
// The book draws wireframes on the model, and they are sketch-level on purpose. This makes the
// UI lane tall enough to hold one and fills each screen with a bound cell per attribute, so the
// wireframe is not a picture the checker cannot see:
//
//   em="field"  binds="hours"          one attribute of displays= / inputs=
//   em="action" command="BookHours"    the affordance — the thing that differs between the three
//                                      slices that share the Timesheet screen
//   em="chrome"                        decoration. Bound to nothing, checked for nothing.
//
// This is a SCAFFOLD, run once, not a sync step. The stacked layout it produces says nothing
// about the real design — its value is that the cells exist, are bound, and are checked. Drag
// them into a real arrangement in draw.io afterwards; `screen/` rules keep the bindings honest.
//
// Idempotent: a screen that already holds field cells is left alone.
//
// Everything below the screens shifts down, which is why this is a tool and not a hand edit —
// it touches every y and every routing point in the file.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SCREEN_H = 300;          // tall enough for ~10 stacked rows plus a title and an action
const ROW_H = 22, PAD = 10, TITLE_H = 24, ACTION_H = 24;

const [cmd, target] = process.argv.slice(2);
if (cmd !== "scaffold" || !target) {
  console.error("usage: node tools/wireframe.mjs scaffold <file.drawio>");
  process.exit(2);
}
const file = resolve(target);
if (!existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}
let xml = readFileSync(file, "utf8");
// EVERY .drawio in this kit is CRLF — the template, the fixtures, the reference implementations, and
// therefore every model grown from one. Every block regex below ends `</object>\n` or `</mxCell>\n`,
// which cannot match `\r\n`, so on a CRLF file NOTHING matches and this exits with "no screen cells"
// on a model that has four. Silent, and it looked like a modelling mistake for a while. Normalise on
// read and restore on write, exactly as tools/slice.mjs does.
const crlf = xml.includes("\r\n");
if (crlf) xml = xml.replace(/\r\n/g, "\n");
if (!/<mxGraphModel/.test(xml)) {
  console.error("source is compressed — run: node tools/drawio.mjs inflate <file>");
  process.exit(1);
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
const attr = (chunk, k) => {
  const m = new RegExp(`\\b${k}="([^"]*)"`).exec(chunk);
  return m ? unesc(m[1]) : null;
};
const names = (spec) =>
  (spec ?? "").split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean);

// ---------------------------------------------------------------- read what we need

// The self-closing alternative must come SECOND and use [^>]*? so it cannot cross a ">". Written as
// `[\s\S]*?(?:<\/mxCell>\n|\/>\n)` a lazy match stops at whichever comes first — and inside an edge
// that is its own self-closing <mxGeometry ... />. The block then ends early, the trailing
// </mxCell> matches nothing, and the rewrite below DROPS it: every edge in the file loses its
// closing tag. Found while building tools/slice.mjs, which had inherited the same pattern.
const BLOCK_RE = new RegExp(
  "        <object [\\s\\S]*?</object>\\n" +
  "|        <mxCell id=\"(?!0\"|1\")[^>]*?/>\\n" +
  "|        <mxCell id=\"(?!0\"|1\")[\\s\\S]*?</mxCell>\\n", "g");
const blocks = [...xml.matchAll(BLOCK_RE)].map((m) => m[0]);

const geom = (b) => {
  const g = /<mxGeometry([^>]*?)as="geometry"/.exec(b);
  if (!g) return null;
  const n = (k) => { const m = new RegExp(`${k}="([-\\d.]+)"`).exec(g[1]); return m ? +m[1] : 0; };
  return { x: n("x"), y: n("y"), w: n("width"), h: n("height") };
};

const screens = blocks.filter((b) => /\bem="screen"/.test(b));
if (!screens.length) {
  console.log(`${target}: no screen cells — nothing to scaffold.`);
  process.exit(0);
}
const already = blocks.some((b) => /\bem="(field|action|chrome)"/.test(b));
if (already) {
  console.log(`${target}: wireframes already present — leaving it alone.`);
  process.exit(0);
}

const sg = geom(screens[0]);
const DELTA = SCREEN_H - sg.h;
if (DELTA < 0) {
  console.error(`screens are already ${sg.h} tall, taller than the ${SCREEN_H} target.`);
  process.exit(1);
}
// Everything at or below the old bottom edge of the screens moves down by exactly the growth.
const THRESH = sg.y + sg.h;

// The command each screen triggers, for the action cell. Read off the real edge, never guessed.
const label = new Map(blocks.map((b) => [attr(b, "id"), attr(b, "label")]));
const isCmd = new Set(blocks.filter((b) => /\bem="command"/.test(b)).map((b) => attr(b, "id")));
const triggers = new Map();
for (const b of blocks) {
  if (!/edge="1"/.test(b)) continue;
  const s = attr(b, "source"), t = attr(b, "target");
  if (s && t && isCmd.has(t)) triggers.set(s, label.get(t));
}

// ---------------------------------------------------------------- shift, grow, scaffold

const shiftY = (g, by) => (m, pre, v) => `${pre}"${+v + by}"`;

const rewritten = blocks.map((b) => {
  const g = geom(b);
  const isScreen = /\bem="screen"/.test(b);
  const isUiLane = /\bid="lane-ui"/.test(b);
  const isSlice = /\bem="group"/.test(b);

  let out = b;
  if (g) {
    if (isScreen) {
      out = out.replace(/(<mxGeometry[^>]*?)height="[-\d.]+"/, `$1height="${SCREEN_H}"`);
    } else if (isUiLane || isSlice) {
      // Both start above the screens and have to grow rather than move.
      out = out.replace(/(<mxGeometry[^>]*?)height="([-\d.]+)"/, (m, pre, h) => `${pre}height="${+h + DELTA}"`);
    } else if (g.y >= THRESH) {
      out = out.replace(/(<mxGeometry[^>]*?\by=)"([-\d.]+)"/, (m, pre, v) => `${pre}"${+v + DELTA}"`);
    }
  }
  // Routing points live in edge geometry and have to follow the bands they were allocated in.
  out = out.replace(/<mxPoint x="([-\d.]+)" y="([-\d.]+)"/g,
    (m, x, y) => `<mxPoint x="${x}" y="${+y >= THRESH ? +y + DELTA : y}"`);
  return out;
});

const cells = [];
let fields = 0;
for (const s of screens) {
  const g = geom(s), id = attr(s, "id"), slice = attr(s, "slice");
  const disp = names(attr(s, "displays")), inp = names(attr(s, "inputs"));
  const rows = [...disp, ...inp.filter((n) => !disp.includes(n))];
  const cmdLabel = triggers.get(id);
  const innerW = g.w - 2 * PAD;

  // NO TITLE CHROME. A screen cell is styled `verticalAlign=top; spacingTop=6` and therefore already
  // draws its own label at the top of the box — a chrome cell at y+6 rendered the name a second time
  // on top of it, "Cart PageCart Page". Invisible in XML, obvious in the PNG, and never seen before
  // because the CRLF bug above meant this scaffold had never once run on a file in this kit.
  // TITLE_H is still reserved below, so the rows start under the label rather than through it.

  // Room for the rows between the title and the action button at the foot.
  const top = g.y + 6 + TITLE_H;
  const room = SCREEN_H - (top - g.y) - (cmdLabel ? ACTION_H + PAD : PAD) - PAD;
  const h = Math.min(ROW_H, Math.floor(room / Math.max(1, rows.length))) - 2;

  rows.forEach((n, i) => {
    // A name that is typed as well as shown is drawn as the input: it is the editable one.
    const typed = inp.includes(n);
    cells.push(`        <object id="wf-${id}-${n}" label="${n}" em="field" binds="${n}" slice="${slice}">
          <mxCell style="rounded=0;whiteSpace=wrap;html=1;fillColor=${typed ? "#ffffff" : "#f0f0f0"};strokeColor=${typed ? "#999999" : "#dddddd"};fontSize=9;align=left;spacingLeft=4;fontColor=#555555;${typed ? "" : "dashed=1;dashPattern=1 2;"}" vertex="1" parent="1">
            <mxGeometry x="${g.x + PAD}" y="${top + i * (h + 2)}" width="${innerW}" height="${h}" as="geometry" />
          </mxCell>
        </object>`);
    fields++;
  });

  if (cmdLabel) {
    cells.push(`        <object id="wf-${id}-action" label="${cmdLabel}" em="action" command="${cmdLabel}" slice="${slice}">
          <mxCell style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=9;fontStyle=1;fontColor=#334f6d;" vertex="1" parent="1">
            <mxGeometry x="${g.x + g.w - PAD - 100}" y="${g.y + SCREEN_H - PAD - ACTION_H}" width="100" height="${ACTION_H}" as="geometry" />
          </mxCell>
        </object>`);
  }
}

xml = xml
  .replace(/(<root>\n)[\s\S]*?(      <\/root>)/,
    `$1        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n${rewritten.join("")}${cells.join("\n")}\n$2`)
  .replace(/pageHeight="(\d+)"/, (m, h) => `pageHeight="${+h + DELTA}"`);

writeFileSync(file, crlf ? xml.replace(/\n/g, "\r\n") : xml, "utf8");
console.log(`${target}: ${screens.length} screen(s) grown ${sg.h}->${SCREEN_H}px (+${DELTA} below), ${fields} bound field(s), ${cells.length} cell(s) added.`);
