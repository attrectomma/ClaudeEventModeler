#!/usr/bin/env node
// Mirror the enforced stack's own documentation locally, so generated code is written against the
// real API and not a remembered one.
//
//   node tools/docs.mjs sync   [--only marten|wolverine|alba] [--concurrency 8]
//   node tools/docs.mjs status
//
// Why this exists, and why it is a PREREQUISITE rather than a convenience: Wolverine, Marten and
// Alba move faster than model knowledge, so anything generated from memory is subtly wrong — right
// shape, wrong method name, quietly deprecated overload. And codegen multiplies the error: a
// fan-out of agents produces one wrong file per agent instead of one you would have caught.
//
// All three publish llms.txt — a markdown index whose every entry is also served as raw .md. That
// is the whole mechanism: parse the index, fetch each page, write it beside the others.
//
// The mirror lands in reference/, which is gitignored. It is a regenerable build input, like
// node_modules: third-party docs, dozens of files per library, and stale the moment upstream ships.
// The cost is that a fresh clone must run `sync` once; the manifest records when it last ran so
// staleness is visible rather than assumed.

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

const SOURCES = {
  marten:    "https://martendb.io/llms.txt",
  wolverine: "https://wolverinefx.net/llms.txt",
  alba:      "https://jasperfx.github.io/alba/llms.txt",
};

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const OUT = join(ROOT, "reference", "llms");

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CONCURRENCY = Math.max(1, +flag("concurrency", "8"));
const ONLY = flag("only", null);

if (!["sync", "status"].includes(cmd)) {
  console.error("usage:\n  node tools/docs.mjs sync [--only marten|wolverine|alba] [--concurrency 8]\n  node tools/docs.mjs status");
  process.exit(2);
}

const human = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`);

// --- status ---------------------------------------------------------------------------------------

if (cmd === "status") {
  let any = false;
  for (const name of Object.keys(SOURCES)) {
    const mf = join(OUT, name, "_manifest.json");
    if (!existsSync(mf)) {
      console.log(`  ${name.padEnd(10)} NOT MIRRORED  — run: node tools/docs.mjs sync --only ${name}`);
      continue;
    }
    any = true;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    const days = Math.floor((Date.now() - Date.parse(m.fetchedAt)) / 86400000);
    console.log(`  ${name.padEnd(10)} ${String(m.pages).padStart(3)} pages  ${human(m.bytes).padStart(8)}  ` +
      `fetched ${days === 0 ? "today" : `${days} day(s) ago`}${m.failures?.length ? `  (${m.failures.length} failed)` : ""}`);
  }
  if (!any) process.exit(1);
  console.log(`\nmirror: ${OUT.replace(/\\/g, "/")}  (gitignored — a regenerable build input)`);
  process.exit(0);
}

// --- sync ----------------------------------------------------------------------------------------

// "- [Getting Started](/getting-started.md): description" -> { title, link }
// Section headings are kept so the local index reads like the upstream table of contents.
function parseIndex(text) {
  const pages = [];
  let section = "";
  for (const line of text.split("\n")) {
    const h = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (h) { section = h[1]; continue; }
    const m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*:?\s*(.*)$/.exec(line);
    if (m && m[2].endsWith(".md")) pages.push({ title: m[1], link: m[2], section, blurb: m[3] || "" });
  }
  return pages;
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

const names = ONLY ? [ONLY] : Object.keys(SOURCES);
for (const name of names) {
  const src = SOURCES[name];
  if (!src) { console.error(`unknown source: ${name}. One of: ${Object.keys(SOURCES).join(", ")}`); process.exit(2); }

  process.stdout.write(`${name}: fetching index... `);
  let index;
  try {
    const r = await fetch(src, { redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    index = await r.text();
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    continue;
  }
  const pages = parseIndex(index);
  console.log(`${pages.length} page(s)`);

  // The site may live under a base path (Alba is at /alba/). Strip it so the local tree mirrors
  // the docs rather than repeating the base segment.
  const basePath = new URL(src).pathname.replace(/[^/]*$/, "");
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_llms.txt"), index, "utf8");

  let bytes = 0;
  const failures = [];
  const results = await pool(pages, CONCURRENCY, async (p) => {
    const url = new URL(p.link, src).href;
    let rel = new URL(url).pathname.replace(/^\//, "");
    if (basePath !== "/" && rel.startsWith(basePath.slice(1))) rel = rel.slice(basePath.length - 1);
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.text();
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body, "utf8");
      bytes += Buffer.byteLength(body);
      return { ...p, rel, ok: true };
    } catch (e) {
      failures.push({ link: p.link, url, error: e.message });
      return { ...p, rel, ok: false };
    }
  });

  // A local table of contents, so a human or an agent can find the right page without a network
  // round trip. Grouped exactly as upstream grouped it.
  const ok = results.filter((r) => r.ok);
  const bySection = new Map();
  for (const r of ok) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section).push(r);
  }
  const toc = [`# ${name} — local documentation mirror`, "",
    `Generated by \`node tools/docs.mjs sync --only ${name}\` from ${src}.`,
    `**Do not edit.** ${ok.length} pages, ${human(bytes)}.`, "",
    ...[...bySection].flatMap(([s, rs]) => [`## ${s || "Pages"}`, "",
      ...rs.map((r) => `- [${r.title}](${r.rel})${r.blurb ? ` — ${r.blurb}` : ""}`), ""]),
  ].join("\n");
  writeFileSync(join(dir, "INDEX.md"), toc, "utf8");

  writeFileSync(join(dir, "_manifest.json"), JSON.stringify({
    name, source: src, fetchedAt: new Date().toISOString(),
    pages: ok.length, bytes, failures,
  }, null, 2) + "\n", "utf8");

  console.log(`  ${ok.length}/${pages.length} pages, ${human(bytes)} -> reference/llms/${name}/`);
  for (const f of failures.slice(0, 8)) console.log(`  MISSING  ${f.link}  (${f.error})`);
  if (failures.length > 8) console.log(`  ... and ${failures.length - 8} more`);
}

console.log(`\nRead reference/llms/<lib>/INDEX.md to find a page. Re-run sync to refresh.`);
