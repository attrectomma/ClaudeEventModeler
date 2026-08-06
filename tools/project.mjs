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
      "or pass --project <path> for a one-off run, or set EM_PROJECT.");
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

if (!cmd || !["init", "where", "inbox", "palette"].includes(cmd)) {
  console.error("usage:\n" +
    "  node tools/project.mjs init    [--project <path>] [--name <name>]\n" +
    "  node tools/project.mjs where   [--project <path>]\n" +
    "  node tools/project.mjs inbox   [--project <path>]\n" +
    "  node tools/project.mjs palette [--project <path>]   # do the three copies still agree?");
  process.exit(2);
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
  const canon = paletteKeys(readJsonc(PALETTE));
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
const cfg = { project: root.replace(/\\/g, "/"), name };
const hadConfig = existsSync(CONFIG);
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");

console.log(`project "${name}" at ${root}`);
console.log(`  ${written} written, ${kept} kept`);
console.log(`  ${hadConfig ? "updated" : "wrote"} ${CONFIG}`);
console.log(`\nNext: put whatever you already have into ${join(root, "inbox")}, then start an event modelling session.`);
if (!existsSync(join(root, ".git"))) console.log(`\n${root} is not a git repo yet — \`git init\` there when you want history.`);

}   // end isMain
