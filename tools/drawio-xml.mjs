// THE ONE PARSER. Every tool that reads a .drawio reads it through here.
//
// KIT-FINDINGS V23: this file exists because there used to be two. `model.mjs` parsed
// indentation-agnostically and read almost anything draw.io emits; `slice.mjs` anchored on 8-space
// indentation AND rewrites the whole <root> from what it matched — so a cell it did not match was not
// merely unparsed, it was DELETED. One tool called a file perfect while the other could not safely
// touch it, and before the guard existed the second silently dropped both model cells of a board on a
// `promote`, which edits an attribute and touches no geometry.
//
// A .drawio gets reformatted by ordinary events — draw.io's own serializer on a human Ctrl+S (which
// CLAUDE.md measures at 479 insertions / 473 deletions for six lines of content), a merge, a linter.
// So "both tools agree about this file" cannot rest on everyone choosing the same indentation.
//
// TWO PROPERTIES, and the second is why this is not just `parseCells` moved:
//
//   TOLERANT   — indentation, attribute order and self-closing style are all free. This is
//                model.mjs's behaviour, which was the well-tested one.
//   LOSSLESS   — every cell carries `raw`, its EXACT source span including leading indentation and
//                trailing newline. A writer splices `raw` back and an untouched cell comes out
//                byte-identical, which is what keeps a .drawio diff reviewable — the reason the model
//                is committed at all. A parser that returned only attributes could not serve the
//                writer, and that is precisely why the writer grew its own.

export const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");

export const escapeXml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;");

// The writer additionally needs newlines encoded, because it writes labels into attributes.
export const escapeAttr = (s) => escapeXml(s).replace(/\n/g, "&#10;");

export function attrsOf(tagText) {
  const out = {};
  for (const [, k, v] of (tagText ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) out[k] = unescapeXml(v);
  return out;
}

// An <object> never nests, and an <mxCell> only ever nests INSIDE an <object>. Those two facts are
// what make a span-based split correct without a real XML parser.
//
// Self-closing is matched with a bounded [^>]* so it cannot run past its own ">" into the next tag —
// the trap tools/wireframe.mjs shipped once, where a lazy alternation stopped at the self-closing
// <mxGeometry/> inside an edge, ending the block early and leaving every edge unterminated.
const OBJECT_RE = /<object\b[^>]*>[\s\S]*?<\/object>/g;
const MXCELL_RE = /<mxCell\b[^>]*?\/>|<mxCell\b[^>]*>[\s\S]*?<\/mxCell>/g;

// Every top-level cell, in document order.
//   raw    the exact source span, incl. leading indentation and trailing newline — splice this back
//   kind   "object" | "mxCell"
//   head   the opening tag
//   body   everything between the opening and closing tag ("" when self-closing)
//   attrs  an <object>'s own attributes, over its inner <mxCell>'s — so `style` and `edge` resolve
//          on a wrapped cell exactly as they do on a bare one
export function parseBlocks(text) {
  const spans = [];
  for (const m of text.matchAll(OBJECT_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, kind: "object" });
  }
  const objects = spans.slice();
  for (const m of text.matchAll(MXCELL_RE)) {
    const start = m.index, end = start + m[0].length;
    if (objects.some((o) => start >= o.start && end <= o.end)) continue;   // an object's own mxCell
    spans.push({ start, end, kind: "mxCell" });
  }
  spans.sort((a, b) => a.start - b.start);

  return spans.map((sp) => {
    // Widen to the whole line the cell occupies: leading indentation, and the trailing newline. Only
    // spaces and tabs, so the newline BEFORE the indentation stays with the previous cell and every
    // span remains disjoint.
    let s = sp.start;
    while (s > 0 && (text[s - 1] === " " || text[s - 1] === "\t")) s--;
    let e = sp.end;
    while (e < text.length && (text[e] === " " || text[e] === "\t")) e++;
    if (text[e] === "\r") e++;
    if (text[e] === "\n") e++;

    const el = text.slice(sp.start, sp.end);
    const head = /^<(?:object|mxCell)\b[^>]*>/.exec(el)?.[0] ?? el;
    const body = el.slice(head.length).replace(/<\/(?:object|mxCell)>$/, "");
    const outer = attrsOf(head);
    const inner = sp.kind === "object" ? attrsOf(/<mxCell\b[^>]*>/.exec(body)?.[0] ?? "") : {};
    return { raw: text.slice(s, e), kind: sp.kind, head, body, attrs: { ...inner, ...outer } };
  });
}

// draw.io's own two root cells. Never modelled, and a writer re-emits them itself.
export const isRootCell = (b) => b.attrs.id === "0" || b.attrs.id === "1";

// GEOMETRY IS DELIBERATELY NOT SHARED, and the reason is worth stating so nobody "finishes the job"
// later. The two readers genuinely disagree: slice.mjs returns null when a geometry declares neither
// x nor width — a relative edge geometry, which is not a box and must not be moved — while model.mjs
// reads it as a box at 0,0. Each is right for its caller, and model.mjs's result is serialised into
// the compiled IR, so changing its shape changes a generated artifact.
//
// V23 was never about geometry. It was about WHICH CELLS EXIST, and that is what parseBlocks settles.
