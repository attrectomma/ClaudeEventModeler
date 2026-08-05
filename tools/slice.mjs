#!/usr/bin/env node
// Every geometric consequence of adding a slice to an event model. No domain facts, ever.
//
//   node tools/slice.mjs add      <file> --slice <n> --pattern <p> [--at <spec>] [--columns N] [--aggregate A]
//   node tools/slice.mjs swimlane <file> --label <text> --streams <A[,B]> [--identity <f[,f]>] [--height N]
//   node tools/slice.mjs route    <file> --from <id> --to <id>
//   node tools/slice.mjs identity <file> --band <id>
//   node tools/slice.mjs demote   <file> [--slice <n>]... | --from-diff
//   node tools/slice.mjs reflow   <file>
//   ... any of the above with --dry-run
//
// Specified in tools/slice.spec.md, derived by walking the cart model of Understanding
// EventSourcing ch. 12-17 as the nine appends those chapters actually are.
//
// Why a tool: the same reason as tools/wireframe.mjs, which says it out loud -- it touches every y
// and every routing point in the file. This is worse. An insert touches every x as well, and a new
// swimlane touches every y AND every slice cell's height. The book's own seventh append needs the
// maximal case: ch. 16's Inventories view feeds the Cart screen in column 1, and a View -> Screen
// edge pointing left is not the Event -> View exception, so it must be inserted at position 0.
//
// Two implementation constraints, both load-bearing:
//
//   REGEX SURGERY, NOT XML ROUND-TRIPPING. A parse-and-serialise reformats every line and destroys
//   the diff, which is the review artifact and the reason the model is committed at all. Cells this
//   does not touch come out byte-identical.
//
//   READ THE GRID OFF THE MODEL. CLAUDE.md's layout table is a snapshot and says so -- its GWT row
//   starts at 1375 while the real campaigns.drawio starts at 1330. Every y is derived per run.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const COL_PITCH = 320, EL_W = 180, EL_H = 60, SCREEN_H = 300;
const SLICE_W = 220, SLICE_PAD = 20;          // band is the column minus 20 either side
const LANE_X = 40, PAGE_RIGHT_PAD = 60;
const BAND_TOP_PAD = 25, BAND_ROW = 75, BAND_BOT_PAD = 10;
const GWT_W = 300, GWT_H = 120, GWT_PITCH = 140, GWT_TOP = 30;

const STYLE = {
  screen:     "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#666666;verticalAlign=top;spacingTop=6;fontSize=12;",
  command:    "rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=12;",
  event:      "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=12;",
  external:   "rounded=0;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=12;",
  readmodel:  "rounded=0;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=12;",
  automation: "rounded=0;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=12;",
  gwt:        "rounded=0;whiteSpace=wrap;html=1;fillColor=#f0f0f0;strokeColor=#999999;fontSize=11;align=left;spacingLeft=8;verticalAlign=top;spacingTop=6;",
  group:      "rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#b85450;dashed=1;verticalAlign=top;align=center;spacingTop=4;fontStyle=1;fontColor=#b85450;fontSize=11;",
  swimlane:   "rounded=0;whiteSpace=wrap;html=1;fillColor=#eeeeee;strokeColor=#dddddd;verticalAlign=top;align=left;spacingLeft=10;spacingTop=2;fontStyle=2;fontColor=#999999;fontSize=11;",
};
const ID_PREFIX = { screen: "scr", command: "cmd", event: "evt", external: "ext", readmodel: "rm", automation: "auto" };

// Which cells each pattern is made of, and where. Straight off the cheat sheet's four sequences,
// plus `upstream` for the one shape that is none of them. `--columns` may exceed these; extra
// columns stay empty and are the implementer's to fill.
//
// NOTE on translation: the cheat sheet's sequence includes a View, and tools/model.mjs PATTERNS
// requires one (views: true) -- so a placeholder readmodel is emitted. The book's author says they
// personally skip it for a direct translation ("I typically skip the read model definition and
// directly map the external event to an automation processor", ch. 16). The kit follows the cheat
// sheet; that divergence is reported rather than resolved here.
// [kind, column, row-within-the-Commands/Views-lane]. The row is explicit because an automation and
// a translation both put a View AND a processor in one column, and their order is load-bearing: the
// View goes UNDERNEATH. Reading upward from the event lane that is Event -> View -> Trigger, the
// cheat sheet's own order — and with the processor on top, the event's feed into the View no longer
// has to pass straight through the processor to reach it.
const PATTERN_CELLS = {
  command:     [["screen", 0, 0], ["command", 0, 0], ["event", 0, 0]],
  view:        [["readmodel", 0, 0]],
  automation:  [["automation", 0, 0], ["readmodel", 0, 1], ["command", 1, 0], ["event", 1, 0]],
  translation: [["external", 0, 0], ["automation", 0, 0], ["readmodel", 0, 1],
                ["command", 1, 0], ["event", 1, 0]],
  upstream:    [["external", 0, 0]],
};
// Only the edges the PATTERN determines. Which existing events feed a view is a domain answer and
// belongs to `route`, with ids the user supplied.
const PATTERN_EDGES = {
  command:     [["screen", "command"], ["command", "event"]],
  view:        [],
  automation:  [["readmodel", "automation"], ["automation", "command"], ["command", "event"]],
  translation: [["external", "readmodel"], ["readmodel", "automation"], ["automation", "command"], ["command", "event"]],
  upstream:    [],
};
const DEFAULT_COLS = { command: 1, view: 1, upstream: 1, automation: 2, translation: 2 };

