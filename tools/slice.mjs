#!/usr/bin/env node
// Every geometric consequence of adding a slice to an event model. No domain facts, ever.
//
//   node tools/slice.mjs add      <file> --slice <n> --pattern <p> [--at <spec>] [--columns N] [--aggregate A]
//   node tools/slice.mjs swimlane  <file> --label <text> --streams <A[,B]> [--identity <f[,f]>] [--height N]
//   node tools/slice.mjs actorlane <file> --actor <name> [--kind person|system] [--height N]
//   node tools/slice.mjs chapter  <file> --chapter <slug> --slices <a,b,c> [--then <outcome>] [--layer 1|2]
//   node tools/slice.mjs mark     <file> --slice <n> [--alt <context>] [--external]
//   node tools/slice.mjs route    <file> --from <id> --to <id>
//   node tools/slice.mjs identity <file> --band <id>
//   node tools/slice.mjs demote   <file> [--slice <n>]... | --from-diff
//   node tools/slice.mjs promote  <file> --slice <n>... [--to <status>]
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

const COL_PITCH = 320, EL_W = 180, EL_H = 60;
// A SCREEN IS WIDER AND SHORTER THAN THE OTHER ELEMENTS, and both numbers are for the human eye.
// 300 tall held ~10 stacked wireframe rows; real screens carry five or six, so the rest was dead white
// space repeated down every actor lane. 240 still holds eight. The extra 20px of width is the slack
// already inside the 220-wide slice band, so nothing else has to move; SCREEN_X_NUDGE re-centres the
// screen on the column so it stays on the same axis as the command beneath it.
// tools/wireframe.mjs KEEPS ITS OWN COPY OF SCREEN_H and resizes screens to it — the two must agree or
// they fight, one growing what the other shrank.
const SCREEN_H = 240, SCREEN_W = 200, SCREEN_X_NUDGE = (SCREEN_W - EL_W) / 2;
const SLICE_W = 220, SLICE_PAD = 20;          // band is the column minus 20 either side
const LANE_X = 40, PAGE_RIGHT_PAD = 60;
const BAND_TOP_PAD = 25, BAND_ROW = 75, BAND_BOT_PAD = 10;
const GWT_W = 300, GWT_H = 120, GWT_PITCH = 140, GWT_TOP = 30;
// Actor bands subdivide the UI lane. ACTOR_TOP + SCREEN_H + padding is sized so the FIRST band contains
// the screens `add` already places at uiY + 40, and UI_STRIP_H reserves the View -> Screen routing strip
// that must stay below every band.
const ACTOR_TOP = 25, ACTOR_PAD = 20, ACTOR_GAP = 10, UI_STRIP_H = 45;
// A chapter bar: short, because it carries a name and a span and nothing else. Two rows fit in the
// strip above the timeline, for the book's chapters and sub-chapters.
const CHAPTER_H = 34, CHAPTER_GAP = 8, CHAPTER_TOP_PAD = 12;
// The clear space between one model on a board and the next. Big enough to read as a break, and it is
// NOT load-bearing: shiftY carries every lower region down when an upper one grows, so the gutter can
// never be eaten (step 3 measured a 14x overrun with it intact).
const REGION_GUTTER = 400;
const TEMPLATE = new URL("../templates/template.drawio", import.meta.url);

