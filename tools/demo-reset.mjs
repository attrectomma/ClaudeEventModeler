#!/usr/bin/env node
// demo-reset — put a demo fixture back to its starting tag, and leave the machine WARM.
//
//   node tools/demo-reset.mjs                 # reset + init + pull the base images
//   node tools/demo-reset.mjs --warm          # ...and first, build the compose images from the
//                                             #    finished tree, so the layer cache survives the reset
//   node tools/demo-reset.mjs --tag demo-gap  # jump to a later checkpoint instead
//   node tools/demo-reset.mjs --dry-run
//
// WHY THIS EXISTS RATHER THAN FOUR LINES IN THE RUNBOOK.
//
// The runbook's reset is `git reset --hard <tag> && git clean -fdx`, and the runbook explains the
// `-x` as deliberate: without it the reset "leaves build output that makes later steps suspiciously
// fast." That is right about ARTEFACTS and wrong about CACHES, and the demo pays minutes for the
// conflation. The distinction:
//
//   an ARTEFACT is the thing the kit claims to produce   — generated/, build/, designs/_shots/,
//                                                          review/. It MUST come back from scratch,
//                                                          or the demo is showing a fossil.
//   a CACHE is how fast the machine can produce it       — docker layers, the npm tarball cache,
//                                                          the NuGet package cache. None of it is
//                                                          evidence, and none of it changes a byte
//                                                          of what gets generated.
//
// `git clean -fdx` cannot tell them apart because it works on the repo, and every cache that matters
// lives OUTSIDE the repo anyway (~/.nuget, ~/.npm, the docker builder). So the clean stays exactly as
// it was — nothing is preserved inside the project — and this script warms the outside instead.
//
// The measured win is the docker layer cache. `docker compose up --build` on a cold builder was ~3
// minutes of the rehearsal; `emit` is deterministic, so the same Dockerfile and the same .csproj
// produce the same restore layer every run, and a warmed builder skips it. `--warm` must therefore
// run BEFORE the reset, while the finished tree still has a compose file to build from.
//
// It never touches the kit and it never runs `git` in the kit. One repo, one tag, one project.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tryProjectRoot, projectName, settings, KIT } from "./project.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = has("dry-run");
const TAG = val("tag", "demo-start");

// The images the emitted Dockerfiles and compose file are built from. Pulled ahead of time so the
// first `docker compose up --build` on stage is a compile and not a download. Kept as a list rather
// than parsed out of the compose file, because the compose file does not exist at reset time —
// that is the whole point of the reset.
const BASE_IMAGES = [
  "postgres:16",
  "mcr.microsoft.com/dotnet/sdk:10.0",
  "mcr.microsoft.com/dotnet/aspnet:10.0",
  "node:22-alpine",
  "nginx:alpine",
];

const run = (cmd, args, opts = {}) => {
  if (DRY) { console.log(`  would run: ${cmd} ${args.join(" ")}`); return { status: 0, stdout: "" }; }
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
};

const r = tryProjectRoot(argv);
if (!r) {
  console.error("no project configured. Run: node tools/project.mjs init --project <path>");
  process.exit(2);
}
const ROOT = r.root;
if (!existsSync(join(ROOT, ".git"))) {
  // Refuse rather than reset something that is not a git repo — `git reset --hard` in the wrong
  // directory is the one operation here nobody can undo.
  console.error(`${ROOT} is not a git repository. demo-reset only ever resets a project with its own history.`);
  process.exit(1);
}

const git = (...a) => spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });

// The tag must exist BEFORE anything is destroyed. Resetting to a tag that turns out to be a typo
// leaves the fixture wherever it was, with the artefacts already deleted.
if (git("rev-parse", "--verify", `${TAG}^{commit}`).status !== 0) {
  const tags = git("tag", "-l").stdout.trim().split(/\r?\n/).filter(Boolean);
  console.error(`no such tag "${TAG}" in ${ROOT}.\n  tags: ${tags.join(", ") || "(none)"}`);
  process.exit(1);
}