// ---------------------------------------------------------------- text plumbing

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

const attr = (b, k) => {
  const m = new RegExp(`\\b${k}="([^"]*)"`).exec(b);
  return m ? unesc(m[1]) : null;
};
// 8-space indentation, <object> wrappers and bare <mxCell>s alike, id 0 and 1 excluded.
//
// The self-closing alternative has to come SECOND and use [^>]*? so it cannot cross a ">".
// tools/wireframe.mjs shipped this as `[\s\S]*?(?:<\/mxCell>\n|\/>\n)`, and a lazy match then stops
// at the FIRST of the two — which for an edge is the self-closing <mxGeometry ... /> inside it. The
// block ends early, the trailing </mxCell> matches nothing, and splice() silently DROPS it: 88 opens
// against 54 closes, every edge unterminated. Nothing errors; the edges simply stop existing, so
// every command reads as having no trigger.
const BLOCK_RE = new RegExp(
  "        <object [\\s\\S]*?</object>\\n" +
  "|        <mxCell id=\"(?!0\"|1\")[^>]*?/>\\n" +
  "|        <mxCell id=\"(?!0\"|1\")[\\s\\S]*?</mxCell>\\n", "g");

const geomOf = (b) => {
  const g = /<mxGeometry([^>]*?)as="geometry"/.exec(b);
  if (!g) return null;
  const n = (k) => { const m = new RegExp(`\\b${k}="([-\\d.]+)"`).exec(g[1]); return m ? +m[1] : 0; };
  const has = (k) => new RegExp(`\\b${k}="[-\\d.]+"`).test(g[1]);
  if (!has("x") && !has("width")) return null;      // relative edge geometry, not a box
  return { x: n("x"), y: n("y"), w: n("width"), h: n("height") };
};
// The short names here are w/h; the attributes are width/height. Getting that wrong does not fail —
// the else branch below happily injects a bogus w="..." and the box never resizes.
const GEOM_ATTR = { x: "x", y: "y", w: "width", h: "height" };
const setGeom = (b, kv) => b.replace(/<mxGeometry([^>]*?)as="geometry"/, (m, inner) => {
  let out = inner;
  for (const [k, v] of Object.entries(kv)) {
    if (v == null) continue;
    const a = GEOM_ATTR[k] ?? k;
    out = new RegExp(`\\b${a}="[-\\d.]+"`).test(out)
      ? out.replace(new RegExp(`\\b${a}="[-\\d.]+"`), `${a}="${v}"`)
      : ` ${a}="${v}"${out}`;
  }
  return `<mxGeometry${out}as="geometry"`;
});
const setAttr = (b, k, v) => new RegExp(`\\b${k}="[^"]*"`).test(b)
  ? b.replace(new RegExp(`\\b${k}="[^"]*"`), `${k}="${esc(v)}"`)
  : b.replace(/^(        <object )/, `$1${k}="${esc(v)}" `);

// ---------------------------------------------------------------- the model

// git's autocrlf leaves .drawio working copies with CRLF on Windows, and every block pattern here
// (and in tools/wireframe.mjs) anchors on "\n". Normalise on the way in, restore on the way out —
// so a uniformly-CRLF file still comes back byte-identical where nothing changed.
function read(target) {
  const file = resolve(target);
  if (!existsSync(file)) die(`not found: ${file}`);
  const raw = readFileSync(file, "utf8");
  if (!/<mxGraphModel/.test(raw)) {
    die(`source is compressed — run: node tools/drawio.mjs inflate ${target}`);
  }
  CRLF = raw.includes("\r\n");
  return { file, xml: CRLF ? raw.replace(/\r\n/g, "\n") : raw };
}
let CRLF = false;      // one file per invocation, so a module-level flag is honest here