const STYLE = {
  screen:     "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#666666;verticalAlign=top;spacingTop=6;fontSize=12;",
  command:    "rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=12;",
  event:      "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=12;",
  external:   "rounded=0;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=12;",
  readmodel:  "rounded=0;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=12;",
  automation: "rounded=0;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=12;",
  gwt:        "rounded=0;whiteSpace=wrap;html=1;fillColor=#f0f0f0;strokeColor=#999999;fontSize=11;align=left;spacingLeft=8;verticalAlign=top;spacingTop=6;",
  group:      "rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#b85450;dashed=1;verticalAlign=top;align=center;spacingTop=4;fontStyle=1;fontColor=#b85450;fontSize=11;",
  // BLUE, because the book says blue: "I use blue arrows and arrange them in two layers." Drawn as a
  // bar rather than a literal arrow -- the span is the information, and an arrowhead would imply a
  // direction a structural chapter does not have.
  chapter:    "rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;verticalAlign=middle;align=left;spacingLeft=12;fontStyle=1;fontColor=#3f5f8f;fontSize=12;",
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
// READ THE KEYS AND THE VALUES DIFFERENTLY: a key is a PATTERN, a value names ELEMENT KINDS. They used to
// share the words `command` and `view`, so `command: [... ["command", 0, 0] ...]` had two unrelated meanings
// on one line. The patterns are now the books' own terms, `state-change` and `state-view`; the element kinds
// are untouched, because a blue Command cell is still kind="command".
const PATTERN_CELLS = {
  "state-change": [["screen", 0, 0], ["command", 0, 0], ["event", 0, 0]],
  "state-view":   [["readmodel", 0, 0]],
  automation:     [["automation", 0, 0], ["readmodel", 0, 1], ["command", 1, 0], ["event", 1, 0]],
  translation:    [["external", 0, 0], ["automation", 0, 0], ["readmodel", 0, 1],
                   ["command", 1, 0], ["event", 1, 0]],
  upstream:       [["external", 0, 0]],
};
// Only the edges the PATTERN determines. Which existing events feed a view is a domain answer and
// belongs to `route`, with ids the user supplied.
const PATTERN_EDGES = {
  "state-change": [["screen", "command"], ["command", "event"]],
  "state-view":   [],
  automation:     [["readmodel", "automation"], ["automation", "command"], ["command", "event"]],
  translation:    [["external", "readmodel"], ["readmodel", "automation"], ["automation", "command"], ["command", "event"]],
  upstream:       [],
};
const DEFAULT_COLS = { "state-change": 1, "state-view": 1, upstream: 1, automation: 2, translation: 2 };

// ---------------------------------------------------------------- text plumbing

// THE PARSER IS model.mjs's, SHARED — tools/drawio-xml.mjs, KIT-FINDINGS V23. This file used to carry
// its own, anchored on 8-space indentation, and since every write rewrites the whole <root> from what
// it matched, a cell it missed was DELETED rather than merely unparsed. The shared one is tolerant and
// LOSSLESS: each cell carries its exact source span, so an untouched cell still comes back
// byte-identical and the diff stays reviewable.
import { parseBlocks, isRootCell, unescapeXml as unesc, escapeAttr as esc } from "./drawio-xml.mjs";

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
// Every modelled cell's exact source span, in document order — draw.io's own id 0 / id 1 excluded,
// because splice() re-emits those itself.
const cellBlocks = (xml) => parseBlocks(xml).filter((b) => !isRootCell(b)).map((b) => b.raw);

// THE TRIPWIRE. Every write rewrites the whole <root> from `blocks`, so a cell the parser does not
// return is not merely unparsed — it is DELETED, with no error and no diff anybody reads.
//
// Since the parser became shared (tools/drawio-xml.mjs, KIT-FINDINGS V23) this SHOULD be unreachable:
// the reader and the writer now disagree about nothing, and indentation is free. It is kept precisely
// because it can no longer fire — a guard that costs one pass and never triggers is the cheapest way
// to find out if the split ever comes back, whether by a new tool growing its own regex or by this one
// drifting. It stays live rather than becoming a comment, because a comment does not fail a build.
//
// What it caught the first time: a board fixture whose model cells sat at column 0 lost BOTH of them
// to a `promote`, which does not touch geometry at all. `validate` read the wreckage and was happy.
function assertNothingDropped(xml, blocks) {
  const inner = /<root>([\s\S]*?)<\/root>/.exec(xml)?.[1] ?? "";
  let residue = inner;
  for (const b of blocks) residue = residue.split(b).join("");
  const orphans = (residue.match(/<(?:object|mxCell)\b[^>]*/g) ?? [])
    .filter((o) => !/\bid="[01]"/.test(o));
  if (!orphans.length) return;
  die(`${orphans.length} cell(s) in this file cannot be parsed, and a write rewrites <root> from the\n` +
      `       cells that can — so writing would silently DELETE them:\n` +
      orphans.slice(0, 3).map((o) => `         ${o.slice(0, 96)}`).join("\n") +
      `\n       Indentation is not the cause — the parser is shared and tolerant (KIT-FINDINGS V23).\n` +
      `       Look for a malformed cell: an unclosed <object>, or a tag draw.io did not write.`);
}

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
// REPLACE-OR-APPEND, AND ONLY EVER WITHIN THE OPENING TAG — KIT-FINDINGS V25.
//
// The old version tested `\bk="..."` against the WHOLE block, opening tag and inner <mxCell> and
// <mxGeometry> together, then replaced the first match anywhere in it. Two ways that writes a cell it
// did not mean to, and one way it writes nothing at all: a name that also occurs inside the inner cell
// wins the match, and a near-miss on the test sends it down the append branch — producing a SECOND
// copy of the attribute. `attrsOf` lets the LAST occurrence win, so the original value keeps winning
// and the write is a silent no-op. Measured: a rename pass appended a second `label=` to 15 cells;
// all 15 looked renamed in the diff and none were.
//
// So: scope to the opening tag, delete EVERY existing occurrence, and write exactly one. Position is
// preserved — first occurrence in place, otherwise at the front — because changing attribute order
// would rewrite every model this tool has ever touched.
//
// It escapes its own value: pass a raw string, never a pre-escaped one, or `&#10;` becomes `&amp;#10;`
// and a two-line label renders as one.
const setAttr = (b, k, v) => {
  const m = /^(\s*<(?:object|mxCell)\b)([^>]*?)(\/?>)/.exec(b);
  if (!m) return b;
  const [whole, open, attrs, close] = m;
  const one = new RegExp(`\\s${k}="[^"]*"`);
  let out;
  if (one.test(attrs)) {
    let first = true;
    out = attrs.replace(new RegExp(`\\s${k}="[^"]*"`, "g"),
      () => (first ? ((first = false), ` ${k}="${esc(v)}"`) : ""));
  } else {
    out = ` ${k}="${esc(v)}"${attrs}`;
  }
  return b.replace(whole, () => `${open}${out}${close}`);
};

// THE TRIPWIRE FOR V25, modelled on assertNothingDropped (V23) for the same reason: this is the second
// silent write-failure in this file, so the fix has to make the CLASS detectable rather than repair the
// instance. A duplicate attribute is never legitimate — draw.io does not emit one, and the only way to
// get one is a writer that appended where it meant to replace.
//
// Runs on the way OUT, on the bytes about to be written, so it catches any producer of the string and
// not just setAttr. Costs one pass over the file and should never fire again.
function assertNoDuplicateAttrs(xml) {
  const bad = [];
  for (const b of parseBlocks(xml)) {
    const seen = new Set(), dup = new Set();
    for (const [, k] of b.head.matchAll(/\s([\w-]+)="/g)) {
      if (seen.has(k)) dup.add(k); else seen.add(k);
    }
    if (dup.size) bad.push(`${b.attrs.id ?? "(no id)"}: ${[...dup].join(", ")}`);
  }
  if (!bad.length) return;
  die(`${bad.length} cell(s) would be written with a DUPLICATE attribute, where the last copy wins and\n` +
      `       the write silently does nothing (KIT-FINDINGS V25):\n` +
      bad.slice(0, 5).map((x) => `         ${x}`).join("\n") +
      `\n       Nothing has been written. This is a bug in whatever produced the cell, not in the model.`);
}

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

// ---------------------------------------------------------------- regions
//
// A BOARD HOLDS MANY MODELS, and the partition is model.mjs's — deliberately re-derived here from the
// same rule rather than invented, because two copies of a rule are two rules (KIT-FINDINGS V9). Model
// cells are anchors sorted by y; a region runs from one anchor to the next, the FIRST unbounded above
// and the LAST unbounded below, and a cell joins the region containing its MIDPOINT.
//
// The totality that buys is the same one step 2 relies on: no gutter belongs to nobody, so no cell can
// be dropped by a write, and ONE MODEL CELL (OR NONE) YIELDS ONE REGION SPANNING EVERYTHING — which is
// exactly what a whole file meant before boards existed. Every one-model write is untouched by all of
// this, and that is a property of the arithmetic rather than of the tests.
function regionsOf(cells) {
  const anchors = cells.filter((c) => c.em === "model" && c.g).sort((a, b) => a.g.y - b.g.y);
  if (!anchors.length) return [{ anchor: null, context: null, top: -Infinity, bottom: Infinity, index: 0 }];
  return anchors.map((a, i) => ({
    anchor: a,
    context: attr(a.block, "context"),
    top: i === 0 ? -Infinity : a.g.y,
    bottom: i === anchors.length - 1 ? Infinity : anchors[i + 1].g.y,
    index: i,
  }));
}
const inRegion = (c, r) => {
  if (!c.g) return r.index === 0;                 // undecidable: the first region, as before regions
  const mid = c.g.y + c.g.h / 2;
  return mid >= r.top && mid < r.bottom;
};

// A cheap unscoped pass, only to answer "which regions are there and what is in them".
function regionsIn(xml) {
  const cells = cellBlocks(xml).map((b) => ({
    block: b, id: attr(b, "id"), em: attr(b, "em"), slice: attr(b, "slice"),
    label: attr(b, "label") ?? attr(b, "value"),
    streams: attr(b, "streams"), actor: attr(b, "actor"), g: geomOf(b),
  }));
  return { cells, regions: regionsOf(cells) };
}

// WHICH MODEL DOES THIS WRITE GO TO?
//
// The rule is the one cmdAdd already applies to swimlanes and actor lanes, one level up: "defaulting
// to the only band there is is a derivation. Guessing between two is not." So:
//
//   one region   -> that region, no flag, ever. This is the whole one-model compatibility story, and
//                   it is arithmetic rather than a special case.
//   many regions -> infer from what the command ALREADY names — an aggregate, a slice, a cell id —
//                   because that fact is on the canvas and repeating it in a flag would be a second
//                   place for it to live. `--model` overrides. Otherwise refuse, naming the models.
//
// A command whose inference lands in TWO regions is refused rather than resolved: that is a
// cross-model write, which is steps 5-7, not this one.
// "Does this already exist ANYWHERE in the file?" — asked before a region is resolved, so an
// idempotent re-run never has to name one. File-wide is also the correct scope for a slice name,
// which is a branch and a ticket and unique across the system.
const existingSlice = (xml, name) =>
  regionsIn(xml).cells.some((c) => c.em === "group" && c.slice === name);
const existingBand = (xml, pred) => regionsIn(xml).cells.some(pred);

function pickRegion(xml, o, infer = [], hint = "") {
  const { cells, regions } = regionsIn(xml);
  if (regions.length === 1) return regions[0];
  const name = (r) => r.context ?? `#${r.index + 1}`;
  const all = regions.map(name).join(", ");

  if (o.model) {
    const r = regions.find((x) => x.context === o.model);
    if (!r) die(`--model "${o.model}": this board holds ${all}.`);
    return r;
  }
  for (const { pred, what } of infer) {
    const hit = cells.filter(pred);
    if (!hit.length) continue;
    const idx = [...new Set(hit.map((c) => regions.findIndex((r) => inRegion(c, r))))].filter((i) => i >= 0);
    if (idx.length === 1) return regions[idx[0]];
    if (idx.length > 1) {
      die(`${what} names cells in ${idx.length} models (${idx.map((i) => name(regions[i])).join(", ")}).\n` +
          `       One write goes to one model. A cross-model story is a chapter, which this kit cannot draw yet.`);
    }
  }
  die(`this file is a board of ${regions.length} models (${all}), and nothing in this command says which.\n` +
      (hint ? `       ${hint}\n` : "") + `       Add --model <context>.`);
}

function model(xml, want) {
  const blocks = cellBlocks(xml);
  const at = (b) => ({
    block: b, id: attr(b, "id"), em: attr(b, "em"), slice: attr(b, "slice"),
    label: attr(b, "label") ?? attr(b, "value"), g: geomOf(b),
    streams: attr(b, "streams"), identity: attr(b, "identity"),
    actor: attr(b, "actor"),
    isEdge: /\bedge="1"/.test(b),
  });
  assertNothingDropped(xml, blocks);
  const allCells = blocks.map(at);
  const regions = regionsOf(allCells);
  // `want` is resolved by the caller (see pickRegion) and is always a region of THIS file. With one
  // region it is region 0 and this filter is the identity.
  const region = want ?? regions[0];
  const cells = regions.length === 1 ? allCells : allCells.filter((c) => inRegion(c, region));

  // streams= is what makes a cell a swimlane, not em=. buildIr selects on n.streams and then
  // subtracts those from `lanes`; get this wrong and every event looks misplaced.
  const swimlanes = cells.filter((c) => c.streams).sort((a, b) => a.g.y - b.g.y);
  // Actor bands, top to bottom. Discriminated by actor= exactly as a stream band is by streams=, and
  // kept out of `lanes` for the same reason: a band authored as an object would otherwise be found
  // ahead of the lane-ui containing it.
  const actorLanes = cells.filter((c) => c.actor && !c.streams).sort((a, b) => a.g.y - b.g.y);
  // LANES ARE FOUND BY ROLE, NOT BY EXACT ID. Two models on one canvas cannot both own the id
  // `lane-ui`, so a board namespaces them (`cart-lane-ui`) — and matching on the SUFFIX keys them by
  // the role the rest of this file already asks for. An unprefixed `lane-ui` matches the same rule, so
  // a one-model file resolves exactly as before.
  const lanes = {};
  for (const c of cells) {
    if (c.streams || !c.id) continue;
    const role = LANE_ID_RE.exec(c.id);
    if (role) lanes[role[1]] = c;
  }
  const sliceCells = cells.filter((c) => c.em === "group" && c.slice);
  const elements = cells.filter((c) =>
    !c.isEdge && !c.streams && c.g && !LANE_ID_RE.test(c.id) &&
    c.em !== "group" && c.em !== "model" && c.em !== "gwt");
  const gwts = cells.filter((c) => c.em === "gwt");
  const edges = cells.filter((c) => c.isEdge);

  for (const k of ["lane-ui", "lane-cmd", "lane-evt", "lane-gwt"]) {
    if (!lanes[k]) {
      die(regions.length > 1
        ? `model "${region.context ?? region.index}" has no ${k}. Every region of a board needs its own lane set.`
        : `the model has no ${k}. Start from diagrams/template.drawio.`);
    }
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
  return { blocks, cells, allCells, regions, region, lanes, swimlanes, actorLanes,
           sliceCells, elements, gwts, edges, grid,
           // Slice names are unique across the SYSTEM, so a collision check must see every region of
           // this file, not just the one being written to.
           allSliceCells: allCells.filter((c) => c.em === "group" && c.slice) };
}

// A lane by ROLE, tolerating the namespace a board needs: `lane-ui` and `cart-lane-ui` both match and
// both key as `lane-ui`. Used for the id on a parsed cell and, in the block-level transforms below,
// for the raw `id="..."` text.
const LANE_ID_RE = /(?:^|-)(lane-[a-z]+)$/;
const laneBlockRe = (role = "[a-z]+") => new RegExp(`\\bid="(?:[^"]*-)?lane-${role}"`);
const isLaneBlock = (b) => laneBlockRe().test(b);

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

// The same tolerance the parser now has, applied to the wrapper: `</root>` at any indentation, and
// trailing spaces after `<root>`. A file that failed the old pattern was not rejected — `replace`
// returned the string unchanged, so the write SILENTLY DID NOTHING and reported success. Refusing is
// the only honest option, and it is the same rule as assertNothingDropped.
//
// The replacement is a FUNCTION, not a string: cell text routinely contains `$` (a GWT's `$SeedName`
// example data), and `$&`, `$'` or `$\`` in a string replacement would be substituted rather than
// written. No current model trips it; the function form means none ever can.
function splice(xml, blocks) {
  const re = /(<root>[ \t]*\r?\n)([\s\S]*?)([ \t]*<\/root>)/;
  if (!re.test(xml)) die("no <root> ... </root> here that this tool can rewrite.");
  return xml.replace(re, (_, open, __, close) =>
    `${open}        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n${blocks.join("")}${close}`);
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
// HORIZONTAL GROWTH IS PRIVATE TO A REGION, and that asymmetry with shiftY below is the whole of the
// board's geometry story. Regions partition by Y, so they all share the full X range: shifting x
// globally would drag every OTHER model sideways for a column this one gained. A board is simply as
// wide as its widest region, and each region keeps its own column grid.
//
// `keep` is the region filter — the identity on a one-model file, so nothing about that case changes.
function shiftX(blocks, x0, by, keep = () => true) {
  let cells = 0, points = 0;
  const out = blocks.map((b) => {
    if (!keep(b)) return b;
    let s = b;
    const g = geomOf(b);
    if (g && g.x >= x0 - SLICE_PAD && !isLaneBlock(b) && !/\bstreams="/.test(b)) {
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

// Widen this region's lanes and swimlanes, and the page with them. Region-scoped for the same reason
// as shiftX: another model's lanes are not this model's business.
function widen(blocks, by, keep = () => true) {
  let n = 0;
  const out = blocks.map((b) => {
    if (!keep(b)) return b;
    if (!isLaneBlock(b) && !/\bstreams="/.test(b)) return b;
    const g = geomOf(b);
    if (!g) return b;
    n++;
    return setGeom(b, { w: g.w + by });
  });
  return { blocks: out, lanes: n };
}

// A block-level region filter built from the parsed region. On a one-model file every block passes,
// so `shiftX(blocks, x, by, within(m))` is byte-for-byte the old `shiftX(blocks, x, by)`.
const within = (m) => {
  if (m.regions.length === 1) return () => true;
  const mine = new Set(m.cells.map((c) => c.block));
  return (b) => mine.has(b);
};

// Everything at or below y0 moves down. Used by the swimlane cascade: the backward corridor, the
// GWT lane and every GWT cell all live below the event lane's bottom edge.
//
// DELIBERATELY GLOBAL, AND ON A BOARD THAT IS THE CORRECT BEHAVIOUR RATHER THAN AN OVERSIGHT — it is
// the exact mirror of shiftX above. Regions partition by Y, so a region growing downward MUST carry
// every region below it, or it grows straight into the next one. And because the shift is rigid — the
// same `by` for every block at or below y0, including the next model's anchor cell — the distance
// between consecutive anchors never changes. The anchors ARE the region boundaries, so no cell can be
// reassigned to another model by a write. That is arithmetic, not a test result.
//
// The other direction is safe for free: a lower region growing cannot disturb an upper one, because
// every y in the upper region is less than the lower region's y0.
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

// THE PAGE BELONGS TO THE BOARD, NOT TO A REGION. A region-scoped width would let the last model
// written shrink the page below what a wider sibling needs. Measured off every block instead, which
// on a one-model file is the same number the per-region arithmetic produced.
const boardWidth = (blocks) => {
  let right = 0;
  for (const b of blocks) {
    const g = geomOf(b);
    if (g) right = Math.max(right, g.x + g.w);
  }
  return right ? right + PAGE_RIGHT_PAD : null;
};

// ---------------------------------------------------------------- add

function cmdAdd(target, o) {
  const { file, xml } = read(target);
  if (!PATTERN_CELLS[o.pattern]) {
    die(`unknown pattern "${o.pattern}". One of: ${Object.keys(PATTERN_CELLS).join(", ")}.`);
  }
  // IDEMPOTENCE COMES BEFORE DISAMBIGUATION, and getting that order wrong is a real trap: a re-run of
  // an `add` for a slice that already exists is a NO-OP, so demanding --model first would make the
  // safest possible call the one that fails. Found by cart-replay's idempotency check, which re-runs
  // every command with its original arguments — exactly what a caller retrying a script does.
  if (existingSlice(xml, o.slice)) {
    console.log(`${target}: slice "${o.slice}" already exists — leaving it alone.`);
    return;
  }
  // Every one of these facts is already on the canvas in exactly one model, so naming it again with
  // --model would be a second place for it to live.
  const atName = o.at && /^(before|after):/.test(o.at) ? o.at.split(":")[1] : null;
  const m = model(xml, pickRegion(xml, o, [
    atName && { what: `--at ${o.at}`, pred: (c) => c.em === "group" && c.slice === atName },
    o.aggregate && { what: `--aggregate ${o.aggregate}`,
      pred: (c) => c.streams?.split(",").map((s) => s.trim()).includes(o.aggregate) },
    o.actor && { what: `--actor ${o.actor}`,
      pred: (c) => c.actor && !c.streams && c.actor.trim() === o.actor },
  ].filter(Boolean),
    "--aggregate names a stream, and the swimlane declaring it already sits in one model."));
  const plan = [];
  // Slice names are unique across the SYSTEM, not the file: a slice is a branch and a ticket.
  const collision = siblingSlices(file).find((s) => s.name === o.slice);
  if (collision) die(`slice "${o.slice}" already exists in ${collision.where}. Names are unique across the system.`);

  const cols = o.columns ?? DEFAULT_COLS[o.pattern];
  const wants = PATTERN_CELLS[o.pattern];
  const needsBand = wants.some(([k]) => k === "event" || k === "external");

  // Which ACTOR band the screen goes in. Same rule as the stream band above: naming one is not
  // inventing it, defaulting to the only band there is is a derivation, and guessing between two is
  // not. A model with no actor lanes drawn keeps the old single-position behaviour entirely.
  const needsActor = wants.some(([k]) => k === "screen");
  let actorBand = null;
  if (needsActor && m.actorLanes.length) {
    actorBand = o.actor
      ? m.actorLanes.find((a) => (a.actor ?? "").trim() === o.actor)
      : (m.actorLanes.length === 1 ? m.actorLanes[0] : null);
    if (!actorBand) {
      die(o.actor
        ? `no actor lane for "${o.actor}". Lanes: ${m.actorLanes.map((a) => a.actor).join(" | ")}.`
        : `this model has ${m.actorLanes.length} actor lanes, so --actor is required: who uses this screen?`);
    }
  }

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

  // WHERE THE IMPORTED EVENT GOES, WHICH IS NOT WHERE OUR OWN EVENTS GO — KIT-FINDINGS V26.
  //
  // A translation's external is another system's event. Dropped into a band we write to, it says that
  // event lands in a stream of OURS — which `external-in-written-band` then correctly warns about. So
  // the tool was manufacturing the warning it ships with, and every translation slice needed a hand
  // move immediately after creation. Step 6 makes translation slices routine, so that hand move became
  // a step in a repeated recipe.
  //
  // A FOREIGN BAND is one holding no events we write. Prefer an existing one, let --band name it
  // explicitly, and fall back to the ordinary band when the model has none — which leaves a
  // single-band model behaving exactly as before, warning and all. That fallback is deliberate:
  // creating a band here would invent a stream boundary, and what keys a stream is a domain answer.
  let extBand = band;
  if (needsBand && wants.some(([k]) => k === "external")) {
    const inBand = (e, b) => e.g && b.g && e.g.y + e.g.h / 2 >= b.g.y && e.g.y + e.g.h / 2 <= b.g.y + b.g.h;
    const writesInto = (b) => m.elements.some((e) => e.em === "event" && inBand(e, b));
    if (o.band) {
      extBand = m.swimlanes.find((s) => s.id === o.band || s.label === o.band ||
        (s.streams ?? "").split(",").map((x) => x.trim()).includes(o.band));
      if (!extBand) {
        die(`--band "${o.band}": no such swimlane. Bands: ${m.swimlanes.map((s) => s.label).join(" | ")}.`);
      }
    } else {
      extBand = m.swimlanes.find((s) => !writesInto(s)) ?? band;
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
  const mine = within(m);
  if (mode !== "appended") {
    const s = shiftX(blocks, x0, grow, mine);
    blocks = s.blocks;
    plan.push(`${s.cells} cell(s) shifted +${grow}, ${s.points} routing point(s) moved`);
  }
  // A model whose columns already reach the lane's right edge needs the lane to grow either way.
  const needW = (x0 - LANE_X) + grow + EL_W + SLICE_PAD;
  if (needW > m.grid.laneW || mode !== "appended") {
    const by = Math.max(grow, needW - m.grid.laneW);
    const w = widen(blocks, by, mine);
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
      // A SCREEN'S Y IS ITS ACTOR, exactly as an event's y is its stream — so `--actor` places it the
      // same way `--aggregate` places an event, and for the same reason: the user supplies the domain
      // fact, the tool supplies the geometry. Without actor lanes drawn, the old default stands.
      g = { x: x - SCREEN_X_NUDGE, y: actorBand ? actorBand.g.y + ACTOR_PAD : m.grid.uiY + 40, w: SCREEN_W, h: SCREEN_H };
      extra += ` screen="${o.slice}"`;
    } else if (kind === "event" || kind === "external") {
      // An external goes in the FOREIGN band (V26); our own events go in the band --aggregate named.
      // Rows are counted per band, so a stack in one does not push the other down.
      const home = kind === "external" ? extBand : band;
      const key = `${home.id}@${x}`;
      const r = rows.get(key) ?? 0; rows.set(key, r + 1);
      g = { x, y: home.g.y + BAND_TOP_PAD + BAND_ROW * r, w: EL_W, h: EL_H };
      extra += ` aggregate="${(home.streams ?? "").split(",")[0].trim()}"`;
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
  // THE PAGE BELONGS TO THE BOARD. This region's own requirement is computed exactly as before — the
  // formula is unchanged, so a one-model file gets the same number to the pixel — and is then held
  // against what the OTHER regions already occupy, so a narrow model written last cannot crop a wide
  // sibling. With one region there are no others and the max is a no-op.
  const pw = Math.max(LANE_X + laneW + PAGE_RIGHT_PAD, boardWidth(blocks.filter((b) => !mine(b))) ?? 0);
  out = setPage(out, { w: pw });
  plan.push(`page width -> ${pw}`);

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
    for (const b of cellBlocks(x)) {
      if (!/\bem="group"/.test(b)) continue;
      const s = attr(b, "slice");
      if (s) out.push({ name: s, where: n });
    }
  }
  return out;
}

// ---------------------------------------------------------------- model (a new region)
//
// "It is perfectly fine to have more than one model on a board. In fact, this is the rule rather than
// the exception for me." — Understanding EventSourcing, ch. 18
//
// Step 2 taught the reader to see many models on one canvas and step 3 taught the writers to work in
// one of them; nothing could CREATE one, so a board could only ever be made outside the kit. This is
// that command, and it is the symmetric twin of `swimlane` and `actorlane`: it grows the board
// downward, below everything already drawn.
//
// A NEW REGION IS A FRESH TEMPLATE, PLACED UNDER THE LAST ONE — read from templates/template.drawio
// rather than reproduced from constants here, so a new region on a board and a new one-model file stay
// the same thing by construction. It brings no swimlane: what keys a stream is a domain answer, so
// `swimlane` is a separate, deliberate call exactly as it is for a fresh file.
function cmdModel(target, o) {
  const { file, xml } = read(target);
  const ctx = o.context;
  if (!ctx) die("model needs --context <name>: the business context this region captures.");
  const { cells, regions } = regionsIn(xml);
  if (regions.some((r) => r.context === ctx)) {
    console.log(`${target}: a model for context "${ctx}" already exists — leaving it alone.`);
    return;
  }

  // Below EVERYTHING, not below the last anchor: the last region's GWT band and journey bars are the
  // real floor, and a region that starts above them would overlap the model it follows.
  const bottom = Math.max(0, ...cells.map((c) => (c.g ? c.g.y + c.g.h : 0)));
  const top = bottom + REGION_GUTTER;

  const tpl = readFileSync(TEMPLATE, "utf8").replace(/\r\n/g, "\n");
  const want = ["model-rename", "lane-ui", "lane-cmd", "lane-evt", "lane-gwt"];
  const picked = parseBlocks(tpl).filter((b) => want.includes(b.attrs.id));
  if (picked.length !== want.length) {
    die(`templates/template.drawio is missing ${want.filter((w) => !picked.some((p) => p.attrs.id === w)).join(", ")}.`);
  }
  const anchorY = geomOf(picked.find((b) => b.attrs.id === "model-rename").raw).y;
  const dy = top - anchorY;
  const slugged = slug(ctx);

  const blocks = picked.map((b) => {
    let s = b.raw;
    const g = geomOf(s);
    if (g) s = setGeom(s, { y: g.y + dy });
    // Two models on one canvas cannot share an id. The lane suffix is what LANE_ID_RE keys on, so a
    // prefixed lane still resolves by role.
    const id = b.attrs.id === "model-rename" ? `model-${slugged}` : `${slugged}-${b.attrs.id}`;
    s = s.replace(/\bid="[^"]*"/, `id="${id}"`);
    if (b.attrs.id === "model-rename") {
      s = setAttr(s, "label", o.label ?? `${ctx}\n${ctx} · context`);
      s = setAttr(s, "context", ctx);
      if (o.system) s = setAttr(s, "system", o.system);
    }
    return s;
  });

  const laneBottom = Math.max(...blocks.map((b) => { const g = geomOf(b); return g ? g.y + g.h : 0; }));
  let out = splice(xml, [...cellBlocks(xml), ...blocks]);
  out = setPage(out, { h: Math.max(pageH(xml), laneBottom + 60) });
  finish(target, file, out, [
    `model "${ctx}" as region ${regions.length + 1}, at y=${top} (${REGION_GUTTER}px below the last model)`,
    `4 lane(s) + 1 model cell`,
  ], o, [
    `no swimlane: what keys a stream is a domain answer, so add one before any event —`,
    `  node tools/slice.mjs swimlane ${target} --label ... --streams ... --model ${ctx}`,
  ]);
}

// ---------------------------------------------------------------- actorlane
//
// The ORIGINAL definition's swimlane, and a different animal from the stream bands below. Dymitruk §3:
// "The wireframes are generally put at the top of the blueprint. They can be divided into separate
// swimlanes to show what each user sees if there is more than one." So an actor band subdivides the UI
// lane, never the whole model — which is also the only reading that does not collide with the stream
// bands already inside lane-evt.
//
// A band is tall enough to hold a screen and nothing else. THE FIRST BAND IS PLACED TO CONTAIN THE
// SCREENS THAT ARE ALREADY THERE (`add` puts them at uiY + 40, height 300), so adopting an existing
// single-actor model costs no cell moves — you draw one lane and everything is already inside it. Later
// bands are for screens that do not exist yet.
function cmdActorLane(target, o) {
  const { file, xml } = read(target);
  if (!o.actor) die("actorlane needs --actor.");
  // NOTHING TO INFER FROM: a new actor lane names somebody who is on no cell yet, so on a board this
  // is one of the two commands that genuinely needs --model. Saying so beats guessing.
  const m = model(xml, pickRegion(xml, o, [],
    "A new actor lane names an actor who is not on the board yet, so there is nothing to infer from."));
  if (o.kind && !["person", "system"].includes(o.kind)) {
    die(`--kind must be person or system. An actor lane is a person OR A SYSTEM — never a role: roles are an implementation detail both books refuse.`);
  }
  // Idempotence before disambiguation — see cmdAdd.
  if (existingBand(xml, (c) => c.actor && !c.streams && c.actor === o.actor)) {
    console.log(`${target}: an actor lane for "${o.actor}" already exists — leaving it alone.`);
    return;
  }
  const existing = m.actorLanes ?? [];
  if (existing.some((a) => a.actor === o.actor)) {
    console.log(`${target}: an actor lane for "${o.actor}" already exists — leaving it alone.`);
    return;
  }
  const h = o.height ?? (ACTOR_PAD + SCREEN_H + ACTOR_PAD);
  const last = existing[existing.length - 1];
  const y = last ? last.g.y + last.g.h + ACTOR_GAP : m.grid.uiY + ACTOR_TOP;

  // The UI lane must still hold the View -> Screen routing strip UNDER the last band, so it grows by
  // whatever the new band pushes past the current bottom. Everything below lane-ui then shifts: the
  // command lane, the event lane and its swimlanes, the GWT lane, every cell and every routing point.
  const wantUiBottom = y + h + ACTOR_GAP + UI_STRIP_H;
  const uiBottom = m.grid.uiY + m.lanes["lane-ui"].g.h;
  const by = Math.max(0, wantUiBottom - uiBottom);
  const plan = [];

  let blocks = m.blocks;
  if (by > 0) {
    const s = shiftY(blocks, uiBottom, by);
    blocks = s.blocks;
    plan.push(`${s.cells} cell(s) below the UI lane shifted +${by}, ${s.points} routing point(s) moved`);
    blocks = blocks.map((b) => {
      const g = geomOf(b);
      if (!g) return b;
      if (laneBlockRe("ui").test(b)) return setGeom(b, { h: g.h + by });
      if (/\bem="group"/.test(b)) return setGeom(b, { h: g.h + by });   // slice cells span every lane
      return b;
    });
    plan.push(`UI lane +${by}, ${m.sliceCells.length} slice cell(s) grown +${by}`);
  }

  const extra = ` em="lane" actor="${esc(o.actor)}"` + (o.kind ? ` actorKind="${o.kind}"` : "");
  const cell = box(`actor-${slug(o.actor)}`, o.actor, "swimlane", extra,
    { x: LANE_X, y, w: m.grid.laneW, h });
  plan.push(`actor lane "${o.actor}"${o.kind === "system" ? " (a system, not a person)" : ""} at y=${y}, height ${h}`);

  // INSERT BEFORE THE ELEMENTS, for the same reason a swimlane is: mxGraph paints in document order and
  // a band has an opaque fill, so a band written last is painted OVER every screen inside it. The cell
  // does not move, does not error and does not warn — it simply stops being visible, while the model
  // still validates at 0 errors. Anchored after the last actor lane, else after lane-ui.
  const anchorId = existing.length ? existing[existing.length - 1].id : "lane-ui";
  const at = blocks.findIndex((b) => new RegExp(`\\bid="${anchorId}"`).test(b));
  const ordered = at >= 0 ? [...blocks.slice(0, at + 1), cell, ...blocks.slice(at + 1)] : [...blocks, cell];

  let out = splice(xml, ordered);
  out = setPage(out, { h: pageH(xml) + by });
  finish(target, file, out, plan, o, existing.length ? [] : [
    "first actor lane: it was placed to CONTAIN the screens already drawn, so nothing had to move.",
    "Later lanes are for screens that do not exist yet — pass --actor to `add` to place one.",
  ]);
}

// ---------------------------------------------------------------- swimlane

function cmdSwimlane(target, o) {
  const { file, xml } = read(target);
  if (!o.label || !o.streams) die("swimlane needs --label and --streams.");
  // Idempotence before disambiguation — see cmdAdd.
  if (existingBand(xml, (c) => c.streams && c.label === o.label)) {
    console.log(`${target}: a band labelled "${o.label}" already exists — leaving it alone.`);
    return;
  }
  // The other command with nothing to infer from: --streams names a stream that does not exist yet.
  const m = model(xml, pickRegion(xml, o, [],
    "A new band declares a stream that is on no cell yet, so there is nothing to infer from."));
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
      if (laneBlockRe("evt").test(b)) return setGeom(b, { h: g.h + by });
      if (/\bem="group"/.test(b)) return setGeom(b, { h: g.h + by });
      return b;
    });
    plan.push(`event lane +${by}, ${m.sliceCells.length} slice cell(s) grown +${by}`);
  }
  const extra = ` em="lane" streams="${esc(o.streams)}"` + (o.identity ? ` identity="${esc(o.identity)}"` : "");
  const cell = box(`swim-${slug(o.streams.split(",")[0])}`, o.label, "swimlane", extra,
    { x: LANE_X, y, w: m.grid.laneW, h });
  plan.push(`band "${o.label}" at y=${y}, height ${h}`);

  // INSERT THE BAND BEFORE THE ELEMENTS, NEVER APPEND IT.
  //
  // mxGraph renders in document order and a swimlane has an OPAQUE fill, so a band written last is painted
  // over every event drawn inside it. The cell does not move, does not error and does not warn — it simply
  // stops being visible, while the model still validates at 0 errors and 0 warnings.
  //
  // Found by adding a foreign band to the translation reference implementation, moving the external event
  // into it, and looking at the PNG: an empty band and a missing box. Exactly the class of defect
  // "always render and look" exists for, and the only one so far that the renderer alone could catch.
  //
  // Anchored after the last existing swimlane so bands stay in y order in the file too; falling back to the
  // event lane covers the first band in a fresh model, and to a plain append if neither is found.
  const anchorId = last?.id ?? "lane-evt";
  const at = blocks.findIndex((b) => new RegExp(`\\bid="${anchorId}"`).test(b));
  const ordered = at >= 0
    ? [...blocks.slice(0, at + 1), cell, ...blocks.slice(at + 1)]
    : [...blocks, cell];

  let out = splice(xml, ordered);
  out = setPage(out, { h: pageH(xml) + by });
  finish(target, file, out, plan, o,
    o.identity ? [] : ["no --identity given, so band-needs-identity will fire. Correct: what keys one",
                       "stream is a domain answer, not something a tool may default to the aggregate name."]);
}
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------- mark (the two slice markers)
//
// Both of these hang on a slice cell and both are one attribute, so they are one command.
//
//   --alt <context>     UES ch. 18: "If there are alternative flows for a certain slice, I place a
//                       marker below the slice with a link to a different model on the board."
//   --external          LEB ch. 9: "In my models Slices are typically surrounded by a black border.
//                       Slices that just mimic information flow aren't."
//
// THE BORDER IS DRAWN BY REMOVING IT, which is the book's own polarity: ours is bordered, foreign is
// not. So `--external` strips the slice band's dashes-and-red down to a flat grey outline, and the
// eye reads the difference at model scale without a legend.
function cmdMark(target, o) {
  const { file, xml } = read(target);
  if (!o.slice) die("mark needs --slice <name>.");
  if (!o.alt && !o.external) die("mark needs --alt <context> and/or --external.");
  const m = model(xml, pickRegion(xml, o, [
    { what: "--slice", pred: (c) => c.em === "group" && c.slice === o.slice },
  ]));
  const cell = m.sliceCells.find((c) => c.slice === o.slice);
  if (!cell) die(`no slice cell for "${o.slice}". Slices: ${m.sliceCells.map((c) => c.slice).join(", ")}.`);

  const plan = [];
  const blocks = m.blocks.map((b) => {
    if (b !== cell.block) return b;
    let s = b;
    if (o.alt) { s = setAttr(s, "alt", o.alt); plan.push(`alternative flows -> "${o.alt}"`); }
    if (o.external) {
      s = setAttr(s, "external", "true");
      // The band loses its border. Keeping the label colour would still say "ours" at a glance.
      s = s.replace(/strokeColor=#b85450/, "strokeColor=#999999")
           .replace(/fontColor=#b85450/, "fontColor=#999999");
      plan.push(`external="true" — not ours to build, so codegen will skip it`);
    }
    return s;
  });
  finish(target, file, splice(xml, blocks), plan, o, o.external
    ? ["nothing is generated from this slice now. LEB ch.9: \"avoid the temptation to directly map",
       "this to the code that needs to be written.\""]
    : []);
}

// ---------------------------------------------------------------- chapter
//
// The span is what makes this a cell rather than a line in a file: you can see at a glance how much of
// the model one chapter covers, and one that spans everything is telling you something.
//
// The ORDER is `slices=`, not the geometry — a walk may revisit a column, so position gives extent and
// only the list gives sequence.
//
// A CHAPTER BAR, DRAWN ABOVE THE TIMELINE — and the placement is the book's, not a preference.
//
// UES ch. 18: "I place 'chapters' directly above the Event Model, so my eyes automatically capture the
// current context while reading along the timeline." The reason IS the placement: you read a slice and
// glance up for its context. Below the model that does not work, so above is not decoration.
//
// AN AMBIGUITY, NAMED AND CHOSEN. The book says "above the Event Model" and also draws the pink Model
// Context sticky at the top-left (Fig. 18.3), so "above" cannot mean above the sticky — and it must
// not, because a region's boundary IS its model cell (step 2): a bar above the sticky would fall into
// the PREVIOUS model on a board. So chapters occupy the strip between the model cell and the UI lane —
// above the timeline, inside their own region. The pink sticky is the model's name, not part of the
// timeline it labels.
//
// "arrange them in two layers" is chapters and sub-chapters. Two rows are available via --layer; the
// kit invents NO nesting rule, because the book states none and a guessed one would fire falsely.
function cmdChapter(target, o) {
  const { file, xml } = read(target);
  if (!o.chapter || !o.slices) die("chapter needs --chapter <slug> and --slices <a,b,c>.");
  const names = o.slices.split(",").map((s) => s.trim()).filter(Boolean);
  // The slices name themselves into a region. A chapter whose slices live in TWO models is refused by
  // pickRegion — that is the cross-context chapter, which is V19 and step 7, not this step.
  const m = model(xml, pickRegion(xml, o, [
    { what: "--slices", pred: (c) => c.em === "group" && names.includes(c.slice) },
  ]));
  if (o.then && names.length < 2) {
    die("a chapter that asserts an outcome walks at least two slices; one slice is a slice test.\n" +
        "       Drop --then to make it pure structure, which may group one.");
  }

  const cells = names.map((n) => {
    const c = m.sliceCells.find((x) => x.slice === n);
    if (!c) die(`--slices names "${n}", which has no slice cell. Bands: ${m.sliceCells.map((x) => x.slice).join(", ")}.`);
    return c;
  });
  const x0 = Math.min(...cells.map((c) => c.g.x));
  const x1 = Math.max(...cells.map((c) => c.g.x + c.g.w));

  const anchor = m.region.anchor?.g;
  if (!anchor) die("this model has no model cell, so there is nothing to place a chapter under.");
  const row = Math.max(0, (o.layer ?? 1) - 1);
  const y = anchor.y + anchor.h + CHAPTER_TOP_PAD + row * (CHAPTER_H + CHAPTER_GAP);

  // The strip has to be tall enough. If it is not, the TIMELINE moves down — the model cell stays put,
  // so the region's own anchor does not move and the partition is untouched, while every lower region
  // is carried down by the usual global shiftY.
  const need = y + CHAPTER_H + CHAPTER_GAP;
  const top = m.grid.uiY - SLICE_PAD;                 // slice cells start 20 above the UI lane
  const by = Math.max(0, need - top);
  const plan = [];
  let blocks = m.blocks;
  if (by > 0) {
    const s = shiftY(blocks, top, by);
    blocks = s.blocks;
    plan.push(`timeline shifted +${by} to open the chapter strip, ${s.cells} cell(s), ${s.points} point(s)`);
  }

  const extra = ` em="chapter" chapter="${esc(o.chapter)}" slices="${esc(names.join(", "))}"`
    + (o.then ? ` then="${esc(o.then)}"` : "");
  const cell = box(`chapter-${slug(o.chapter)}`, o.label ?? o.chapter, "chapter", extra,
    { x: x0, y, w: x1 - x0, h: CHAPTER_H });

  let out = splice(xml, [...blocks, cell]);
  out = setPage(out, { h: pageH(xml) + by });
  plan.push(`chapter "${o.chapter}" over ${names.length} slice(s), x ${x0}..${x1} at y=${y} (layer ${row + 1})`);
  finish(target, file, out, plan, o, o.then ? [] : [
    "no --then, so this is a STRUCTURAL chapter — the book's own use, grouping slices and asserting",
    "nothing. Add --then \"SomeView(field=value)\" only if it should also be WALKED end to end.",
  ]);
}

// ---------------------------------------------------------------- route

function cmdRoute(target, o) {
  const { file, xml } = read(target);
  // Both endpoints name themselves into a region, and an edge whose ends are in two models is exactly
  // the `cross-region-edge` error model.mjs now raises — so refuse to draw it rather than draw it and
  // let validate complain afterwards.
  const m = model(xml, pickRegion(xml, o, [
    { what: "--from/--to", pred: (c) => c.id === o.from || c.id === o.to },
  ]));
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
  const m = model(xml, pickRegion(xml, o, [
    { what: "--band", pred: (c) => c.streams && (c.id === o.band || c.label === o.band) },
  ]));
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
  // Status is an attribute edit with no geometry, so a demote may legitimately span the board — a
  // model-wide sweep from --from-diff is the normal case. Unscoped on purpose.
  const m = model(xml, { top: -Infinity, bottom: Infinity, index: 0, context: null, anchor: null });
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

// ---------------------------------------------------------------- promote
//
// The symmetric twin of `demote`, and it exists because without it moving a slice forward was a hand
// edit of two places that must agree — status= and the label's third line. Doing that by hand is how
// hold-bay sat at `in-progress` after it was finished, which is half of why the model's statuses stopped
// matching the code. KIT-FINDINGS V5.
//
// It will not skip a step and it will not go backwards: `demote --slice x` is how you go back, and it
// says so, because "promote" that silently reverses is a command nobody can trust in a diff.

export const STATUSES = ["in-design", "ready", "in-progress", "in-review", "closed"];

function cmdPromote(target, o) {
  const { file, xml } = read(target);
  // As demote: an attribute edit with no geometry, so it is not scoped to a region.
  const m = model(xml, { top: -Infinity, bottom: Infinity, index: 0, context: null, anchor: null });
  const names = o.slice ?? [];
  if (!names.length) die("promote needs --slice <name> (repeatable).");
  if (o.to && !STATUSES.includes(o.to))
    die(`--to must be one of: ${STATUSES.join(", ")}.`);

  const plan = [];
  const blocks = m.blocks.map((b) => {
    if (!/\bem="group"/.test(b)) return b;
    const s = attr(b, "slice");
    if (!names.includes(s)) return b;
    const from = attr(b, "status") ?? "in-design";
    // No --to means "one step forward", which is the common case and cannot typo into a wrong state.
    const to = o.to ?? STATUSES[Math.min(STATUSES.indexOf(from) + 1, STATUSES.length - 1)];
    if (to === from) { plan.push(`${s}: already ${from} — unchanged`); return b; }
    if (STATUSES.indexOf(to) < STATUSES.indexOf(from))
      die(`${s}: ${from} -> ${to} is backwards. Use "demote --slice ${s}", which records why.`);
    plan.push(`${s}: ${from} -> ${to}`);
    return setAttr(setAttr(b, "status", to), "label", `${s}\n${attr(b, "pattern")} · ${to}`);
  });
  const moved = plan.filter((l) => !l.includes("unchanged"));
  if (!moved.length) { console.log(`${target}: nothing to promote.`); return; }
  finish(target, file, splice(xml, blocks), plan, o,
    ["status= is advisory: a .drawio in git provides no mutual exclusion, so two agents on two",
     "branches can both set in-progress. Real exclusion is one branch per slice."]);
}

// ---------------------------------------------------------------- reflow

// REFLOW IS THE ONE COMMAND THAT TOUCHES EVERY REGION, and it needs no selector: "re-derive the
// geometry" means all of it. Regions are processed TOP TO BOTTOM and the file is re-parsed between
// each, because an earlier region growing shifts every later one down — so a later region's own lane
// arithmetic has to be read off the coordinates it actually has by then, not the ones it started with.
// The shift is rigid, so this composes: it changes where a region is, never its internal offsets.
function cmdReflow(target, o) {
  const { file, xml } = read(target);
  const n = regionsIn(xml).regions.length;
  let cur = xml;
  const plan = [];
  for (let i = 0; i < n; i++) {
    const r = regionsIn(cur).regions[i];
    const step = reflowRegion(cur, r);
    if (!step) continue;
    cur = step.out;
    plan.push(...step.plan.map((p) => (n > 1 ? `[${r.context ?? `#${i + 1}`}] ${p}` : p)));
  }
  if (!plan.length) { console.log(`${target}: geometry already derived — nothing to reflow.`); return; }
  finish(target, file, cur, plan, o, []);
}

function reflowRegion(xml, region) {
  const m = model(xml, region);
  const plan = [];
  const wantLaneW = m.grid.lastCol == null ? m.grid.laneW
    : Math.max(m.grid.laneW, (m.grid.lastCol - LANE_X) + EL_W + SLICE_PAD);
  const last = m.swimlanes[m.swimlanes.length - 1];
  const wantEvtH = last ? (last.g.y + last.g.h + BAND_BOT_PAD) - m.grid.evtY : m.lanes["lane-evt"].g.h;
  const dEvt = wantEvtH - m.lanes["lane-evt"].g.h;
  const sliceY = m.grid.uiY - SLICE_PAD, sliceH = (m.grid.evtBottom + dEvt) - sliceY;
  const lowestGwt = m.gwts.length ? Math.max(...m.gwts.map((g) => g.g.y + g.g.h)) : m.grid.gwtY;

  // THE JOURNEY-BAR RE-SEATING THAT USED TO LIVE HERE IS GONE, and its absence is the point.
  //
  // A journey bar sat BELOW the GWT lane, and that lane grows as GWTs arrive — so reflow had to catch
  // bars the growth had stranded in the middle of the rules. A chapter is anchored to the MODEL CELL
  // and sits above the timeline, which the GWT lane cannot reach: nothing below it can strand it, so
  // there is nothing to re-seat. Deleting the code rather than leaving it filtering on `em="journey"`,
  // which would be a silent no-op forever.
  let blocks = m.blocks;
  // shiftY stays global on purpose: growing this region's event lane must carry every region below it.
  if (dEvt) { const s = shiftY(blocks, m.grid.evtBottom, dEvt); blocks = s.blocks; plan.push(`event lane ${m.lanes["lane-evt"].g.h}->${wantEvtH}, ${s.cells} cell(s) below it moved`); }
  const mine = within(m);
  blocks = blocks.map((b) => {
    // Resizing is this region's business only — without this guard, one model's lane width would be
    // stamped onto every other model on the board.
    if (!mine(b)) return b;
    const g = geomOf(b); if (!g) return b;
    if (isLaneBlock(b) || /\bstreams="/.test(b)) {
      let out = g.w !== wantLaneW ? setGeom(b, { w: wantLaneW }) : b;
      if (laneBlockRe("evt").test(b) && dEvt) out = setGeom(out, { h: wantEvtH });
      if (laneBlockRe("gwt").test(b)) {
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
  // As in `add`: this region's own requirement, unchanged, held against what the others occupy.
  const wantPageW = Math.max(LANE_X + wantLaneW + PAGE_RIGHT_PAD,
    boardWidth(blocks.filter((b) => !mine(b))) ?? 0);
  let out = splice(xml, blocks);
  out = setPage(out, { w: wantPageW, h: wantPageH });
  plan.push(`page ${wantPageW} x ${wantPageH}`);
  if (!plan.length) return null;
  return { out, plan };
}

// ---------------------------------------------------------------- cli

function die(msg) { console.error(`slice: ${msg}`); process.exit(1); }
function finish(target, file, out, plan, o, notes) {
  console.log(`${target}:`);
  for (const p of plan) console.log(`  ${p}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (o.dryRun) { console.log(`  --dry-run: nothing written.`); return; }
  assertNoDuplicateAttrs(out);
  writeFileSync(file, CRLF ? out.replace(/\n/g, "\r\n") : out, "utf8");
}

const argv = process.argv.slice(2);
const cmd = argv.shift(), target = argv.shift();
const o = { slice: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") { o.dryRun = true; continue; }
  if (a === "--external") { o.external = true; continue; }
  if (a === "--from-diff") { o.fromDiff = true; continue; }
  const v = argv[++i];
  if (a === "--slice" && (cmd === "demote" || cmd === "promote")) o.slice.push(v);
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
  else if (a === "--chapter") o.chapter = v;
  else if (a === "--layer") o.layer = +v;
  else if (a === "--alt") o.alt = v;
  else if (a === "--slices") o.slices = v;
  else if (a === "--then") o.then = v;
  else if (a === "--actor") o.actor = v;
  else if (a === "--kind") o.kind = v;
  // Which model on a board this write goes to. Never needed on a one-model file, and on a board only
  // where the command names nothing that already sits in one region — see pickRegion.
  else if (a === "--model") o.model = v;
  else if (a === "--context") o.context = v;
  else if (a === "--system") o.system = v;
  else die(`unknown flag ${a}`);
}
if (!cmd || !target) {
  console.error(readFileSync(new URL(import.meta.url)).toString().split("\n")
    .slice(2, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
const ops = { model: cmdModel, add: cmdAdd, swimlane: cmdSwimlane, actorlane: cmdActorLane, chapter: cmdChapter, mark: cmdMark, route: cmdRoute, identity: cmdIdentity, demote: cmdDemote, promote: cmdPromote, reflow: cmdReflow };
if (!ops[cmd]) die(`unknown command "${cmd}". One of: ${Object.keys(ops).join(", ")}.`);
if (cmd === "add" && (!o.slice || !o.pattern)) die("add needs --slice and --pattern.");
ops[cmd](target, o);
