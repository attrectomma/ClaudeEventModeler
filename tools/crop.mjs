#!/usr/bin/env node
// Cut an x-window out of a .drawio so a wide model can actually be LOOKED at.
//
//   node tools/crop.mjs <src.drawio> <x0> <x1> <out.drawio>
//
// A real event model runs thousands of pixels wide. Rendered whole and downscaled to fit a
// screen, the labels turn to mush and layout defects — edges through boxes, elements outside a
// lane — stop being visible, which defeats the point of rendering at all. This writes a
// throwaway copy holding only the cells in [x0, x1], shifted to the origin, so `render` produces
// something legible.
//
// Output is for looking at, never for editing: edges whose other endpoint fell outside the
// window are dropped, so the crop is not a valid model. Edit the source.

import { readFileSync, writeFileSync } from "node:fs";

const [src, x0s, x1s, out] = process.argv.slice(2);
if (!src || !x0s || !x1s || !out) {
  console.error("usage: node tools/crop.mjs <src.drawio> <x0> <x1> <out.drawio>");
  process.exit(2);
}
const x0 = +x0s, x1 = +x1s;
let xml = readFileSync(src, "utf8");
if (!/<mxGraphModel/.test(xml)) {
  console.error("source is compressed — run: node tools/drawio.mjs inflate <file>");
  process.exit(1);
}

// <object>…</object> wrappers and bare <mxCell>…</mxCell>, but never the id="0"/"1" roots.
// The line ending must be \r?\n, not \n: on Windows these files are CRLF, and anchoring on a bare
// \n matched ZERO blocks and cropped to an empty page — a silent failure of the render-and-look
// loop, which is the one check that catches layout defects XML cannot show.
const blocks = [...xml.matchAll(
  /        <object [\s\S]*?<\/object>\r?\n|        <mxCell id="(?!0"|1")[\s\S]*?<\/mxCell>\r?\n/g)]
  .map((m) => m[0]);

const keep = [];
for (const b of blocks) {
  if (/edge="1"/.test(b)) { keep.push(b); continue; }   // relative geometry; pruned by endpoint below
  const g = /<mxGeometry([^>]*?)as="geometry"/.exec(b);
  if (!g) { keep.push(b); continue; }
  const a = Object.fromEntries([...g[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
  const x = +(a.x ?? 0), w = +(a.width ?? 0);
  // Lanes and swimlanes span the whole model; clamp them or they blow out the export bounds.
  if (/id="lane-/.test(b) || /\bstreams="/.test(b)) {
    keep.push(b.replace(/x="40"/, 'x="20"').replace(/width="\d+"/, `width="${x1 - x0 + 40}"`));
  } else if (x + w >= x0 && x <= x1) {
    keep.push(b.replace(`x="${a.x}"`, `x="${x - x0 + 40}"`));
  }
}

const ids = new Set([...keep.join("").matchAll(/<(?:object|mxCell) id="([^"]+)"/g)].map((m) => m[1]));
const pruned = keep
  .filter((b) => {
    const s = /source="([^"]+)"/.exec(b), t = /target="([^"]+)"/.exec(b);
    return !s || !t || (ids.has(s[1]) && ids.has(t[1]));
  })
  .map((b) => b.replace(/<mxPoint x="(\d+)"/g, (_, px) => `<mxPoint x="${+px - x0 + 40}"`));

xml = xml
  .replace(/(<root>\r?\n)[\s\S]*?(      <\/root>)/,
    `$1        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n${pruned.join("")}$2`)
  .replace(/pageWidth="\d+"/, `pageWidth="${x1 - x0 + 80}"`);

writeFileSync(out, xml);
console.log(`${out}: ${pruned.length} cells, x ${x0}..${x1}`);