function model(xml) {
  const blocks = [...xml.matchAll(BLOCK_RE)].map((m) => m[0]);
  const at = (b) => ({
    block: b, id: attr(b, "id"), em: attr(b, "em"), slice: attr(b, "slice"),
    label: attr(b, "label") ?? attr(b, "value"), g: geomOf(b),
    streams: attr(b, "streams"), identity: attr(b, "identity"),
    isEdge: /\bedge="1"/.test(b),
  });
  const cells = blocks.map(at);

  // streams= is what makes a cell a swimlane, not em=. buildIr selects on n.streams and then
  // subtracts those from `lanes`; get this wrong and every event looks misplaced.
  const swimlanes = cells.filter((c) => c.streams).sort((a, b) => a.g.y - b.g.y);
  const lanes = {};
  for (const c of cells) if (!c.streams && c.id?.startsWith("lane-")) lanes[c.id] = c;
  const sliceCells = cells.filter((c) => c.em === "group" && c.slice);
  const elements = cells.filter((c) =>
    !c.isEdge && !c.streams && c.g && !c.id.startsWith("lane-") &&
    c.em !== "group" && c.em !== "model" && c.em !== "gwt");
  const gwts = cells.filter((c) => c.em === "gwt");
  const edges = cells.filter((c) => c.isEdge);

  for (const k of ["lane-ui", "lane-cmd", "lane-evt", "lane-gwt"]) {
    if (!lanes[k]) die(`the model has no ${k}. Start from diagrams/template.drawio.`);
  }
  const grid = {
    laneW: lanes["lane-ui"].g.w,
    uiY: lanes["lane-ui"].g.y,
    cmdBottom: lanes["lane-cmd"].g.y + lanes["lane-cmd"].g.h,
    evtY: lanes["lane-evt"].g.y,
    evtBottom: lanes["lane-evt"].g.y + lanes["lane-evt"].g.h,
    gwtY: lanes["lane-gwt"].g.y,
    // A model with no elements yet still has a first column: the grid starts at LANE_X + 60.
    firstCol: elements.length ? Math.min(...elements.map((e) => e.g.x)) : LANE_X + 60,
    lastCol: elements.length ? Math.max(...elements.map((e) => e.g.x)) : null,
  };
  return { blocks, cells, lanes, swimlanes, sliceCells, elements, gwts, edges, grid };
}

const usedYs = (m, lo, hi) => {
  const ys = new Set();
  for (const b of m.blocks) {
    for (const p of b.matchAll(/<mxPoint x="[-\d.]+" y="([-\d.]+)"/g)) {
      const y = +p[1];
      if (y >= lo && y <= hi) ys.add(y);
    }
  }
  return ys;
};
const nextY = (m, base, step, lo, hi) => {
  const used = usedYs(m, lo, hi);
  for (let n = 0; n < 400; n++) if (!used.has(base + step * n)) return base + step * n;
  die(`routing band ${lo}..${hi} is full`);
};

function splice(xml, blocks) {
  return xml.replace(/(<root>\n)[\s\S]*?(      <\/root>)/,
    `$1        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n${blocks.join("")}$2`);
}
const box = (id, label, kind, extra, g) =>
  `        <object id="${id}" label="${esc(label)}"${extra}>\n` +
  `          <mxCell style="${STYLE[kind]}" vertex="1" parent="1">\n` +
  `            <mxGeometry x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" as="geometry" />\n` +
  `          </mxCell>\n        </object>\n`;
const edge = (from, to, hints, points) =>
  `        <mxCell id="e-${from}--${to}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#555555;${hints}" edge="1" parent="1" source="${from}" target="${to}">\n` +
  (points
    ? `          <mxGeometry relative="1" as="geometry">\n            <Array as="points">\n${
        points.map((p) => `              <mxPoint x="${p.x}" y="${p.y}" />`).join("\n")}\n            </Array>\n          </mxGeometry>\n`
    : `          <mxGeometry relative="1" as="geometry" />\n`) +
  `        </mxCell>\n`;
const V_HINTS = "exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;";  // down
const U_HINTS = "exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;";  // up
const H_HINTS = "exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;";  // right

// ---------------------------------------------------------------- shared transforms

// Shift x for every cell at or right of x0, and every routing point that belongs to a shifted
// column. Two different thresholds, and both are off-by-something if you use the column x:
//
//   cells  x0 - SLICE_PAD, because a slice band is drawn 20px LEFT of its own first column. At the
//          column x it does not move, and its members do — which is slice/slice-member-outside on
//          every insert. The previous slice's band is a whole pitch away, so 20 is safe.
//   points x0 - 60, because a left corridor sits at columnX - 30 - 12n and belongs to the column it
//          serves, not to the one before it.
function shiftX(blocks, x0, by) {
  let cells = 0, points = 0;
  const out = blocks.map((b) => {
    let s = b;
    const g = geomOf(b);
    if (g && g.x >= x0 - SLICE_PAD && !/\bid="lane-/.test(b) && !/\bstreams="/.test(b)) {
      s = setGeom(s, { x: g.x + by }); cells++;
    }
    s = s.replace(/<mxPoint x="([-\d.]+)"/g, (mm, x) => {
      if (+x >= x0 - 60) { points++; return `<mxPoint x="${+x + by}"`; }
      return mm;
    });
    return s;
  });
  return { blocks: out, cells, points };
}

