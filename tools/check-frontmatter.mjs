#!/usr/bin/env node
// Verify that every skill and agent has parseable YAML frontmatter.
//
//   node tools/check-frontmatter.mjs            # all skills and agents
//   node tools/check-frontmatter.mjs <file>...  # specific files
//
// Invalid frontmatter does not raise an error anywhere — the skill or agent is simply never
// offered, which looks identical to "not created yet". This caught exactly that: an unquoted
// description containing ": " is a YAML mapping-value error, so the whole file was skipped.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const REQUIRED = { skill: ["name", "description"], agent: ["name", "description"] };

function discover() {
  const out = [];
  const skills = ".claude/skills";
  if (existsSync(skills)) {
    for (const d of readdirSync(skills)) {
      const f = join(skills, d, "SKILL.md");
      if (existsSync(f)) out.push({ file: f, kind: "skill" });
    }
  }
  const agents = ".claude/agents";
  if (existsSync(agents)) {
    for (const d of readdirSync(agents)) {
      const f = join(agents, d);
      if (statSync(f).isFile() && f.endsWith(".md")) out.push({ file: f, kind: "agent" });
    }
  }
  return out;
}

const args = process.argv.slice(2);
const targets = args.length
  ? args.map((f) => ({ file: f, kind: f.includes("agents") ? "agent" : "skill" }))
  : discover();

if (!targets.length) {
  console.log("no skills or agents found.");
  process.exit(0);
}

let failed = 0;
for (const { file, kind } of targets) {
  const text = readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) {
    console.log(`FAIL  ${file}\n        no --- frontmatter block at the very top of the file`);
    failed++;
    continue;
  }
  let fm;
  try {
    fm = load(m[1]);
  } catch (e) {
    console.log(`FAIL  ${file}\n        YAML: ${e.message.split("\n")[0]}`);
    failed++;
    continue;
  }
  if (!fm || typeof fm !== "object") {
    console.log(`FAIL  ${file}\n        frontmatter is not a mapping`);
    failed++;
    continue;
  }
  const missing = REQUIRED[kind].filter((k) => !fm[k]);
  if (missing.length) {
    console.log(`FAIL  ${file}\n        missing: ${missing.join(", ")}`);
    failed++;
    continue;
  }
  console.log(`OK    ${file}  (${kind}: ${fm.name})`);
}

console.log(`\n${targets.length - failed}/${targets.length} valid`);
process.exit(failed ? 1 : 0);
