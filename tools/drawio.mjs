#!/usr/bin/env node
// Helpers for the Claude <-> draw.io loop.
//
//   node tools/drawio.mjs inflate <file.drawio>   make compressed <diagram> bodies readable, in place
//   node tools/drawio.mjs render  <file.drawio>   export a PNG next to the file
//   node tools/drawio.mjs check   <file.drawio>   report whether the XML is readable
//
// draw.io may store each <diagram> as base64(deflateRaw(encodeURIComponent(xml))).
// Claude can only read a diagram it can see as plain text, so `inflate` is the fix.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { resolve, dirname, basename, extname, join } from "node:path";

const DRAWIO_EXE = "C:\\Program Files\\draw.io\\draw.io.exe";
const DIAGRAM_RE = /<diagram([^>]*)>([\s\S]*?)<\/diagram>/g;

function decodeBody(body) {
  const raw = body.trim();
  if (raw.startsWith("<mxGraphModel")) return null; // already plain
  if (!raw || /[<>]/.test(raw)) return null; // not a base64 payload
  const inflated = inflateRawSync(Buffer.from(raw, "base64")).toString("utf8");
  return decodeURIComponent(inflated);
}

function eachDiagram(xml, fn) {
  let count = 0;
  const out = xml.replace(DIAGRAM_RE, (match, attrs, body) => {
    const plain = decodeBody(body);
    if (plain === null) return match;
    count++;
    return fn(attrs, plain);
  });
  return { out, count };
}

const [cmd, target] = process.argv.slice(2);
if (!cmd || !target) {
  console.error("usage: node tools/drawio.mjs <inflate|render|check> <file.drawio>");
  process.exit(2);
}

const file = resolve(target);
if (!existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}

if (cmd === "check") {
  const xml = readFileSync(file, "utf8");
  const { count } = eachDiagram(xml, (a, p) => `<diagram${a}>${p}</diagram>`);
  console.log(
    count === 0
      ? "OK - plain XML, Claude can read this directly."
      : `${count} compressed diagram(s) - run: node tools/drawio.mjs inflate ${target}`
  );
  process.exit(0);
}

if (cmd === "inflate") {
  const xml = readFileSync(file, "utf8");
  const { out, count } = eachDiagram(
    xml,
    (attrs, plain) => `<diagram${attrs}>\n${plain}\n</diagram>`
  );
  if (count === 0) {
    console.log("nothing to do - already plain XML.");
    process.exit(0);
  }
  writeFileSync(file, out, "utf8");
  console.log(`inflated ${count} diagram(s) in ${basename(file)}`);
  process.exit(0);
}

if (cmd === "render") {
  if (!existsSync(DRAWIO_EXE)) {
    console.error(`draw.io Desktop not found at ${DRAWIO_EXE}`);
    process.exit(1);
  }
  const png = join(dirname(file), `${basename(file, extname(file))}.png`);
  const r = spawnSync(
    DRAWIO_EXE,
    ["--export", "--format", "png", "--scale", "1.5", "--border", "10",
     "--output", png, file, "--no-sandbox", "--disable-gpu"],
    { stdio: "inherit" }
  );
  if (r.status !== 0 || !existsSync(png)) {
    console.error(`render failed (exit ${r.status})`);
    process.exit(1);
  }
  console.log(png);
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(2);