// Widen every lane and swimlane, and the page with them.
function widen(blocks, by) {
  let n = 0;
  const out = blocks.map((b) => {
    if (!/\bid="lane-/.test(b) && !/\bstreams="/.test(b)) return b;
    const g = geomOf(b);
    if (!g) return b;
    n++;
    return setGeom(b, { w: g.w + by });
  });
  return { blocks: out, lanes: n };
}

// Everything at or below y0 moves down. Used by the swimlane cascade: the backward corridor, the
// GWT lane and every GWT cell all live below the event lane's bottom edge.
function shiftY(blocks, y0, by) {
  let cells = 0, points = 0;
  const out = blocks.map((b) => {
    let s = b;
    const g = geomOf(b);
    if (g && g.y >= y0) { s = setGeom(s, { y: g.y + by }); cells++; }
    s = s.replace(/<mxPoint x="([-\d.]+)" y="([-\d.]+)"/g, (mm, x, y) => {
      if (+y >= y0) { points++; return `<mxPoint x="${x}" y="${+y + by}"`; }
      return mm;
    });
    return s;
  });
  return { blocks: out, cells, points };
}

const setPage = (xml, kv) => {
  let out = xml;
  if (kv.w != null) out = out.replace(/pageWidth="\d+"/, `pageWidth="${kv.w}"`);
  if (kv.h != null) out = out.replace(/pageHeight="\d+"/, `pageHeight="${kv.h}"`);
  return out;
};
const pageH = (xml) => +(/pageHeight="(\d+)"/.exec(xml)?.[1] ?? 0);

// ---------------------------------------------------------------- add

