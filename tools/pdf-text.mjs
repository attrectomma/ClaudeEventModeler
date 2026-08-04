#!/usr/bin/env node
// Extract a PDF to plain text so it can be grepped and read cheaply.
//
//   node tools/pdf-text.mjs <file.pdf> [--out reference/<name>.txt]
//
// The Read tool rasterises PDF pages via poppler, which is not installed here — and for a
// 400-page book, page images are the wrong shape anyway: text is greppable and costs far less
// context. Page markers are preserved so passages stay citable.
//
// Output goes under reference/, which is gitignored: these are purchased books.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, basename, extname, join } from "node:path";

const [target, ...rest] = process.argv.slice(2);
if (!target) {
  console.error("usage: node tools/pdf-text.mjs <file.pdf> [--out reference/name.txt]");
  process.exit(2);
}

const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

const file = resolve(target);
const outIdx = rest.indexOf("--out");
const out = resolve(
  outIdx >= 0 && rest[outIdx + 1]
    ? rest[outIdx + 1]
    : join("reference", `${basename(file, extname(file))}.txt`)
);

const doc = await getDocument({
  data: new Uint8Array(readFileSync(file)),
  useSystemFonts: true,
}).promise;

const chunks = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();

  // pdf.js hands back positioned fragments, not lines. Group by vertical position so the
  // output reads as prose instead of one word per line.
  const lines = new Map();
  for (const item of content.items) {
    if (!item.str) continue;
    const y = Math.round(item.transform[5]);
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push({ x: item.transform[4], s: item.str });
  }
  const text = [...lines.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF origin is bottom-left, so descending y is top-down
    .map(([, frags]) => frags.sort((a, b) => a.x - b.x).map((f) => f.s).join("").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  chunks.push(`\n\n===== page ${p} =====\n${text}`);
  if (p % 50 === 0) process.stderr.write(`  ${p}/${doc.numPages}\n`);
}

mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, chunks.join(""), "utf8");
console.log(`${doc.numPages} pages -> ${out}`);
