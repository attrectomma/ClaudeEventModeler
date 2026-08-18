#!/usr/bin/env node
// Where this kit copy writes to, and the scaffolding of that place.
//
//   node tools/project.mjs init [--project <path>] [--name <name>]
//   node tools/project.mjs where [--project <path>]
//   node tools/project.mjs inbox [--project <path>]
//
// ONE KIT COPY SERVES ONE PROJECT. The kit is cloned once from GitHub and then copied — without
// its .git — per project. That is what makes the session's cwd stay inside the kit, so CLAUDE.md,
// .claude/skills, .claude/agents, .mcp.json and the per-cwd memory all keep resolving exactly as
// they always have. Nothing about the agent surface had to move; only the OUTPUT did.
//
// The project is a plain folder anywhere on disk, with its own git and NO TRACE OF THE KIT in it.
// So every artifact the developer owns — diagrams, designs, the IR, generated code and tests —
// lands under the project root, and everything the KIT owns — tools, skills, the docs mirror,
// reference implementations, fixtures — stays here.
//
// `project.json` in the kit root is configuration, not a manifest. CLAUDE.md bans manifests
// because "a manifest would be a second place facts live" — that ban is about DOMAIN facts, which
// belong on cells. An absolute path to an output directory is not a domain fact and could not be
// drawn on a diagram if we tried.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(KIT, "project.json");
const PALETTE = join(KIT, "templates", "drawio-settings.json");

// The folders a project owns. `build` is derived, `generated` is code — both are listed here so
// init, .gitignore and the resolver cannot drift from one another.
export const DIRS = ["inbox", "diagrams", "designs"];