function cmdAdd(target, o) {
  const { file, xml } = read(target);
  const m = model(xml);
  const plan = [];

  if (!PATTERN_CELLS[o.pattern]) {
    die(`unknown pattern "${o.pattern}". One of: ${Object.keys(PATTERN_CELLS).join(", ")}.`);
  }
  if (m.sliceCells.some((c) => c.slice === o.slice)) {
    console.log(`${target}: slice "${o.slice}" already exists — leaving it alone.`);
    return;
  }
  // Slice names are unique across the SYSTEM, not the file: a slice is a branch and a ticket.
  const collision = siblingSlices(file).find((s) => s.name === o.slice);
  if (collision) die(`slice "${o.slice}" already exists in ${collision.where}. Names are unique across the system.`);

  const cols = o.columns ?? DEFAULT_COLS[o.pattern];
  const wants = PATTERN_CELLS[o.pattern];
  const needsBand = wants.some(([k]) => k === "event" || k === "external");

  // Which band the events go in. Positioning by an aggregate the user named is not inventing one;
  // defaulting to the only band there is, is a derivation. Guessing between two is not.
  let band = null;
  if (needsBand) {
    if (!m.swimlanes.length) die(`this model has no swimlane. Add one first: node tools/slice.mjs swimlane ${target} --label ... --streams ...`);
    band = o.aggregate
      ? m.swimlanes.find((s) => (s.streams ?? "").split(",").map((x) => x.trim()).includes(o.aggregate))
      : (m.swimlanes.length === 1 ? m.swimlanes[0] : null);
    if (!band) {
      die(o.aggregate
        ? `no swimlane declares streams="${o.aggregate}". Bands: ${m.swimlanes.map((s) => s.streams).join(" | ")}.`
        : `this model has ${m.swimlanes.length} swimlanes, so --aggregate is required: which stream do these events belong to?`);
    }
  }

  // Where the columns go.
  let x0, mode;
  if (!o.at || o.at === "end") {
    x0 = m.grid.lastCol == null ? m.grid.firstCol : m.grid.lastCol + COL_PITCH;
    mode = "appended";
  } else if (o.at === "start") {
    x0 = m.grid.firstCol; mode = "inserted at position 0";
  } else {
    const [kind, name] = o.at.split(":");
    const t = m.sliceCells.find((c) => c.slice === name);
    if (!t) die(`--at ${o.at}: no slice "${name}" in this model.`);
    const tCols = Math.max(1, Math.round((t.g.w - SLICE_W) / COL_PITCH) + 1);
    if (kind === "before") { x0 = t.g.x + SLICE_PAD; mode = `inserted before ${name}`; }
    else if (kind === "after") { x0 = t.g.x + SLICE_PAD + COL_PITCH * tCols; mode = `inserted after ${name}`; }
    else die(`--at ${o.at}: expected end, start, before:<slice> or after:<slice>.`);
  }

  let blocks = m.blocks;
  const grow = COL_PITCH * cols;
  if (mode !== "appended") {
    const s = shiftX(blocks, x0, grow);
    blocks = s.blocks;
    plan.push(`${s.cells} cell(s) shifted +${grow}, ${s.points} routing point(s) moved`);
  }
  // A model whose columns already reach the lane's right edge needs the lane to grow either way.
  const needW = (x0 - LANE_X) + grow + EL_W + SLICE_PAD;
  if (needW > m.grid.laneW || mode !== "appended") {
    const by = Math.max(grow, needW - m.grid.laneW);
    const w = widen(blocks, by);
    blocks = w.blocks;
    plan.push(`${w.lanes} lane(s)/band(s) widened +${by}`);
  }

  // The cells.
  const sliceH = m.grid.evtBottom - (m.grid.uiY - SLICE_PAD);
  const added = [];
  added.push(box(`slice-${o.slice}`, `${o.slice}\n${o.pattern} · in-design`, "group",
    ` em="group" slice="${o.slice}" pattern="${o.pattern}" status="in-design"`,
    { x: x0 - SLICE_PAD, y: m.grid.uiY - SLICE_PAD, w: SLICE_W + COL_PITCH * (cols - 1), h: sliceH }));

  const rows = new Map();       // events already stacked in one column of one band
  const placed = {};            // id -> geometry, so the edge hints can be chosen from the boxes
  const ids = {};
  // A translation and an automation both put a View AND a processor in their first column, so the
  // Commands/Views lane has to stack them. One cell sits where campaigns.drawio puts it; two split
  // the lane. Three would not fit, and no pattern asks for it.
  const lane = m.lanes["lane-cmd"].g;
  const perCol = new Map();
  for (const [kind, col] of wants) {
    if (kind === "screen" || kind === "event" || kind === "external") continue;
    perCol.set(col, (perCol.get(col) ?? 0) + 1);
  }
  for (const [col, n] of perCol) {
    if (n > 2) die(`pattern "${o.pattern}" wants ${n} lane cells in column ${col}; the lane holds 2.`);
  }
  for (const [kind, col, row] of wants) {
    const id = `${ID_PREFIX[kind]}-${o.slice}`;
    ids[kind] = id;
    const x = x0 + COL_PITCH * col;
    let g, extra = ` em="${kind}" slice="${o.slice}"`;
    if (kind === "screen") {
      g = { x, y: m.grid.uiY + 40, w: EL_W, h: SCREEN_H };
      extra += ` screen="${o.slice}"`;
    } else if (kind === "event" || kind === "external") {
      const r = rows.get(x) ?? 0; rows.set(x, r + 1);
      g = { x, y: band.g.y + BAND_TOP_PAD + BAND_ROW * r, w: EL_W, h: EL_H };
      extra += ` aggregate="${(band.streams ?? "").split(",")[0].trim()}"`;
    } else {
      const n = perCol.get(col) ?? 1;
      // n=1 -> lane.y+50, matching campaigns.drawio. n=2 -> +20 and +100, both clear of the edges.
      g = { x, y: lane.y + 50 - (n - 1) * 30 + row * (EL_H + 20), w: EL_W, h: EL_H };
    }
    placed[id] = g;
    added.push(box(id, `TODO:${kind}`, kind, extra, g));
  }
  // Hints from the two boxes rather than one constant: a lateral hop (processor -> command, one
  // column right at the same height) told to exit downward doglegs through the routing band below.
  for (const [a, b] of PATTERN_EDGES[o.pattern]) {
    if (!ids[a] || !ids[b]) continue;
    const ga = placed[ids[a]], gb = placed[ids[b]];
    added.push(edge(ids[a], ids[b], ga.x !== gb.x && Math.abs(ga.y - gb.y) < 200 ? H_HINTS
      : gb.y < ga.y ? U_HINTS : V_HINTS));
  }

  plan.push(`slice cell + ${wants.length} placeholder cell(s) + ${PATTERN_EDGES[o.pattern].length} edge(s)`);
  const laneW = m.grid.laneW + (mode !== "appended" || needW > m.grid.laneW
    ? Math.max(grow, needW - m.grid.laneW) : 0);
  let out = splice(xml, [...blocks, ...added]);
  out = setPage(out, { w: LANE_X + laneW + PAGE_RIGHT_PAD });
  plan.push(`page width -> ${LANE_X + laneW + PAGE_RIGHT_PAD}`);

  finish(target, file, out, plan, o, [
    `slice "${o.slice}" ${mode}, ${cols} column(s) at x=${x0}`,
    `placeholders are labelled TODO:<kind> and carry no fields= — the model will not validate until`,
    `they are named and filled. That is deliberate: a label is a domain fact.`,
  ]);
}