console.log(`demo-reset — ${projectName(argv)} at ${ROOT}`);
console.log(`  tag: ${TAG}${DRY ? "   (DRY RUN — nothing is written)" : ""}`);

// --- 1. warm, BEFORE the tree is cleaned -----------------------------------------------------------
if (has("warm")) {
  const gen = join(ROOT, "generated");
  const sys = existsSync(gen) ? readdirSync(gen).map((d) => join(gen, d, "docker-compose.yml")).find(existsSync) : null;
  if (!sys) {
    console.log("\n  warm: no generated compose file to build from — skipping.");
    console.log("        Run this straight after a full rehearsal, while the finished tree is still there.");
  } else {
    console.log(`\n  warm: docker compose build  (${sys})`);
    const t0 = Date.now();
    const w = run("docker", ["compose", "-f", sys, "build"], { stdio: DRY ? "pipe" : "inherit" });
    console.log(w.status === 0
      ? `  warm: layer cache filled in ${Math.round((Date.now() - t0) / 1000)}s — it survives the clean below`
      : `  warm: FAILED (exit ${w.status}). Not fatal: the demo just pays the build cost on stage.`);
  }
}

// --- 2. reset, exactly as the runbook always did ---------------------------------------------------
console.log(`\n  git reset --hard ${TAG} && git clean -fdx`);
if (!DRY) {
  const a = git("reset", "--hard", TAG);
  if (a.status !== 0) { console.error(a.stderr.trim()); process.exit(1); }
  const b = git("clean", "-fdx");
  if (b.status !== 0) { console.error(b.stderr.trim()); process.exit(1); }
  const removed = b.stdout.trim().split(/\r?\n/).filter(Boolean).length;
  console.log(`  ${git("log", "--oneline", "-1").stdout.trim()}`);
  console.log(`  ${removed} path(s) removed — artefacts come back from scratch, which is the point`);
}

// --- 3. init, because clean deleted the empty folders ----------------------------------------------
// git cannot track an empty directory, so diagrams/ and designs/ go with the clean — and
// `model.mjs validate` then answers "not found: …\diagrams" and exits 0, which is a confusing first
// thing to have on screen. init is idempotent and now PRESERVES the settings in project.json.
console.log(`\n  node tools/project.mjs init --project ${ROOT}`);
if (!DRY) {
  const i = run("node", [join(KIT, "tools", "project.mjs"), "init", "--project", ROOT, "--name", projectName(argv)]);
  console.log("  " + (i.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join("\n  "));
}

// --- 4. pull the base images -----------------------------------------------------------------------
console.log("\n  pulling base images (so the first compose build is a compile, not a download)");
let pulled = 0, already = 0, failed = 0;
for (const img of BASE_IMAGES) {
  if (DRY) { console.log(`    would pull ${img}`); continue; }
  const p = spawnSync("docker", ["pull", "-q", img], { encoding: "utf8" });
  if (p.status !== 0) { failed++; console.log(`    FAILED  ${img}  ${(p.stderr || "").trim().split("\n")[0]}`); }
  else if (/up to date|Image is up to date/i.test(p.stdout + p.stderr)) { already++; console.log(`    warm    ${img}`); }
  else { pulled++; console.log(`    pulled  ${img}`); }
}
if (failed) console.log(`  ${failed} image(s) unavailable — is Docker running? The demo needs it for tests AND compose.`);

// --- 5. what is still not warm ---------------------------------------------------------------------
// Say what this did NOT do, by the same rule as `refimpl.mjs drift`: a clean run of a partial check
// must not read as a clean bill of health.
const s = settings();
console.log("\nready.");
console.log(`  settings: mobile=${s.mobile}  kitFixes=${s.kitFixes}  demo=${s.demo}`);
console.log("  still cold, and deliberately so:");
console.log("    the model, the design, the generated code — every artefact the demo claims to produce");
console.log("  still cold, and NOT deliberately — nothing here can warm them:");
console.log("    the Testcontainers Postgres pull is warmed by the postgres:16 pull above, but the");
console.log("    first `dotnet test` still restores NuGet into ~/.nuget if this machine is fresh.");
console.log("    Run `dotnet restore` once in any generated project to fill it.");
