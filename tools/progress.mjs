#!/usr/bin/env node
// What is actually built, against what the model CLAIMS is built.
//
//   node tools/progress.mjs [--project <path>] [--stale] [--json]
//
// THIS EXISTS BECAUSE status= STOPPED ANSWERING THE QUESTION. It is read at SCAFFOLD time to decide
// whether a GWT's test is born `[Fact(Skip=…)]`, and test files are `scaffold` — kept for ever. So a
// project that scaffolds the whole system at once has to promote every slice up front or bake a skip
// into most of its suite permanently. Promote up front and every slice reads `ready` whether or not a
// line of it exists, which is exactly what happened on the first two-model run: 19 slices claiming
// `ready` with nothing written, and a human reading the diagram for progress getting no signal at all.
// KIT-FINDINGS V5.
//
// So this reads the CODE, not the claim, and prints both side by side. It never edits anything — same
// reasoning that keeps `kit-test` and `completeness-checker` outside what they inspect. When the two
// disagree it names the one command that fixes it.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./project.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const PROJECT = projectRoot(argv);
const MODEL = fileURLToPath(new URL("model.mjs", import.meta.url));

const ir = JSON.parse(execFileSync(process.execPath,
  [MODEL, "compile", join(PROJECT, "diagrams"), "--stdout",
   ...(argv.includes("--project") ? ["--project", argv[argv.indexOf("--project") + 1]] : [])],
  { encoding: "utf8", maxBuffer: 1 << 28 }));

const pascal = (s) => s.replace(/(^|[^a-zA-Z0-9])([a-z])/g, (_, a, b) => b.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
const GEN = join(PROJECT, "generated", pascal(ir.system));

const walk = (d) => existsSync(d) ? readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : (n.endsWith(".cs") ? [p] : []);
}) : [];
const files = walk(GEN).filter((p) => !p.includes(`${sep()}obj${sep()}`) && !p.includes(`${sep()}bin${sep()}`));
function sep() { return process.platform === "win32" ? "\\" : "/"; }

// SKIP THE BANNER. Every generated file's header contains the words "Holes marked TODO(codegen) are
// yours to close", so a raw count scores a fully-implemented file as 4 outstanding holes — measured,
// and it reported a finished slice as unfinished on the first run of this check.
const BANNER_LINES = 6;
const outstanding = (p) =>
  (readFileSync(p, "utf8").split("\n").slice(BANNER_LINES).join("\n")
    .match(/TODO\(codegen\)|TODO\(architect\)|NotImplementedException/g) || []).length;

// A slice's files, by the folder and test-file names codegen derives from its name.
const filesFor = (name) => {
  const P = pascal(name), s = sep();
  return files.filter((p) =>
    p.includes(`${s}${P}${s}`) ||
    p.endsWith(`${s}${P}Tests.cs`) ||
    p.endsWith(`${s}${P}ConcurrencyTests.cs`) ||
    p.endsWith(`${s}${P}CrossStreamTests.cs`));
};

// What status= a slice's code would justify. Deliberately coarse: this NEVER promotes anything, it only
// says when the claim and the code disagree enough to be worth a look.
const DONE = ["in-review", "closed"];
const rows = [];
for (const s of [...ir.slices].sort((a, b) => a.context.localeCompare(b.context) || a.name.localeCompare(b.name))) {
  if (!s.generates) { rows.push({ ...s, kind: "upstream" }); continue; }
  const mine = filesFor(s.name);
  const todos = mine.reduce((a, p) => a + outstanding(p), 0);
  const built = mine.length > 0 && todos === 0;
  const claimsDone = DONE.includes(s.status);
  rows.push({
    ...s, kind: "slice", files: mine.length, todos, built,
    stale: built !== claimsDone
      ? (built ? `built, but status says ${s.status}` : `status says ${s.status}, ${todos} hole(s) left`)
      : null,
  });
}

if (has("--json")) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

const gen = rows.filter((r) => r.kind === "slice");
const built = gen.filter((r) => r.built);
const todos = gen.reduce((a, r) => a + r.todos, 0);
const show = has("--stale") ? gen.filter((r) => r.stale) : rows;

console.log(`progress — ${ir.system}  (${PROJECT})\n`);
if (!existsSync(GEN)) {
  console.log(`  nothing generated yet at ${GEN}`);
  console.log(`  fix: node tools/codegen.mjs`);
  process.exit(0);
}
console.log("  " + "slice".padEnd(24) + "status=".padEnd(13) + "code".padEnd(14) + "files");
console.log("  " + "-".repeat(62));
for (const r of show) {
  const code = r.kind === "upstream" ? "—  generates nothing"
             : r.built ? "BUILT" : `${r.todos} hole(s)`;
  console.log("  " + r.name.padEnd(24) + (r.status ?? "?").padEnd(13) + code.padEnd(14)
            + (r.kind === "upstream" ? "" : r.files));
}
console.log("  " + "-".repeat(62));
console.log(`  ${built.length}/${gen.length} slice(s) built · ${todos} hole(s) left`
          + `  (${rows.length - gen.length} upstream slice(s) generate nothing)`);

const stale = gen.filter((r) => r.stale);
if (stale.length) {
  console.log(`\nSTATUS DOES NOT MATCH THE CODE — ${stale.length}. The diagram is what a human reads for`);
  console.log(`progress, so a stale status is worse than no status: it is confidently wrong.`);
  for (const r of stale) console.log(`  ${r.name.padEnd(24)} ${r.stale}`);
  const ready = stale.filter((r) => r.built).map((r) => r.name);
  if (ready.length) {
    console.log(`\n  fix: node tools/slice.mjs promote <model>.drawio ${ready.map((n) => `--slice ${n}`).join(" ")} --to in-review`);
  }
}

// The one number that is NOT derivable from here, said out loud rather than guessed at.
console.log(`\nNOTE: "BUILT" means no TODO(codegen)/TODO(architect)/NotImplementedException is left in the`);
console.log(`      slice's own files. It does NOT mean the tests pass — only \`dotnet test\` says that, and`);
console.log(`      a slice can be hole-free and wrong. Run the suite before believing this table.`);