// One place the folder gets read, so `add` can refuse a name used by a sibling model.
function siblingSlices(file) {
  const dir = file.replace(/[\\/][^\\/]+$/, "");
  const out = [];
  let names = [];
  try { names = execFileSync("node", ["-e",
    `const fs=require('fs');process.stdout.write(fs.readdirSync(${JSON.stringify(dir)}).filter(f=>f.endsWith('.drawio')&&!f.startsWith('_')).join('\\n'))`],
    { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return out; }
  for (const n of names) {
    const p = `${dir}/${n}`;
    if (resolve(p) === resolve(file)) continue;
    let x; try { x = readFileSync(p, "utf8"); } catch { continue; }
    for (const b of x.matchAll(BLOCK_RE)) {
      if (!/\bem="group"/.test(b[0])) continue;
      const s = attr(b[0], "slice");
      if (s) out.push({ name: s, where: n });
    }
  }
  return out;
}

// ---------------------------------------------------------------- swimlane

function cmdSwimlane(target, o) {
  const { file, xml } = read(target);
  const m = model(xml);
  if (!o.label || !o.streams) die("swimlane needs --label and --streams.");
  if (m.swimlanes.some((s) => s.label === o.label)) {
    console.log(`${target}: a band labelled "${o.label}" already exists — leaving it alone.`);
    return;
  }
  const h = o.height ?? (BAND_TOP_PAD + EL_H + BAND_BOT_PAD);   // 95: one row of events
  const last = m.swimlanes[m.swimlanes.length - 1];
  const y = last ? last.g.y + last.g.h + BAND_BOT_PAD : m.grid.evtY + BAND_TOP_PAD;
  const newEvtBottom = y + h + BAND_BOT_PAD;
  const by = Math.max(0, newEvtBottom - m.grid.evtBottom);
  const plan = [];

  let blocks = m.blocks;
  if (by > 0) {
    // Everything below the event lane moves: the backward corridor, the GWT lane, every GWT cell.
    const s = shiftY(blocks, m.grid.evtBottom, by);
    blocks = s.blocks;
    plan.push(`${s.cells} cell(s) below the event lane shifted +${by}, ${s.points} routing point(s) moved`);
    // The event lane grows, and every slice cell ends at its bottom edge, so they grow too.
    blocks = blocks.map((b) => {
      const g = geomOf(b);
      if (!g) return b;
      if (/\bid="lane-evt"/.test(b)) return setGeom(b, { h: g.h + by });
      if (/\bem="group"/.test(b)) return setGeom(b, { h: g.h + by });
      return b;
    });
    plan.push(`event lane +${by}, ${m.sliceCells.length} slice cell(s) grown +${by}`);
  }
  const extra = ` em="lane" streams="${esc(o.streams)}"` + (o.identity ? ` identity="${esc(o.identity)}"` : "");
  const cell = box(`swim-${slug(o.streams.split(",")[0])}`, o.label, "swimlane", extra,
    { x: LANE_X, y, w: m.grid.laneW, h });
  plan.push(`band "${o.label}" at y=${y}, height ${h}`);

  let out = splice(xml, [...blocks, cell]);
  out = setPage(out, { h: pageH(xml) + by });
  finish(target, file, out, plan, o,
    o.identity ? [] : ["no --identity given, so band-needs-identity will fire. Correct: what keys one",
                       "stream is a domain answer, not something a tool may default to the aggregate name."]);
}
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------- route

function cmdRoute(target, o) {
  const { file, xml } = read(target);
  const m = model(xml);
  const from = m.elements.find((e) => e.id === o.from), to = m.elements.find((e) => e.id === o.to);
  if (!from) die(`--from ${o.from}: no such element.`);
  if (!to) die(`--to ${o.to}: no such element.`);
  if (m.edges.some((e) => e.id === `e-${o.from}--${o.to}`)) {
    console.log(`${target}: that edge already exists — leaving it alone.`);
    return;
  }
  const isEvt = (k) => k === "event" || k === "external";
  const backward = to.g.x < from.g.x;

  // Refuse, rather than routing an illegal edge prettily. The fix is reordering columns, and this
  // tool has a command for that: add --at.
  if (backward && !(isEvt(from.em) && to.em === "readmodel")) {
    die(`${from.label} (${from.em}) -> ${to.label} (${to.em}) points backwards, and only Event -> View may.\n` +
        `       That is flow/backward-connection. Reorder the columns instead:\n` +
        `         node tools/slice.mjs add <file> --at before:<slice> ...`);
  }

  let hints, points = null, where;
  if (from.g.x === to.g.x && !isEvt(to.em)) {
    hints = V_HINTS; where = "straight vertical, no allocation";
  } else if (isEvt(from.em) && to.em === "readmodel" && backward) {
    const y = nextY(m, m.grid.evtBottom + 15, 9, m.grid.evtBottom, m.grid.gwtY);
    hints = "exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;";
    points = [{ x: from.g.x + EL_W / 2, y }, { x: to.g.x + EL_W / 2, y }];
    where = `backward corridor y=${y}`;
  } else if (isEvt(from.em) && to.em === "readmodel") {
    const y = nextY(m, m.grid.cmdBottom + 6, 8, m.grid.cmdBottom, m.grid.evtY);
    hints = "exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;";
    points = [{ x: from.g.x + EL_W / 2, y }, { x: to.g.x + EL_W / 2, y }];
    where = `forward routing band y=${y}`;
  } else if (to.em === "screen") {
    const y = nextY(m, m.grid.uiY + 345, 8, m.grid.uiY + 300, m.lanes["lane-cmd"].g.y);
    hints = "exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;";
    points = [{ x: from.g.x + EL_W / 2, y }, { x: to.g.x + EL_W / 2, y }];
    where = `UI routing strip y=${y}`;
  } else {
    hints = V_HINTS; where = "vertical";
  }
  const out = splice(xml, [...m.blocks, edge(o.from, o.to, hints, points)]);
  finish(target, file, out, [`${from.label} -> ${to.label}: ${where}`], o, []);
}

// ---------------------------------------------------------------- identity

function cmdIdentity(target, o) {
  const { file, xml } = read(target);
  const m = model(xml);
  const band = m.swimlanes.find((s) => s.id === o.band || s.label === o.band);
  if (!band) die(`--band ${o.band}: no such swimlane. Bands: ${m.swimlanes.map((s) => s.id).join(", ")}.`);
  const keys = (band.identity ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!keys.length) die(`the "${band.label}" band declares no identity=, so there is nothing to propagate.`);

  // Types come from wherever the name already appears. Two types for one name is
  // event-shape-disagrees waiting to happen, so refuse rather than pick.
  const types = new Map();
  for (const e of m.elements) {
    for (const f of (attr(e.block, "fields") ?? "").split(",")) {
      const [n, t] = f.split(":").map((s) => (s ?? "").trim());
      if (!n || !t) continue;
      if (types.has(n) && types.get(n) !== t) die(`"${n}" appears as both ${types.get(n)} and ${t}. Fix that first.`);
      types.set(n, t);
    }
  }
  const missing = keys.filter((k) => !types.has(k));
  if (missing.length) die(`no element declares a type for ${missing.join(", ")}. Add it once by hand first.`);

  const inBand = new Set(m.elements
    .filter((e) => (e.em === "event") && e.g.y + e.g.h / 2 >= band.g.y && e.g.y + e.g.h / 2 <= band.g.y + band.g.h)
    .map((e) => e.id));
  // A command that emits an event in this band has to supply the key.
  const emitters = new Set(m.edges.filter((e) => inBand.has(e.block.match(/target="([^"]*)"/)?.[1]))
    .map((e) => e.block.match(/source="([^"]*)"/)?.[1]));

  const plan = [];
  const blocks = m.blocks.map((b) => {
    const id = attr(b, "id");
    if (!inBand.has(id) && !emitters.has(id)) return b;
    if (attr(b, "em") !== "event" && attr(b, "em") !== "command") return b;
    const have = (attr(b, "fields") ?? "").split(",").map((s) => s.split(":")[0].trim()).filter(Boolean);
    const add = keys.filter((k) => !have.includes(k));
    if (!add.length) return b;
    const fields = [...(attr(b, "fields") ? [attr(b, "fields")] : []), ...add.map((k) => `${k}:${types.get(k)}`)].join(", ");
    plan.push(`${attr(b, "label")}: +${add.join(", ")}`);
    return setAttr(b, "fields", fields);
  });
  if (!plan.length) { console.log(`${target}: every event and command in "${band.label}" already carries ${keys.join(", ")}.`); return; }
  finish(target, file, splice(xml, blocks), plan, o, []);
}

// ---------------------------------------------------------------- demote

function cmdDemote(target, o) {
  const { file, xml } = read(target);
  const m = model(xml);
  let names = o.slice ?? [];
  const why = new Map();
  if (o.fromDiff) {
    let diff = "";
    try { diff = execFileSync("git", ["diff", "--unified=0", "--", file], { encoding: "utf8" }); }
    catch { die("git diff failed — is this file in a repository?"); }
    const ids = new Set();
    for (const line of diff.split("\n")) {
      if (!/^[+-]/.test(line) || /^[+-]{3}/.test(line)) continue;
      const id = /\bid="([^"]*)"/.exec(line)?.[1];
      if (id) ids.add(id);
    }
    for (const c of m.cells) {
      if (!ids.has(c.id) || !c.slice || c.em === "group") continue;
      if (!names.includes(c.slice)) names.push(c.slice);
      if (!why.has(c.slice)) why.set(c.slice, c.label ?? c.id);
    }
    if (!names.length) { console.log(`${target}: no changed cell belongs to a slice — nothing to demote.`); return; }
  }
  if (!names.length) die("demote needs --slice <name> (repeatable) or --from-diff.");

  const plan = [];
  const blocks = m.blocks.map((b) => {
    if (!/\bem="group"/.test(b)) return b;
    const s = attr(b, "slice");
    if (!names.includes(s) || attr(b, "status") === "in-design") return b;
    plan.push(`${s}: ${attr(b, "status")} -> in-design${why.has(s) ? `  (${why.get(s)} changed)` : ""}`);
    let out = setAttr(b, "status", "in-design");
    return setAttr(out, "label", `${s}\n${attr(b, "pattern")} · in-design`);
  });
  if (!plan.length) { console.log(`${target}: nothing to demote — all named slices are already in-design.`); return; }
  finish(target, file, splice(xml, blocks), plan, o,
    ["Dilger, The Little EventModeling Book ch. 12: \"I treat changes to existing Slices like new",
     "Slices... Also for example Read Models impacted by new Events.\""]);
}

// ---------------------------------------------------------------- reflow

function cmdReflow(target, o) {
  const { file, xml } = read(target);
  const m = model(xml);
  const plan = [];
  const wantLaneW = m.grid.lastCol == null ? m.grid.laneW
    : Math.max(m.grid.laneW, (m.grid.lastCol - LANE_X) + EL_W + SLICE_PAD);
  const last = m.swimlanes[m.swimlanes.length - 1];
  const wantEvtH = last ? (last.g.y + last.g.h + BAND_BOT_PAD) - m.grid.evtY : m.lanes["lane-evt"].g.h;
  const dEvt = wantEvtH - m.lanes["lane-evt"].g.h;
  const sliceY = m.grid.uiY - SLICE_PAD, sliceH = (m.grid.evtBottom + dEvt) - sliceY;
  const lowestGwt = m.gwts.length ? Math.max(...m.gwts.map((g) => g.g.y + g.g.h)) : m.grid.gwtY;

  let blocks = m.blocks;
  if (dEvt) { const s = shiftY(blocks, m.grid.evtBottom, dEvt); blocks = s.blocks; plan.push(`event lane ${m.lanes["lane-evt"].g.h}->${wantEvtH}, ${s.cells} cell(s) below it moved`); }
  blocks = blocks.map((b) => {
    const g = geomOf(b); if (!g) return b;
    if (/\bid="lane-/.test(b) || /\bstreams="/.test(b)) {
      let out = g.w !== wantLaneW ? setGeom(b, { w: wantLaneW }) : b;
      if (/\bid="lane-evt"/.test(b) && dEvt) out = setGeom(out, { h: wantEvtH });
      if (/\bid="lane-gwt"/.test(b)) {
        const wantH = Math.max(g.h, lowestGwt + dEvt + 20 - (g.y + dEvt));
        if (wantH !== g.h) out = setGeom(out, { h: wantH });
      }
      return out;
    }
    if (/\bem="group"/.test(b) && (g.y !== sliceY || g.h !== sliceH)) return setGeom(b, { y: sliceY, h: sliceH });
    return b;
  });
  if (wantLaneW !== m.grid.laneW) plan.push(`lanes ${m.grid.laneW}->${wantLaneW}`);
  const wantPageH = Math.max(pageH(xml) + dEvt, lowestGwt + dEvt + 60);
  let out = splice(xml, blocks);
  out = setPage(out, { w: LANE_X + wantLaneW + PAGE_RIGHT_PAD, h: wantPageH });
  plan.push(`page ${LANE_X + wantLaneW + PAGE_RIGHT_PAD} x ${wantPageH}`);
  if (!plan.length) { console.log(`${target}: geometry already derived — nothing to reflow.`); return; }
  finish(target, file, out, plan, o, []);
}

// ---------------------------------------------------------------- cli

function die(msg) { console.error(`slice: ${msg}`); process.exit(1); }
function finish(target, file, out, plan, o, notes) {
  console.log(`${target}:`);
  for (const p of plan) console.log(`  ${p}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (o.dryRun) { console.log(`  --dry-run: nothing written.`); return; }
  writeFileSync(file, CRLF ? out.replace(/\n/g, "\r\n") : out, "utf8");
}

const argv = process.argv.slice(2);
const cmd = argv.shift(), target = argv.shift();
const o = { slice: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") { o.dryRun = true; continue; }
  if (a === "--from-diff") { o.fromDiff = true; continue; }
  const v = argv[++i];
  if (a === "--slice" && cmd === "demote") o.slice.push(v);
  else if (a === "--slice") o.slice = v;
  else if (a === "--pattern") o.pattern = v;
  else if (a === "--at") o.at = v;
  else if (a === "--columns") o.columns = +v;
  else if (a === "--aggregate") o.aggregate = v;
  else if (a === "--label") o.label = v;
  else if (a === "--streams") o.streams = v;
  else if (a === "--identity") o.identity = v;
  else if (a === "--height") o.height = +v;
  else if (a === "--from") o.from = v;
  else if (a === "--to") o.to = v;
  else if (a === "--band") o.band = v;
  else die(`unknown flag ${a}`);
}
if (!cmd || !target) {
  console.error(readFileSync(new URL(import.meta.url)).toString().split("\n")
    .slice(2, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
const ops = { add: cmdAdd, swimlane: cmdSwimlane, route: cmdRoute, identity: cmdIdentity, demote: cmdDemote, reflow: cmdReflow };
if (!ops[cmd]) die(`unknown command "${cmd}". One of: ${Object.keys(ops).join(", ")}.`);
if (cmd === "add" && (!o.slice || !o.pattern)) die("add needs --slice and --pattern.");
ops[cmd](target, o);