const readConfig = () => {
  if (!existsSync(CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch (e) {
    console.error(`project.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }
};

// --- settings -------------------------------------------------------------------------------------
//
// Two booleans, and they are configuration in the same sense the project path is: neither is a domain
// fact, neither could be drawn on a cell. They live here rather than in a new module because
// project.json has exactly one reader and a second one is how two defaults drift apart.
//
// EVERY SETTING IS OFF-BY-ABSENCE IN THE DIRECTION THAT COSTS LESS TO GET WRONG, which is not the
// same as "false by default":
//
//   mobile    default FALSE — a second viewport doubles every shot in design.mjs, review.mjs and
//             ui-journey, and for a kit demo it is pure wall-clock. NOTE THE COST HONESTLY: mobile
//             is where responsive CSS fails silently, and the first run of the styling skill found
//             content running off the right edge that was invisible in the CSS and unmissable in the
//             image. Turning it on is one line and it is the right line for a project that ships.
//
//   kitFixes  default TRUE — today's behaviour, because a generator defect found mid-run and left
//             unfixed is a defect every future project inherits. A demo copy sets it false so the run
//             does not detour into tools/ in front of an audience.
//
// kitFixes=false is NOT permission to ignore a blocking defect. It says where the fix lands: log the
// finding to KIT-FINDINGS.md, and if it blocks, hand-edit the PROJECT's own scaffold file — never the
// kit — and say so. A scaffold is hand-owned from the moment it exists, so that edit is legal; an
// edit to tools/ during a demo is what this flag exists to prevent.
//   demo      default FALSE — the BEHAVIOURAL half of the same idea, and the only setting no tool
//             reads. It is addressed to whoever is driving: on a live demo, spend no time on work
//             the room cannot see. What it changes is listed in CLAUDE.md under "Two settings…",
//             and it is one key rather than four things to remember on stage.
const SETTING_DEFAULTS = { mobile: false, kitFixes: true, demo: false };

export function settings() {
  const cfg = readConfig() ?? {};
  const out = { ...SETTING_DEFAULTS };
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (typeof cfg[k] === "boolean") out[k] = cfg[k];
    else if (cfg[k] !== undefined) {
      // A typo'd or mistyped setting must fail loudly. A silently ignored `"mobile": "false"` reads
      // as configured and behaves as default — the same class as a package pin that pins nothing.
      console.error(`project.json: "${k}" must be true or false, not ${JSON.stringify(cfg[k])}.`);
      process.exit(1);
    }
  }
  // An unknown key is a typo until proven otherwise, and a typo'd flag is a flag that does nothing.
  const known = new Set([...Object.keys(SETTING_DEFAULTS), "project", "name"]);
  for (const k of Object.keys(cfg)) {
    if (!known.has(k) && !k.startsWith("_")) {
      console.error(`project.json: unknown setting "${k}". Known: ${[...known].join(", ")}. ` +
        `Prefix a key with _ to make it a comment.`);
      process.exit(1);
    }
  }
  return out;
}

// The one place a viewport list is decided, so design.mjs, review.mjs and uijourney.mjs cannot
// disagree about what "both widths" means. An explicit --widths always wins: the setting is a
// default for the common case, not a lock.
export const VIEWPORTS = { desktop: 1440, mobile: 390 };
export function defaultWidths(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--widths");
  if (i >= 0 && argv[i + 1]) return argv[i + 1].split(",").map((n) => +n.trim()).filter(Boolean);
  if (argv.includes("--mobile")) return [VIEWPORTS.desktop, VIEWPORTS.mobile];
  return settings().mobile ? [VIEWPORTS.desktop, VIEWPORTS.mobile] : [VIEWPORTS.desktop];
}

// --project beats EM_PROJECT beats project.json. The flag exists so a one-off run can target
// another project without editing config; the config exists so the normal case never repeats
// itself. With one kit per project the config is what you actually use.
export function tryProjectRoot(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--project");
  if (i >= 0 && argv[i + 1]) return { root: resolve(argv[i + 1]), from: "--project" };
  if (process.env.EM_PROJECT) return { root: resolve(process.env.EM_PROJECT), from: "EM_PROJECT" };
  const cfg = readConfig();
  if (cfg?.project) return { root: resolve(KIT, cfg.project), from: "project.json", name: cfg.name };
  return null;
}

// For tools that cannot do anything useful without a project. The error names all three ways in,
// because "no project configured" with no remedy is the kind of message that costs ten minutes.
export function projectRoot(argv = process.argv.slice(2)) {
  const r = tryProjectRoot(argv);
  if (!r) {
    console.error(
      "no project configured for this kit copy.\n" +
      "  node tools/project.mjs init --project <path-to-your-project>\n" +
      "or pass --project <path> for a one-off run, or set EM_PROJECT.\n" +
      // project.json is gitignored, so a fresh clone has none and nothing shows what may go in it.
      // Naming the template here is the cheapest possible discovery: this is the exact moment
      // somebody is looking for the file.
      "\nproject.json is gitignored — copy project-template.json to project.json to see every\n" +
      "setting with what it costs, or just run init and edit it afterwards.");
    process.exit(2);
  }
  if (!existsSync(r.root)) {
    console.error(`project folder does not exist: ${r.root}  (from ${r.from})\n` +
      `  node tools/project.mjs init --project "${r.root}"`);
    process.exit(1);
  }
  return r.root;
}

// The system's name. With the <system> folder level dropped, the project IS the system — so this
// is the fallback a model cell's system= overrides, not the other way round.
export function projectName(argv = process.argv.slice(2)) {
  const r = tryProjectRoot(argv);
  return r?.name ?? (r ? basename(r.root) : null);
}

export const paths = (argv = process.argv.slice(2)) => {
  const root = projectRoot(argv);
  return {
    root,
    inbox: join(root, "inbox"),
    diagrams: join(root, "diagrams"),
    designs: join(root, "designs"),
    build: join(root, "build"),
    generated: join(root, "generated"),
  };
};

// --- inbox ---------------------------------------------------------------------------------------
//
// The inbox is the phase-0 baseline specification: whatever the developer already has — a brief, a
// mail thread, a screenshot of a competitor, a signed-off PDF. Phase 0 reads it instead of starting
// from an empty prompt, and the developer extends it in chat.
//
// The point of indexing rather than just globbing is the third column. A .docx or .msg reads as a
// perfectly ordinary file in a folder listing and is silently unreadable, so a model would quietly
// skip it and nobody would know a requirement had been dropped.

const READ_DIRECT = new Set([".md", ".txt", ".markdown", ".csv", ".json", ".yaml", ".yml",
                             ".eml", ".html", ".htm", ".xml", ".log", ".rst", ".adoc"]);
const READ_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const READ_TOOL = new Set([".pdf"]);
const UNREADABLE = new Map([
  [".docx", "export to .md or .pdf"], [".doc", "export to .md or .pdf"],
  [".xlsx", "export the relevant sheet to .csv"], [".xls", "export the relevant sheet to .csv"],
  [".pptx", "export to .pdf"], [".ppt", "export to .pdf"],
  [".msg", "save the mail as .eml or paste the text into a .md"],
  [".zip", "unpack it into inbox/"], [".7z", "unpack it into inbox/"], [".rar", "unpack it into inbox/"],
]);

export function indexInbox(dir) {
  const out = [];
  const walk = (d, rel = "") => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name === "README.md") continue;
      const full = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) { walk(full, r); continue; }
      const ext = extname(name).toLowerCase();
      const how =
        READ_DIRECT.has(ext) ? { how: "read", note: "plain text — Read it" } :
        READ_IMAGE.has(ext) ? { how: "read", note: "image — Read shows it" } :
        READ_TOOL.has(ext) ? { how: "read", note: "PDF — Read with a `pages` range" } :
        UNREADABLE.has(ext) ? { how: "blocked", note: UNREADABLE.get(ext) } :
        { how: "unknown", note: "unrecognised extension — try Read, say so if it fails" };
      out.push({ path: r, bytes: statSync(full).size, ...how });
    }
  };
  walk(dir);
  return out;
}

// --- cli -----------------------------------------------------------------------------------------
//
// Everything above is imported by the other tools, so the CLI must not run on import — an
// unguarded `process.exit(2)` at module scope would take down every tool that reads a path.

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (!cmd || !["init", "where", "inbox", "palette", "encoding", "findings"].includes(cmd)) {
  console.error("usage:\n" +
    "  node tools/project.mjs init    [--project <path>] [--name <name>]\n" +
    "  node tools/project.mjs where   [--project <path>]\n" +
    "  node tools/project.mjs inbox   [--project <path>]\n" +
    "  node tools/project.mjs palette [--project <path>]   # do the three copies still agree?\n" +
    "  node tools/project.mjs encoding [<dir>]             # double-encoded UTF-8, and a BOM");
  process.exit(2);
}

// --- mojibake ---------------------------------------------------------------------------------
//
// TWICE NOW, A POWERSHELL ROUND TRIP HAS SILENTLY DOUBLE-ENCODED A TRACKED FILE, and nothing in this kit
// could see either one. `Get-Content -Raw` reads as the ANSI codepage and `Set-Content` writes UTF-8, so
// every non-ASCII byte is re-encoded as its CP1252 character.
//
//   1. a MODEL: every `—` became mojibake, while `drawio.mjs check` reported OK and `model.mjs validate`
//      passed at 0 errors. Only reading a label showed it.
//   2. `tools/codegen.mjs`: 364 sequences across 340 lines. `node` ran the file, `codegen` produced
//      byte-correct output, all eight suites stayed green. The only tell was mojibake in console PROSE.
//
// So neither the compiler, the validator, nor any test can catch this class — which is exactly why it needs
// its own cheap check rather than a note telling people to be careful.
//
// GIT-DRIVEN, so it covers the kit's own tools and docs and not just a project's models — instance 2 was in
// `tools/`. Takes an optional directory so it can be pointed at a project too.
// --- the two documents' own structural integrity ------------------------------------------------
//
// A REWRITE SCRIPT DUPLICATED 1166 LINES OF KIT-FINDINGS AND NOTHING COULD SEE IT. It guarded
// `start < 0 || end < 0` but not `end < start`, the anchor occurred earlier in the file, and the slice
// duplicated everything between: two copies of BP14, BP3, BP4 and BP12, 1815 -> 2980 lines. Markdown does
// not validate, no test reads these files, and the duplicate was internally consistent — it was found by
// grepping one heading and seeing two line numbers come back. KIT-HISTORY BR6.
//
// So: the cheap structural facts, checked. Not a linter — four things that are true by construction and
// whose violation means an edit went wrong.
if (cmd === "findings") {
  const DOCS = ["KIT-FINDINGS.md", "KIT-HISTORY.md"];
  // `.replace(/\r$/, "")` because in JavaScript `.` DOES NOT MATCH `\r`, so `(.+)$` cannot match a heading
  // on a CRLF line — every file here is CRLF. That exact mistake made a scan report zero headings and
  // therefore zero findings, cleanly. KIT-HISTORY BR5.
  const problems = [];
  const notes = [];
  // The four ids that genuinely head two sections each, from the A/B runs that predate CLAUDE.md's
  // "finding IDs are stable and never reused". Historical, out of scope to renumber, and listed by name so
  // no modern id can hide behind the same excuse.
  const LEGACY = new Set(["B0", "B1", "B2", "B3"]);
  for (const doc of DOCS) {
    const f = join(KIT, doc);
    if (!existsSync(f)) { problems.push(`${doc}: missing`); continue; }
    const lines = readFileSync(f, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));

    // 1. A FINDING ID HEADS AT MOST ONE SECTION. The direct form of the BR6 check.
    //
    //    THREE LEGITIMATE PATTERNS THE FIRST VERSION FLAGGED, and each is why the bar here is "a rule never
    //    produces a false positive":
    //      * `## BP4 (part)` and `## BP4 (part 2)` — a finding continued in a second section, on purpose.
    //      * `## B0-FIXED —` yielded the id `B0`, colliding with the real `## B0 —`. The id must be
    //        followed by ` —` or ` (part`, not by more identifier.
    //      * `B0`/`B1`/`B2`/`B3` genuinely head two sections each, from the A/B runs that PREDATE
    //        CLAUDE.md's "IDs are stable and never reused" rule. Real, historical, and not this session's.
    //        Reported as a note under the modern scheme rather than a failure nobody can act on.
    const ids = new Map();
    lines.forEach((l, i) => {
      const m = /^#{1,4}\s+(?:~~)?([A-Z]{1,3}[0-9]{1,3}[a-z]?)(?= —| \(part|—)/.exec(l);
      if (!m) return;
      const cont = /\(part/.test(l);
      if (!ids.has(m[1])) ids.set(m[1], { at: [], primary: 0 });
      ids.get(m[1]).at.push(i + 1);
      if (!cont) ids.get(m[1]).primary++;
    });
    for (const [id, e] of ids) {
      if (e.primary <= 1) continue;                    // continuations are fine; two PRIMARIES are not
      // NAMED, NOT PATTERN-MATCHED. The first version used `/^[A-Z][0-9]/` — "single-letter prefix" — and
      // that demotes V1..V28, Z5 and T1b as well, which are modern ids whose duplication WOULD be a defect.
      // Caught by the control: the deliberate BR6 tamper duplicated thirty V-ids and every one came back as
      // a note. The collisions are a fixed historical fact, so they are listed rather than inferred.
      const legacy = LEGACY.has(id);
      const msg = `${doc}: finding id ${id} heads ${e.primary} sections — lines ${e.at.join(", ")}`;
      if (legacy) notes.push(`${msg}   (A/B-run numbering, predates "ids are never reused")`);
      else problems.push(msg);
    }

    // NO RULE ABOUT AN ID IN BOTH DOCUMENTS. The first version had one and it was WRONG: the kit's
    // convention is a struck-through POINTER heading in KIT-FINDINGS beside the full entry in KIT-HISTORY —
    // `### BP1 — ~~…~~ · FIXED — moved to KIT-HISTORY.md`. It reported 22 of those as half-finished moves,
    // i.e. it flagged the documented practice. Deleted rather than heuristically narrowed.

    // 3. FENCES BALANCE. An unclosed ``` swallows every heading after it, which is how a document can look
    //    fine in a diff and render as one code block.
    const fences = lines.filter((l) => /^```/.test(l)).length;
    if (fences % 2) problems.push(`${doc}: ${fences} \`\`\` fences — odd, so one is unclosed`);

    // 4. NO REPEATED BLOCK OF CONSECUTIVE LINES. The general form of BR6: a duplicated span leaves a long
    //    run of identical prose. Cheap to spot by hashing windows, and it catches a duplication that
    //    happened to avoid repeating a heading.
    const W = 25;
    const seen = new Map();
    const body = lines.filter((l) => l.trim().length > 40);   // ignore blanks, short lines, table rules
    for (let i = 0; i + W <= body.length; i++) {
      const k = body.slice(i, i + W).join("\n");
      if (seen.has(k)) { problems.push(`${doc}: ${W} consecutive substantial lines repeat verbatim — a duplicated span`); break; }
      seen.set(k, i);
    }
  }

  console.log(`findings — structural integrity of ${DOCS.join(" and ")}`);
  for (const p of problems) console.log(`  ${p}`);
  for (const n of notes) console.log(`  note  ${n}`);
  if (!problems.length) {
    console.log(`  no duplicate finding ids, fences balanced, no repeated span of ${25} substantial lines.`);
    console.log(`  (Clean means something because the check is provably able to fire — see kit-test tier 2.)`);
  }
  process.exit(problems.length ? 1 : 0);
}

if (cmd === "encoding") {
  const where = argv[1] && !argv[1].startsWith("--") ? resolve(argv[1]) : KIT;
  const tracked = execFileSync("git", ["-C", where, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter((f) => /\.(mjs|md|cs|drawio|json|html|css|ts|tsx|yml|yaml|conf|txt)$/.test(f));
  // THE SIGNATURES, WRITTEN AS ESCAPES SO THIS FILE STAYS PURE ASCII. Spelling them literally made the
  // check flag its own source, which is a genuine failure mode for a detector: it could not describe the
  // thing it detects without becoming a false positive.
  //   \u00e2\u20ac  the lead bytes of every double-encoded dash and curly quote (E2 80 xx read as CP1252)
  //   \u00c2 + punct  NBSP and \u00b7, the C2 xx range
  //   \u00c3 + cont   accented Latin, the C3 xx range
  //   \ufffd          a NON-reversible mis-decode: the original bytes are gone, so this is the worse case
  const SIG = new RegExp("\u00e2\u20ac|\u00c2[\\s\u00b7\u00bb\u00ab]|\u00c3[\u0080-\u00bf]|\ufffd");
  // ACKNOWLEDGEMENT, in this kit's house style — the same shape as `joins="none"` and `ingested="true"`.
  // Four lines across CLAUDE.md and KIT-HISTORY.md legitimately QUOTE mojibake while documenting the trap,
  // and a check that cannot tell a specimen from an infection would be turned off within a week. A line is
  // exempt when it also names what it is showing.
  const EXEMPT = /mojibake|CP1252|double-encod/i;
  const hits = [];
  for (const f of tracked) {
    let text;
    try { text = readFileSync(join(where, f), "utf8"); } catch { continue; }   // submodule/sparse: not ours
    if (text.charCodeAt(0) === 0xfeff) hits.push({ f, line: 1, what: "BOM (Set-Content -Encoding utf8 adds one)" });
    text.split("\n").forEach((l, i) => {
      if (SIG.test(l) && !EXEMPT.test(l)) hits.push({ f, line: i + 1, what: l.trim().slice(0, 90) });
    });
  }
  console.log(`encoding — ${tracked.length} tracked text file(s) under ${where}`);
  for (const h of hits) console.log(`  ${h.f}:${h.line}\n      ${h.what}`);
  if (!hits.length) {
    console.log(`  no double-encoded sequences, no U+FFFD, no BOM.`);
    console.log(`  (A clean result here is only meaningful because the check is provably able to fire —`);
    console.log(`   see kit-test tier 2, which plants one on a copy.)`);
  } else {
    console.log(`\n${hits.length} occurrence(s). Reverse a CP1252 round trip by stripping the BOM and mapping`);
    console.log(`CP1252's UNDEFINED bytes (0x81 0x8D 0x8F 0x90 0x9D) to themselves — a plain latin1 pass fails.`);
    console.log(`Verify the transform as a dry run and refuse to write if any character has no CP1252 byte.`);
  }
  process.exit(hits.length ? 1 : 0);
}

// --- palette drift ---------------------------------------------------------------------------
//
// The draw.io settings are WINDOW-scoped, which forces three copies of the same values: the
// .code-workspace (the only one a multi-root window reads), the kit's own .vscode/settings.json
// (for opening the kit alone), and the project's (for opening the project alone, without the kit).
// They have drifted once already — the workspace file sat on six colours while the kit had eight,
// so the external-event yellow and the GWT grey were simply missing from the picker, and a
// hand-coloured cell would then be classified wrong by the em= fallback. Hence a check.

const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");
const readJsonc = (f) => { try { return JSON.parse(stripComments(readFileSync(f, "utf8"))); } catch { return null; } };
const paletteKeys = (o) => Object.fromEntries(
  Object.entries(o ?? {}).filter(([k]) => k.startsWith("hediet.vscode-drawio.") || k === "files.associations"));

if (cmd === "palette") {
  // THE CANONICAL FILE IS CHECKED FIRST, and without this the whole command was vacuous. `readJsonc`
  // returns null on a parse failure and `paletteKeys(null)` is `{}` — so a malformed or missing
  // templates/drawio-settings.json gave `canon` ZERO keys, every copy's diff was then empty, every copy
  // printed `ok`, and the command exited 0. **The check passed precisely because it could not read its own
  // reference.** CLAUDE.md's standing rule: a "none" is not a result until it can return "some".
  const canonRaw = readJsonc(PALETTE);
  if (!canonRaw) {
    console.error(`CANNOT READ THE CANONICAL PALETTE: ${PALETTE}`);
    console.error(`Nothing below could be compared, so this is not a clean result. Fix the file first.`);
    process.exit(2);
  }
  const canon = paletteKeys(canonRaw);
  if (!Object.keys(canon).length) {
    console.error(`THE CANONICAL PALETTE HAS NO PALETTE KEYS: ${PALETTE}`);
    console.error(`Every copy would compare equal to nothing and report ok. Refusing to answer.`);
    process.exit(2);
  }
  const proj = tryProjectRoot(argv);
  const copies = [
    ["kit  .vscode/settings.json", join(KIT, ".vscode", "settings.json")],
    ["kit  ClaudeEventModeler.code-workspace", join(KIT, "ClaudeEventModeler.code-workspace")],
    ...(proj ? [["proj .vscode/settings.json", join(proj.root, ".vscode", "settings.json")]] : []),
  ];
  let bad = 0;
  console.log(`canonical: ${PALETTE}  (${Object.keys(canon).length} key(s))\n`);
  for (const [label, f] of copies) {
    if (!existsSync(f)) { console.log(`  MISSING  ${label}`); bad++; continue; }
    const raw = readJsonc(f);
    if (!raw) { console.log(`  UNPARSED ${label}`); bad++; continue; }
    const got = paletteKeys(raw.settings ?? raw);          // .code-workspace nests under "settings"
    const diff = Object.keys(canon).filter((k) => JSON.stringify(got[k]) !== JSON.stringify(canon[k]));
    if (diff.length) { console.log(`  DRIFTED  ${label}\n             ${diff.join("\n             ")}`); bad++; }
    else console.log(`  ok       ${label}`);
  }
  if (bad) console.log(`\n${bad} copy/copies out of step. Edit ${PALETTE}, then bring the others into line.`);
  process.exit(bad ? 1 : 0);
}

if (cmd === "where") {
  const r = tryProjectRoot(argv);
  if (!r) { console.error("no project configured. Run: node tools/project.mjs init --project <path>"); process.exit(2); }
  console.log(`${r.root}${existsSync(r.root) ? "" : "   (DOES NOT EXIST)"}\n  name: ${projectName(argv)}\n  from: ${r.from}`);
  // Printed on every `where`, because a setting nobody can see is a setting nobody remembers is on.
  // Same reasoning as codegen printing every package-versions.json override on every run.
  const s = settings();
  const cfg = readConfig() ?? {};
  const src = (k) => (typeof cfg[k] === "boolean" ? "" : "  (default)");
  console.log(`  mobile:   ${s.mobile}${src("mobile")}` +
    (s.mobile ? "" : "   — design/review/ui-journey shoot the desktop width only"));
  console.log(`  kitFixes: ${s.kitFixes}${src("kitFixes")}` +
    (s.kitFixes ? "" : "   — findings are LOGGED, not fixed; nothing under the kit is edited"));
  console.log(`  demo:     ${s.demo}${src("demo")}` +
    (s.demo ? "   — one backend agent for all slices, short reports, no agent-side review loop" : ""));
  process.exit(existsSync(r.root) ? 0 : 1);
}

if (cmd === "inbox") {
  const p = paths(argv);
  const items = indexInbox(p.inbox);
  if (!items.length) {
    console.log(`${p.inbox} is empty.\n` +
      "Drop the brief, mail threads, screenshots or PDFs in there — phase 0 reads them as the baseline.");
    process.exit(0);
  }
  const blocked = items.filter((i) => i.how === "blocked");
  const kb = (n) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}k`;
  console.log(`${p.inbox} — ${items.length} file(s)\n`);
  for (const i of items) {
    const tag = i.how === "blocked" ? "BLOCKED" : i.how === "unknown" ? "unknown" : "  read ";
    console.log(`  ${tag}  ${i.path.padEnd(46)} ${kb(i.bytes).padStart(7)}  ${i.note}`);
  }
  if (blocked.length) {
    console.log(`\n${blocked.length} file(s) cannot be read as-is. Convert them, or their content is ` +
      "NOT in the baseline — and nothing downstream will notice it is missing.");
  }
  process.exit(0);
}

// --- init ------------------------------------------------------------------------------------------
//
// Idempotent, and reports "written / kept" for the same reason codegen does: re-running it on a
// live project must never clobber a file the developer has edited.

const target = flag("project", tryProjectRoot(argv)?.root);
if (!target) {
  console.error("init needs a target: node tools/project.mjs init --project <path-to-your-project>");
  process.exit(2);
}
const root = resolve(target);
const name = flag("name", basename(root));

let written = 0, kept = 0;
const put = (rel, body) => {
  const f = join(root, rel);
  if (existsSync(f)) { kept++; return; }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body, "utf8");
  written++;
};

mkdirSync(root, { recursive: true });
for (const d of DIRS) mkdirSync(join(root, d), { recursive: true });

put("inbox/README.md",
`# inbox — the phase-0 baseline

Drop anything you already have about this system in here **before** the first modelling session:
a brief, a requirements list, an exported mail thread, a screenshot, a signed-off PDF, a CSV of
the fields someone expects.

Phase 0 of the \`event-model\` skill reads this folder instead of starting from an empty prompt,
and you extend it in the chat from there. Nothing here is authoritative — it is raw input, and a
domain fact only enters the model once you have confirmed it.

\`node tools/project.mjs inbox\` (from the kit) lists what is readable. Formats that are **not**
readable as-is — .docx, .xlsx, .pptx, .msg, archives — are reported rather than skipped, because a
silently-unread requirement is worse than a missing one.
`);

put("OPEN-QUESTIONS.md",
`# Open questions — ${name}

Things the model does not settle, and things the checker cannot see.

## What the checker cannot see

A green \`validate\` run does not mean the model is right. Read this list before declaring the
completeness gate passed:

- **Missing edges.** The check verifies that every attribute drawn has a source; it cannot know
  about a connection nobody drew.
- **Per-event completeness.** A view fed by several events is satisfied if the union supplies its
  fields — it does not ask whether each event alone leaves the row coherent.
- **Delete-vs-upsert semantics.** Whether an event removes a row or revises it is not on the cell.
- **Whether the stream boundary is right.** The test is manual: read one swimlane's events aloud to
  someone from the business and see if it is a story.

## Modelling gaps raised by implementation

**Phase 2 is entitled to assume a complete model, so anything it discovers about the DOMAIN belongs
here and in front of a human.** An implementing agent that has to decide a domain fact has found a hole
in the model, not a task of its own — and a green suite over that hole is the failure mode, not the
success.

One entry per gap. \`codegen\` reports every OPEN one on every run and keeps reporting until the status
changes. That is the point: a gap that lives only in a session transcript is a gap nobody answered.

| Status | Means |
| --- | --- |
| \`OPEN\` | the model is **silent where it should speak**. The slice goes back to \`in-design\` and waits for the domain expert |
| \`NARROW\` | the model is **deliberately narrow** here — a scope decision somebody made on purpose. Not a defect, and it does not demote |
| \`RESOLVED\` | the model was changed. Say what changed, so a reader can tell this from a gap that was merely argued away |

### (none yet)

<!-- Template — copy for each gap:

### <slice> — <the question, as a domain expert would hear it>   [OPEN]
- **raised by:** backend-agent, implementing <slice>
- **the model does not say:** ...
- **so today:** what the code does in the absence of an answer, which is what makes it urgent
- **resolution:** TODO(domain-expert)
-->

## Domain questions

(none yet)
`);

put(".gitignore",
`# Derived IR — regenerate with the kit's tools/model.mjs compile
build/

# Rendered previews are build output — regenerate with the kit's tools/drawio.mjs render
*.png

# Generated design previews — regenerate with the kit's tools/design.mjs sheet
designs/index.html
designs/_shots/

# Screenshots of the BUILT software — regenerate with the kit's tools/review.mjs sheet.
# Evidence for a human reviewing a slice, not source: re-run the tool rather than committing PNGs.
review/

# .NET build output. The generated *.cs files ARE committed: their diff is how a model change
# gets reviewed.
**/bin/
**/obj/

# Vite build output and installed packages under generated/
generated/**/web/dist/
generated/**/web/.vite/
node_modules/
`);

put("CLAUDE.md",
`# ${name}

An Event Modeling project. The \`.drawio\` files under [diagrams/](diagrams/) are the single source
of truth: the semantics live on the cells as custom attributes, and everything else here is derived
from them.

\`\`\`
inbox/          raw input — the phase-0 baseline. Not authoritative.
diagrams/       the models. One .drawio per business context. _context-map.drawio is generated.
designs/        one styled HTML page per screen slug.
build/          derived IR. Gitignored, regenerate it.
generated/      the code and tests. Committed: the diff is how a model change gets reviewed.
\`\`\`

## This folder does not contain the tooling

The modelling kit is a **separate folder** — cloned once, then copied per project — and it holds
the skills, the agents, the checker and the code generator. This project is deliberately free of
any trace of it, so it can be version-controlled, shared and built without the kit present.

Run the kit's tools **from the kit folder**; they write here because this path is configured in the
kit's \`project.json\`. Ask whoever set the project up where their copy lives, or clone a fresh one.

## The rules that live with the model, not with the tooling

- Events are past tense (\`OrderPlaced\`); commands are imperative (\`PlaceOrder\`).
- Time runs left to right. A connection pointing left is an error — with one deliberate exception,
  Event → View, because a read model is fed by events later than the point it is drawn.
- A model must be readable in one render. If you have to crop it to look at it, split it.
- **The implementation cannot begin until the completeness check passes.** Every attribute on every
  element must be supplied by something connected to it.
- Slice names are unique across the project; a slice is a branch and a ticket.

[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) records what the model does not settle — including the list
of things the automated check is blind to.
`);

// The palette, so the project is legible on its own. A project opened WITHOUT the kit — by someone
// reviewing the diagrams, or after the kit copy is long gone — would otherwise get draw.io's stock
// swatches, and colour is what em= falls back to when a cell has not been annotated yet.
// Copied from templates/drawio-settings.json rather than written inline: one authored source, and
// `node tools/project.mjs palette` checks the copies still agree.
{
  const canon = JSON.parse(readFileSync(PALETTE, "utf8"));
  delete canon._comment;
  put(".vscode/settings.json", JSON.stringify(canon, null, 2) + "\n");
}

// The kit remembers the project, so nothing has to repeat the path.
//
// SETTINGS SURVIVE RE-INIT, and that is not politeness. `init` is idempotent by design and the demo
// runbook re-runs it after every `git clean` — so a wholesale rewrite here would silently erase
// `mobile` and `kitFixes` between one run and the next, and the only symptom would be a run that got
// slower and started editing tools/ again. Carry every key across except the two this command owns.
const prev = readConfig() ?? {};
const cfg = { ...prev, project: root.replace(/\\/g, "/"), name };
const hadConfig = existsSync(CONFIG);
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");

console.log(`project "${name}" at ${root}`);
console.log(`  ${written} written, ${kept} kept`);
console.log(`  ${hadConfig ? "updated" : "wrote"} ${CONFIG}`);
console.log(`\nNext: put whatever you already have into ${join(root, "inbox")}, then start an event modelling session.`);
if (!existsSync(join(root, ".git"))) console.log(`\n${root} is not a git repo yet — \`git init\` there when you want history.`);

}   // end isMain
