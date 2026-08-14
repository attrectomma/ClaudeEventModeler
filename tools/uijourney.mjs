#!/usr/bin/env node
// UI journeys — a browser walking a workflow ACROSS SCREENS, and the states only a click can reach.
//
//   node tools/uijourney.mjs plan     [--journey <slug>] [--json]
//   node tools/uijourney.mjs scaffold [--journey <slug>]
//   node tools/uijourney.mjs check
//
// WHY THIS EXISTS, and why it is not review.mjs with more steps.
//
// The kit had three nets under the UI and a hole between them. `model.mjs` holds displays=/inputs= to
// wireframe binds=; `design.mjs check` holds the styled page and the React port to both; `review.mjs`
// puts the built screen beside the agreed design so a human can look. Every one of those checks ONE
// SCREEN AT REST. Nothing proved you could get from the list to the modal to the created thing, and the
// pager-not-in-the-URL bug — `/` and `/?page=2` rendering identically, so a page could not be linked,
// bookmarked or survive a refresh — was found by SCREENSHOTTING, past 32 passing tests, because a
// screenshot of a URL cannot press a button.
//
// The backend got its answer first: `journey` walks several slices end to end through the real API, and
// its one rule is that no step may append an event. This is the same layer on the other side of the
// wire, and it has the same shape of rule (see the spec banner: no step may fake the backend, and no
// step may skip the navigation it is meant to be testing).
//
// WHY PLAYWRIGHT, when CLAUDE.md says "no Playwright, no Puppeteer".
// That sentence is about `design.mjs`, and it is still right there: shooting a URL needs nothing but the
// Chrome already on the machine. A journey CLICKS, and nothing on this machine clicks. Three things come
// with it that are not conveniences:
//   * a real 390px layout viewport from device metrics, so the sub-500px lie A1 documents does not need
//     the iframe workaround at all;
//   * retrying assertions, which is the only way to say "eventually consistent" out loud instead of
//     confusing it with broken — the UI half of the async-daemon wait a backend journey needs;
//   * a trace of a failing run, which is what a human reads when a journey breaks in a slice nobody
//     touched.
// The cost is one devDependency in the PROJECT's web package. It runs against the installed Chrome or
// Edge by channel, so there is no browser download.
//
// WHAT IS DERIVED HERE AND WHAT IS NOT. Everything this file prints comes off the compiled IR: which
// journeys are named, which screens their slices act on, which data-em selectors those screens are
// allowed to have, which rule names a rejection can surface, and which wire shape enforce= says that
// rejection arrives in. What the model CANNOT hold is how a user reaches a screen — that a modal opens
// from the list, that a detail page opens from a row. `plan` names that gap per screen and asks; it does
// not guess, and there is no attribute for it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename, relative, resolve } from "node:path";
import { projectRoot, projectName, settings } from "./project.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

if (!cmd || !["plan", "scaffold", "check"].includes(cmd)) {
  console.error("usage:\n" +
    "  node tools/uijourney.mjs plan     [--journey <slug>] [--json]\n" +
    "  node tools/uijourney.mjs scaffold [--journey <slug>]\n" +
    "  node tools/uijourney.mjs check\n\n" +
    "  plan      what the model says a UI journey would walk, and what it cannot say\n" +
    "  scaffold  the playwright config, the shot helper, and one spec per journey\n" +
    "  check     the reports — a spec that fakes its backend, skips its navigation, or names a\n" +
    "            selector the model does not declare");
  process.exit(2);
}

const PROJ = projectRoot(args);
const rel = (p) => relative(PROJ, p).replace(/\\/g, "/");
// A POSITIONAL MODEL DIRECTORY, as codegen/model/architect/progress all accept. Same family as
// KIT-HISTORY BP2: hard-coding `<project>/diagrams` makes a tool unrunnable against every reference
// implementation. `--journey` and `--project` are the two flags that consume a value.
const explicitTarget = (() => {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--project" || args[i] === "--journey") { i++; continue; }
    if (args[i].startsWith("--")) continue;
    return args[i];
  }
  return null;
})();

// generated/ IS NAMED AFTER THE SYSTEM, NOT AFTER THE PROJECT FOLDER, and the two differ in the run this
// was written against — project CPOC01, system RecipeBox. The system name is a domain fact and lives on
// the model cell's system=, exactly as codegen.mjs reads it; project.json holds a filesystem path and
// could not know it. Getting this wrong looks like "the frontend has not been built yet" on a project
// where it has, which is the worst kind of wrong: plausible.
let SYSTEM = projectName(args);
let WEB, JDIR;
const SHOTS = join(PROJ, "review", "_shots");
const setSystem = (name) => {
  // pascal() to match codegen, which writes generated/<pascal(system)>. Latent until a model cell used a
  // lower-case system name; found while adding the same code to architect.mjs.
  SYSTEM = name ? pascal(name) : SYSTEM;
  WEB = join(PROJ, "generated", SYSTEM, "web");
  JDIR = join(WEB, "journeys");
};
setSystem(null);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pascal = (s) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
  .replace(/^[a-z]/, (c) => c.toUpperCase());

// --- the model, read by the one parser that owns it -----------------------------------------------
//
// Shell out to model.mjs rather than re-implementing mxGraph parsing, exactly as design.mjs check does.
// A second parser is a second thing to keep in step, and it would drift the first time a cell gained an
// attribute.

function compileModels() {
  const dir = explicitTarget ? resolve(explicitTarget) : join(PROJ, "diagrams");
  if (!existsSync(dir)) die(`${rel(dir)} does not exist. Is this project initialised?`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".drawio") && !f.startsWith("_"));
  if (!files.length) die(`no models in ${rel(dir)}.`);
  const modelPath = new URL("model.mjs", import.meta.url).pathname.replace(/^\//, "");
  return files.map((f) => {
    const p = join(dir, f);
    // --per-model: a file may be a BOARD of several models now. One entry for a one-model file.
    const r = spawnSync(process.execPath, [modelPath, "compile", p, "--per-model"], { encoding: "utf8", maxBuffer: 1 << 26 });
    if (r.status !== 0) die(`compile failed for ${f}:\n${r.stderr}`);
    return JSON.parse(r.stdout).map((ir) => ({ file: f, ir }));
  }).flat();
}

function die(msg) { console.error(msg); process.exit(1); }

// One flat world across every model in the system. A journey is a SYSTEM fact and a screen slug is
// system-wide, so both have to be resolved across the folder rather than per file.
function world() {
  const models = compileModels();
  const screens = new Map();   // slug -> { slug, label, displays, inputs, commands, feedingViews, entryDerivable }
  const slices = new Map();    // name -> { name, pattern, status, screen, commands, emits, rejections }
  const journeys = [];

  setSystem(models.map((m) => m.ir.model?.system).find(Boolean));

  for (const { file, ir } of models) {
    const byId = new Map(ir.elements.map((e) => [e.id, e]));
    const kindOf = (id) => byId.get(id)?.kind;
    const labelOf = (id) => byId.get(id)?.label;

    for (const s of ir.elements.filter((e) => e.kind === "screen")) {
      const sl = s.screen ?? slug(s.label);
      if (!screens.has(sl)) {
        screens.set(sl, {
          slug: sl, label: s.label, model: file,
          displays: new Set(), inputs: new Set(), commands: new Set(), feedingViews: new Set(),
        });
      }
      const rec = screens.get(sl);
      // displays= must agree across cells sharing a slug and inputs= may differ, so a union is right for
      // inputs and harmless for displays — model.mjs already errors if the displays disagree.
      s.displays.forEach((f) => rec.displays.add(f.name));
      s.inputs.forEach((f) => rec.inputs.add(f.name));
      for (const d of s.downstream) if (kindOf(d) === "command") rec.commands.add(labelOf(d));
      for (const u of s.upstream) if (kindOf(u) === "readmodel") rec.feedingViews.add(u);
    }

    // What feeds a view, by event LABEL — the link that makes "act here, see it there" derivable.
    const viewFeeds = new Map();
    for (const v of ir.elements.filter((e) => e.kind === "readmodel")) {
      viewFeeds.set(v.id, {
        label: v.label,
        events: new Set(v.upstream.filter((u) => ["event", "external"].includes(kindOf(u))).map(labelOf)),
      });
    }

    for (const s of ir.slices) {
      const scr = s.screens.map((id) => byId.get(id)).filter(Boolean)[0];
      slices.set(s.name, {
        name: s.name, model: file, pattern: s.pattern, status: s.status ?? "in-design",
        screen: scr ? (scr.screen ?? slug(scr.label)) : null,
        commands: s.commands.map(labelOf).filter(Boolean),
        emits: s.events.map((id) => byId.get(id)).filter((e) => e?.kind === "event").map((e) => e.label),
        // A rejection GWT is the one kind of business rule that has to reach the user's eyes, and its
        // NAME is what reaches them — the same string the failing test is called after.
        rejections: s.gwts
          .map((g) => ({ then: g.then ?? "", rule: g.rule, enforce: g.enforce }))
          .filter((g) => /^error\s*:/i.test(g.then))
          .map((g) => ({ name: g.then.replace(/^error\s*:\s*/i, "").replace(/\(.*$/, "").trim(),
                         rule: g.rule, enforce: g.enforce })),
      });
    }

    // A journey is an EXECUTABLE CHAPTER. `em="journey"` was retired into `em="chapter"` by the board
    // refactor, and the PER-MODEL ir carries `chapters` — only the folder-level ir derives a `journeys`
    // field from them. This file reads per-model (it wants each model's own edges), so it does that
    // derivation itself, filtered exactly as model.mjs filters it: a chapter with no then= is a grouping
    // of slices and not a walk, so it generates no test at either level.
    for (const j of (ir.chapters ?? []).filter((x) => x.chapter && x.gwt?.then)) {
      journeys.push({ name: j.chapter, model: file, label: j.label ?? null,
                      slices: j.slices, then: j.gwt.then ?? null });
    }
    // viewFeeds is PER MODEL and `screens` is cross-model, so this walks every screen found so far and
    // resolves only the view ids this model knows. That looks like a bug worth "fixing" and is not: a cell
    // id only ever appears in its own model's edges, so a screen from another model simply matches nothing
    // here and gets filled in on its own model's pass. Narrowing the loop to this model's screens would
    // need a second index and buy nothing.
    for (const rec of screens.values()) {
      for (const vid of rec.feedingViews) if (viewFeeds.has(vid)) {
        rec.fedByEvents ??= new Set();
        for (const e of viewFeeds.get(vid).events) rec.fedByEvents.add(e);
        rec.viewLabels ??= new Set();
        rec.viewLabels.add(viewFeeds.get(vid).label);
      }
    }
  }

  for (const rec of screens.values()) {
    rec.fedByEvents ??= new Set();
    rec.viewLabels ??= new Set();
    // A screen that shows nothing and is fed by no view cannot be reached by following the data. That is
    // not a defect — it is what a modal or a blank create form looks like in the model — but it is
    // exactly the screen whose entry has to be STATED, because nothing derives it.
    rec.entryDerivable = rec.displays.size > 0 && rec.viewLabels.size > 0;
  }
  return { screens, slices, journeys };
}

// --- candidate flows: the model does say "act here, see it there" ---------------------------------
//
// Slice A leads to slice B when an event A appends feeds a view that feeds B's screen. That is a real
// edge in the drawing, not a guess: it is the View pattern read forwards. The second relation is two
// slices sharing a screen slug, which is one page offering two affordances — create then correct.
//
// This produces CANDIDATES and never a journey. Which story is worth walking is a domain answer, and
// the same reasoning that keeps `journey` from inventing one keeps this from inventing one: the output
// is a ready-to-paste slice.mjs command for a human to choose from.

function candidates({ screens, slices }) {
  const withScreen = [...slices.values()].filter((s) => s.screen);
  const leads = new Map(withScreen.map((s) => [s.name, new Set()]));
  for (const a of withScreen) {
    if (!a.emits.length) continue;
    for (const b of withScreen) {
      if (a.name === b.name) continue;
      const scr = screens.get(b.screen);
      if (!scr) continue;
      if (a.emits.some((e) => scr.fedByEvents.has(e))) leads.get(a.name).add(b.name);
    }
  }

  // Simple paths, 2..4 slices. Longer than four is a suite nobody keeps working, which is the same
  // judgement `journey` makes about thirty journeys.
  const paths = [];
  const walk = (path) => {
    if (path.length >= 2) paths.push([...path]);
    if (path.length === 4) return;
    for (const next of leads.get(path[path.length - 1]) ?? []) {
      if (!path.includes(next)) walk([...path, next]);
    }
  };
  for (const s of withScreen) walk([s.name]);

  // Keep maximal paths only: a 3-step story subsumes its own first two steps, and printing both reads
  // as two suggestions when it is one.
  const maximal = paths.filter((p) => !paths.some((q) => q.length > p.length &&
    q.slice(0, p.length).join(">") === p.join(">")));

  const rank = (p) => p.filter((n) => slices.get(n).status !== "in-design").length * 10 + p.length;
  return maximal.sort((a, b) => rank(b) - rank(a));
}

// The screens a journey acts on, in order, with consecutive repeats collapsed — a walk that stays on one
// page for two steps is one page, not two.
function screenWalk(journeySlices, { slices }) {
  const out = [];
  for (const n of journeySlices) {
    const s = slices.get(n);
    if (!s?.screen) continue;
    if (out[out.length - 1]?.screen !== s.screen) out.push({ screen: s.screen, slices: [n] });
    else out[out.length - 1].slices.push(n);
  }
  return out;
}

// --- plan ------------------------------------------------------------------------------------------

if (cmd === "plan") {
  const w = world();
  const only = flag("journey");
  const named = w.journeys.filter((j) => !only || j.name === only);

  if (has("json")) {
    console.log(JSON.stringify({
      system: SYSTEM,
      journeys: named.map((j) => planOf(j, w)),
      candidates: named.length ? [] : candidates(w).map((p) => ({ slices: p })),
    }, null, 2));
    process.exit(0);
  }

  console.log(`ui journey plan — ${SYSTEM}`);
  if (!existsSync(WEB)) {
    console.log(`\n  ${rel(WEB)} does not exist, so there is no UI to walk yet. A UI journey needs at`);
    console.log(`  least two slices whose screens have been ported by the frontend agent.`);
  }

  if (only && !named.length) die(`\nno journey called "${only}". Named journeys: ${w.journeys.map((j) => j.name).join(", ") || "none"}`);

  if (!named.length) {
    const cands = candidates(w);
    console.log(`\nNO JOURNEY IS NAMED ON THE MODEL, so there is nothing to walk yet.`);
    console.log(`\nA journey is a cell, never a file and never a list in a test — and which story is worth`);
    console.log(`walking is a domain answer that nothing here may invent. What the model DOES say is which`);
    console.log(`slices can follow one another: slice A leads to slice B when an event A appends feeds a`);
    console.log(`view that feeds B's screen. Those candidates, best first:\n`);
    if (!cands.length) {
      console.log(`  none. No slice's event feeds a view that feeds another slice's screen, so every screen`);
      console.log(`  in this system stands alone and a UI journey has nothing to compose. That is the honest`);
      console.log(`  answer for a backend-only system, and for one screen with one slice behind it.`);
    }
    for (const p of cands.slice(0, 10)) {
      const unbuilt = p.filter((n) => w.slices.get(n).status === "in-design");
      const scr = screenWalk(p, w).map((s) => s.screen).join(" -> ");
      console.log(`  ${p.join(" -> ")}`);
      console.log(`     screens: ${scr}${unbuilt.length ? `   (still in-design: ${unbuilt.join(", ")})` : ""}`);
      console.log(`     node tools/slice.mjs journey diagrams/${w.slices.get(p[0]).model} --journey <slug> \\`);
      console.log(`          --slices "${p.join(", ")}" --then "<View(field=value)>"`);
    }
    console.log(`\nName one, then run this again. The same cell scaffolds the BACKEND journey test, so a`);
    console.log(`story named once is walked at both levels — through HTTP by \`journey\`, through the`);
    console.log(`browser by \`ui-journey\`.`);
    process.exit(0);
  }

  for (const j of named) {
    const p = planOf(j, w);
    console.log(`\n${"=".repeat(96)}\njourney "${p.name}"${p.label ? ` — ${p.label}` : ""}`);
    console.log(`  slices:  ${p.slices.join(" -> ")}`);
    console.log(`  outcome: ${p.then ?? "(none stated — journey-needs-then)"}`);
    console.log(`  spec:    ${rel(join(JDIR, `${p.name}.journey.spec.ts`))}${p.specExists ? "" : "   NOT WRITTEN YET"}`);

    if (!p.screens.length) {
      console.log(`\n  NOT A UI JOURNEY. None of its slices has a screen, so there is nothing for a browser`);
      console.log(`  to walk. This story is a backend journey and only a backend journey — see the \`journey\``);
      console.log(`  skill. That is a legitimate answer, not a gap.`);
      continue;
    }
    if (p.screens.length < 2) {
      console.log(`\n  ONE SCREEN ONLY. Every step acts on "${p.screens[0].screen}", so this walks affordances`);
      console.log(`  on one page rather than a workflow across screens. Still worth walking — a modal over a`);
      console.log(`  list is exactly this shape — but say so, and do not claim it covers navigation.`);
    }

    console.log(`\n  THE WALK`);
    for (const [i, s] of p.screens.entries()) {
      console.log(`   ${i + 1}. ${s.screen}   (${s.slices.join(", ")})`);
      console.log(`      design:    ${s.design}`);
      console.log(`      displays:  ${s.displays.join(", ") || "(nothing — this screen shows no server data)"}`);
      console.log(`      inputs:    ${s.inputs.join(", ") || "(none)"}`);
      console.log(`      actions:   ${s.commands.join(", ") || "(none)"}`);
      console.log(`      selectors: ${s.selectors.join("  ") || "(none)"}`);
      if (!s.entryDerivable) {
        console.log(`      HOW DOES THE USER GET HERE? Nothing derives it: this screen shows no view data, so`);
        console.log(`      no event chain leads to it. It is a modal, a blank form, or the entry point. The`);
        console.log(`      model has no notation for navigation and this file will not invent one — state the`);
        console.log(`      answer in the spec's own doc comment, which then becomes the only place it lives.`);
      }
    }

    if (p.rejections.length) {
      console.log(`\n  RULE NAMES THE UI MUST BE ABLE TO SURFACE`);
      console.log(`  A rejection's rule name is what a user sees and what the failing test is called after, so`);
      console.log(`  asserting the name in the browser ties the two together. It is always in title; what each`);
      console.log(`  rejection carries IN ADDITION is what differs:`);
      for (const r of p.rejections) {
        const shape = r.enforce === "periphery"
          ? `title + errors.<Field>: ["${r.name}"]   (FluentValidation, before any stream is read — names the input)`
          : `title + detail: "…"   (ProblemDetails from the decider — prose, names no field)`;
        console.log(`    ${r.name.padEnd(28)} ${shape}`);
        if (r.rule) console.log(`      ${r.rule}`);
      }
    }

    const unbuilt = p.slices.filter((n) => w.slices.get(n)?.status === "in-design");
    if (unbuilt.length) {
      console.log(`\n  STILL IN-DESIGN: ${unbuilt.join(", ")}. A journey over a slice nobody has built fails for`);
      console.log(`  reasons that have nothing to do with composition.`);
    }
  }

  console.log(`\nnext: node tools/uijourney.mjs scaffold${only ? ` --journey ${only}` : ""}`);
  process.exit(0);
}

function planOf(j, w) {
  const walk = screenWalk(j.slices, w);
  return {
    name: j.name, label: j.label, slices: j.slices, then: j.then, model: j.model,
    specExists: existsSync(join(JDIR, `${j.name}.journey.spec.ts`)),
    screens: walk.map((s) => {
      const scr = w.screens.get(s.screen) ?? { displays: new Set(), inputs: new Set(), commands: new Set() };
      const displays = [...scr.displays], inputs = [...scr.inputs], commands = [...scr.commands];
      return {
        screen: s.screen, slices: s.slices, design: `designs/${s.screen}.html`,
        displays, inputs, commands,
        views: [...(scr.viewLabels ?? [])],
        entryDerivable: Boolean(scr.entryDerivable),
        // THE SELECTORS, and the reason a UI journey needs no test ids at all. data-em / data-em-input /
        // data-em-action are already in the shipped React, already derived from the model, and already
        // held to it by design.mjs check in both directions. Anything else a spec reaches for is a
        // selector nothing keeps honest.
        selectors: [
          ...displays.map((f) => `[data-em="${f}"]`),
          ...inputs.map((f) => `[data-em-input="${f}"]`),
          ...commands.map((c) => `[data-em-action="${c}"]`),
        ],
      };
    }),
    rejections: j.slices.flatMap((n) => w.slices.get(n)?.rejections ?? []),
  };
}

// --- scaffold --------------------------------------------------------------------------------------
//
// Same emit/scaffold split codegen.mjs uses, and for the same reason. The shot helper is fully
// determined by the model and by review.mjs's naming, so it is OVERWRITTEN. The config carries a real
// decision — which origin counts as the app — and every spec is judgement from its second line on, so
// both are KEPT once they exist.

const written = [], keptFiles = [];
function emit(p, body) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body, "utf8"); written.push(p); }
function scaffoldFile(p, body) {
  if (existsSync(p)) { keptFiles.push(p); return; }
  mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body, "utf8"); written.push(p);
}

if (cmd === "scaffold") {
  const w = world();
  const only = flag("journey");
  const named = w.journeys.filter((j) => (!only || j.name === only));
  if (!named.length) die(`no journey is named on the model${only ? ` called "${only}"` : ""}. Run \`plan\` first — it lists the candidates and the command that names one.`);
  if (!existsSync(WEB)) die(`${rel(WEB)} does not exist. The web app is the frontend agent's, and a UI journey needs it built.`);

  const walkable = named.filter((j) => screenWalk(j.slices, w).length);
  const backendOnly = named.filter((j) => !screenWalk(j.slices, w).length);

  emit(join(JDIR, "_shot.ts"), shotHelper());
  emit(join(JDIR, "tsconfig.json"), journeyTsconfig());
  scaffoldFile(join(WEB, "playwright.config.ts"), pwConfig());
  for (const j of walkable) scaffoldFile(join(JDIR, `${j.name}.journey.spec.ts`), spec(planOf(j, w)));

  for (const p of written) console.log(`  written  ${rel(p)}`);
  for (const p of keptFiles) console.log(`  kept     ${rel(p)}`);
  console.log(`\n${written.length} written, ${keptFiles.length} kept (already filled in)`);
  for (const j of backendOnly) {
    console.log(`\n  "${j.name}" has no screen on any of its slices, so nothing was scaffolded for it. It is a`);
    console.log(`  backend journey and only a backend journey — that is an answer, not a gap.`);
  }

  const pkg = join(WEB, "package.json");
  const pkgSrc = existsSync(pkg) ? readFileSync(pkg, "utf8") : "";
  const need = ["@playwright/test", "@types/node"].filter((d) => !pkgSrc.includes(`"${d}"`));
  if (need.length) {
    console.log(`\nMISSING FROM ${rel(pkg)}: ${need.join(", ")}. Add them THERE rather than in the kit — the`);
    console.log(`specs are the project's, committed with the rest of generated/, and the project must outlive`);
    console.log(`whichever copy of the kit built it. @types/node is needed because the shot helper writes files.`);
    console.log(`\n  cd ${rel(WEB)} && npm i -D ${need.join(" ")}`);
    console.log(`\nNo browser download is needed — the config runs the installed Chrome or Edge by channel.`);
  }
  console.log(`\nthen, from ${rel(WEB)}:`);
  console.log(`  npx tsc -p journeys --noEmit        # Playwright transpiles but does NOT typecheck`);
  console.log(`  npx playwright test`);
  console.log(`and:  node tools/uijourney.mjs check`);
  process.exit(0);
}

// --- check -----------------------------------------------------------------------------------------
//
// The report family, and it is a REPORT rather than a repair for the reason CLAUDE.md gives twice: a
// generator that edits inside a file somebody else owns destroys hand-written work. Every one of these
// names a file and what to change.
//
// Each check exists because of a measured incident. Where it is one of the kit's own, the finding is
// cited — a check whose reason nobody remembers is the first one somebody deletes.

if (cmd === "check") {
  const w = world();
  const problems = [];
  const notes = [];
  const specs = existsSync(JDIR)
    ? readdirSync(JDIR).filter((f) => f.endsWith(".journey.spec.ts")).map((f) => join(JDIR, f))
    : [];

  const walkable = w.journeys.filter((j) => screenWalk(j.slices, w).length);
  const missing = walkable.filter((j) => !existsSync(join(JDIR, `${j.name}.journey.spec.ts`)));
  // "You have not written it yet" already says everything, so do not also tell someone that a test they
  // have not written has taken no screenshots.
  const unwritten = new Set();

  for (const p of specs) {
    const raw = readFileSync(p, "utf8");
    // STRIP COMMENTS AND STRING LITERALS BEFORE MATCHING, for the reason codegen.mjs learned the hard
    // way: the scaffold's own banner says "no page.route", so a naive search reports the file the
    // generator just wrote. A report that cries wolf stops being read.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const code = src.replace(/(['"`])(?:[^\\\n]|\\.)*?\1/g, "''");
    const name = basename(p).replace(".journey.spec.ts", "");
    const j = w.journeys.find((x) => x.name === name);
    const add = (report, detail) => problems.push({ report, file: rel(p), name, detail });
    // A NOTE IS NOT A PROBLEM, and keeping them in one list would make the summary line lie. Same house
    // style as `joins="none"` and the Conway rule: report the unacknowledged case, NOTE the legitimate one
    // that a reader might still want to disagree with.
    const note = (report, detail) => notes.push({ report, file: rel(p), name, detail });

    // A SCAFFOLD NOBODY HAS FILLED IN IS NOT A SPEC, and running the content checks over one reports four
    // findings about a file the tool wrote itself two minutes ago. That is the cry-wolf failure
    // KIT-FINDINGS records three times and this check committed on its first run: everything below is
    // true of the scaffold and useless, because the answer to all of it is "yes, write the test".
    // Detected by the TODO marker, the same way codegen finds an unfilled test by its stub exception.
    if (/TODO\(uijourney\)/.test(raw)) {
      add("UI JOURNEY NOT WRITTEN YET", "the scaffold's TODO(uijourney) markers are still in it, so nothing is driven and nothing is asserted");
      unwritten.add(name);
      continue;
    }

    // 1. FAKES ITS OWN BACKEND. The exact analogue of JOURNEY APPENDS ITS OWN HISTORY, and tempting for
    //    the same reason: step three fails, stubbing the response makes it pass, and the test goes on
    //    looking like a journey. The harness is the sharpest version — web/harness/ deliberately fakes
    //    transport for the states a running server cannot be asked to produce, which is right for
    //    LOOKING at a state and fatal for proving you can reach one.
    const fakes = [
      [/\bpage\.route\s*\(/, "page.route() intercepts the network"],
      [/\bcontext\.route\s*\(/, "context.route() intercepts the network"],
      [/\.fulfill\s*\(/, "route.fulfill() answers instead of the API"],
      [/\baddInitScript\s*\(/, "addInitScript() seeds state the user could not have created"],
      [/localStorage\s*\.\s*setItem/, "localStorage seeding"],
      [/\/harness\//, "the visual state harness, which fakes transport by design"],
      [/\brequest\s*\.\s*(post|put|patch|delete)\s*\(/, "an APIRequestContext write — a setup shortcut past the UI"],
    ].filter(([re]) => re.test(code)).map(([, why]) => why);
    if (fakes.length) add("UI JOURNEY FAKES ITS OWN BACKEND", fakes.join("; "));

    // 2. NEVER RELOADS. The pager bug in one line: /?page=2 and / rendered identically because the pager
    //    was component state that never reached the URL, so a page could not be linked, bookmarked or
    //    survive a refresh. 32 passing tests had not noticed and no design page could have shown it.
    //    A journey that never reloads cannot see it either. KIT-FINDINGS B3.
    if (!/\breload\s*\(/.test(code)) {
      add("UI JOURNEY NEVER RELOADS",
        "no page.reload(). Click to a state, assert the URL changed, reload, assert the state survived — that is the pager bug, and it is invisible without a reload");
    }

    // 3. IGNORES THE CONSOLE AND THE NETWORK. A wrong nginx proxy_pass prefix makes the API answer 404,
    //    and a 404 body is not a paged result — so the browser shows AN EMPTY LIST WITH NO ERROR. So does
    //    an unapplied seed, from a missing environment variable. Both are indistinguishable from "there
    //    is genuinely nothing here" unless the test is listening. KIT-FINDINGS B3 step 3, A3.
    //    watchForSilentFailure() in journeys/_shot.ts is the supplied way to do it, so accept either —
    //    the first version of this check demanded a literal page.on() and reported the scaffold, which
    //    calls the helper. A check that does not know about its own helper is worse than no check.
    if (!/\bpage\.on\s*\(|\bwatchForSilentFailure\s*\(/.test(code)) {
      add("UI JOURNEY IGNORES THE CONSOLE AND THE NETWORK",
        "neither page.on('console'|'pageerror'|'response') nor watchForSilentFailure(page). A wrong proxy prefix or an unapplied seed renders an empty screen with no error, which reads exactly like 'nothing here yet'");
    }

    // 4. ASSERTS NOTHING IT LOOKED AT. A state that was silently not being rendered at all had its
    //    screenshot taken anyway, so the shot was of the wrong thing and looked fine (KIT-FINDINGS C1).
    //    The rule that follows: a screenshot is evidence for a human, never evidence for the suite, so
    //    every shot is preceded by an assertion. Counting is crude and it catches the case that matters.
    const shots = (code.match(/\bshot\s*\(|\bscreenshot\s*\(/g) ?? []).length;
    const expects = (code.match(/\bexpect\s*\(/g) ?? []).length;
    if (!expects) add("UI JOURNEY ASSERTS NOTHING", "no expect() anywhere. A run that only takes pictures cannot fail, and a picture of a state that never rendered looks fine");
    else if (shots > expects) add("UI JOURNEY SHOOTS MORE THAN IT ASSERTS", `${shots} shot(s), ${expects} assertion(s). A shot of a state nobody asserted is a picture of an unknown thing`);

    //    AND THE OTHER HALF, which the first version of this check was missing entirely: a state asserted
    //    and never shot is a state no human can review. The suite went green and the review sheet holds
    //    nothing about it. One shot per screen walked is the floor, not the target — the states worth
    //    seeing are usually MORE than one per screen (the list, the modal over it, the rejection, page 2).
    if (j && expects) {
      const screens = screenWalk(j.slices, w).length;
      if (shots < screens) {
        add("STATES ASSERTED BUT NOT SHOT",
          `${shots} shot(s) across ${screens} screen(s) walked. An assertion is a claim only the suite can see; the shot is the only part a human reviews — so every state you assert wants one, and one per screen is the floor`);
      }
    }

    //    A SHOT WITH NO ASSERTION ABOVE IT, structurally rather than by counting. Counting catches the
    //    gross case; this catches the specific line, which is what a report has to name to be actionable.
    const lines = raw.split("\n");
    for (const [n, line] of lines.entries()) {
      if (!/\bawait\s+shot\s*\(/.test(line)) continue;
      // Look back over the step for an assertion. Five lines is the scaffold's own spacing plus slack; a
      // shot further than that from anything asserted is not proof of anything.
      const before = lines.slice(Math.max(0, n - 5), n).join("\n").replace(/^\s*\/\/.*$/gm, "");
      if (!/\bexpect\s*\(/.test(before)) {
        add("SHOT WITH NOTHING ASSERTED ABOVE IT",
          `line ${n + 1}: ${line.trim().slice(0, 70)} — no expect() in the five lines above, so this picture proves nothing. A state that was silently not rendered at all screenshotted perfectly happily`);
      }
    }

    // 5. SELECTOR NOT IN THE MODEL. The same error class design.mjs check catches on a page, at the same
    //    strictness: a spec that reaches for a field the screen does not declare is asserting on data the
    //    system cannot supply. This is why the selectors are data-em and not test ids — they are already
    //    model-derived and already checked in both directions.
    if (j) {
      const p2 = planOf(j, w);
      // SCOPED TO THE SYSTEM, NOT TO THE CHAPTER'S OWN SCREENS, and the difference is a real one.
      //
      // The rule being enforced is "no INVENTED selector" — the same class design.mjs check catches on a
      // page. The system-wide declared set enforces exactly that. Restricting it to the screens the
      // chapter's slices ACT on conflated two different things, and flagged an honest spec: a chapter's
      // stated outcome is a VIEW (`BayHealth(inService=true, openFaultCount=0)`), and the place a human
      // reads a view is a screen — which no slice of the chapter need act on, because reading is not a
      // slice. bay-out-and-back ends on bay-health for precisely that reason, using five selectors
      // bay-health declares and its own three screens do not. Those are model-derived and checked in
      // both directions by design.mjs; calling them strangers was wrong.
      //
      // The narrower fact is still worth saying, so it is said below as a NOTE rather than a violation.
      const declared = (s) => [
        ...[...s.displays].map((f) => `data-em=${f}`),
        ...[...s.inputs].map((f) => `data-em-input=${f}`),
        ...[...s.commands].map((c) => `data-em-action=${c}`),
      ];
      const allowed = new Set([...w.screens.values()].flatMap(declared));
      const onWalk = new Set(p2.screens.flatMap((s) => [
        ...s.displays.map((f) => `data-em=${f}`),
        ...s.inputs.map((f) => `data-em-input=${f}`),
        ...s.commands.map((c) => `data-em-action=${c}`),
      ]));
      const used = [...raw.matchAll(/data-em(-input|-action)?\s*=\s*\\?["']([^"'\\]+)/g)]
        .map((m) => `data-em${m[1] ?? ""}=${m[2]}`);
      const strangers = [...new Set(used.filter((u) => !allowed.has(u)))];
      if (strangers.length) add("SELECTOR NOT IN THE MODEL", `${strangers.join(", ")} — declared by no screen in this system`);

      // Which OTHER screens this spec reads, and where each selector comes from. Not a defect: it is how
      // a chapter's outcome gets asserted where a human would look at it.
      const offWalk = [...new Set(used.filter((u) => allowed.has(u) && !onWalk.has(u)))];
      if (offWalk.length) {
        const owners = [...w.screens.values()]
          .filter((s) => declared(s).some((d) => offWalk.includes(d)))
          .map((s) => s.slug)
          .filter((slug) => !p2.screens.some((s) => s.screen === slug));
        note("READS A SCREEN OFF ITS OWN WALK",
          `${offWalk.join(", ")} — declared by ${owners.join(", ") || "another screen"}, which no slice of this chapter acts on. Normal when the chapter's outcome is a View and this is where a human reads it; wrong if the walk has quietly wandered`);
      }
    }

  }

  // 6. NOT SHOT, AND NOT SHOT NARROW. A journey that clicks is the only thing in this kit that can shoot a
  //    state reachable only by clicking — a modal over a list, page 2, a rejected form, an in-flight
  //    button. If it does not put them where review.mjs looks, the human reviews exactly the
  //    URL-shootable states they already had and the expensive run bought nothing reviewable.
  //
  //    THE NARROW HALF IS ITS OWN FINDING. A1: every sub-500px shot this kit produced before shoot.mjs
  //    was a crop of a 500px layout, and it cost one wrong diagnosis plus two rounds of CSS "fixes" to a
  //    page that was already correct. Playwright gets a real 390px viewport from device metrics with no
  //    iframe, so there is no longer any excuse for a desktop-only run — and responsive navigation is
  //    precisely where getting from a list to a modal breaks. Checked against the EVIDENCE on disk
  //    rather than against words in the spec, because what matters is whether the run happened.
  const shotFiles = existsSync(SHOTS) ? readdirSync(SHOTS) : [];
  for (const j of walkable) {
    if (!existsSync(join(JDIR, `${j.name}.journey.spec.ts`)) || unwritten.has(j.name)) continue;
    const screens = screenWalk(j.slices, w).map((s) => s.screen);
    // Match the journey's own segment, not just the screen slug: two journeys may both visit one screen,
    // and "somebody shot this screen once" is not evidence that THIS walk ran.
    const mine = shotFiles.filter((f) => screens.some((s) => f.startsWith(`${s}__${j.name}-`)));
    if (!mine.length) {
      problems.push({ report: "UI JOURNEY NOT SHOT", file: rel(SHOTS), name: j.name,
        detail: `no shot of ${screens.join(", ")} in review/_shots/. The states only a click reaches are the ones review.mjs could never take — shoot them there and they land beside the design` });
    } else if (settings().mobile && !mine.some((f) => f.includes("-mobile."))) {
      problems.push({ report: "UI JOURNEY SHOT ONLY WIDE", file: rel(SHOTS), name: j.name,
        detail: `${mine.length} shot(s), none at the mobile width. Playwright's 390px viewport is honest — no iframe, no 500px crop — so a desktop-only run is a choice, and responsive navigation is where getting from a list to a modal breaks` });
    }
  }

  console.log(`ui journey check — ${SYSTEM}`);
  console.log(`  ${w.journeys.length} journey(s) named, ${walkable.length} walkable in a browser, ${specs.length} spec(s) written`);

  if (missing.length) {
    console.log(`\nNO UI JOURNEY SPEC — ${missing.length}. Named on the model, walks screens, and nothing drives it:`);
    for (const j of missing) console.log(`  ${j.name}   ->   node tools/uijourney.mjs scaffold --journey ${j.name}`);
  }

  const groupBy = (rows) => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.report)) m.set(r.report, []); m.get(r.report).push(r); }
    return m;
  };
  for (const [report, list] of groupBy(problems)) {
    console.log(`\n${report} — ${list.length}.`);
    for (const p of list) console.log(`  ${p.name}: ${p.detail}\n    ${p.file}`);
  }

  for (const [report, list] of groupBy(notes)) {
    console.log(`
note — ${report} — ${list.length}.`);
    for (const n of list) console.log(`  ${n.name}: ${n.detail}
    ${n.file}`);
  }

  if (!problems.length && !missing.length) {
    console.log(specs.length
      ? `\nnothing to report. Every spec drives the real backend, reloads, listens, asserts, and shoots.`
      : `\nnothing to report, and nothing to walk. Name a journey first: node tools/uijourney.mjs plan`);
  }
  // Reports, not a gate: the gate is `npx playwright test` going green plus a human looking at the sheet.
  // Exiting non-zero here would make "I have not written the spec yet" indistinguishable from a failure.
  process.exit(0);
}

// --- the scaffolded files --------------------------------------------------------------------------

function shotHelper() {
  return `// <auto-generated> by tools/uijourney.mjs — regenerated every run, so do not edit.
//
// SHOTS ARE THE PROOF OF AN ASSERTION, AND THE SET ON DISK IS A SNAPSHOT OF THE LAST RUN.
//
// Screenshots go where the human ALREADY REVIEWS, and under the name review.mjs already parses:
//
//     <project>/review/_shots/<screen-slug>__<journey>-<state>-<viewport>.png
//
// so \`node tools/review.mjs sheet\` puts them beside the agreed design at 1:1 with no extra step. That
// is the whole payoff of a journey that clicks: the frontend agent's documented limitation is that
// "headless Chrome screenshots a URL, it does not click", so a modal over a list, page 2, a rejected
// form and an in-flight button were states nobody could look at. They are shootable here.
//
// THE NAME CARRIES NO TIMESTAMP AND NO COUNTER, deliberately: a re-run overwrites, so the folder is
// always the last run and never an archive nobody prunes. The journey slug is in the state segment
// rather than in the slug segment because review.mjs pairs a shot with its design BY SCREEN SLUG —
// putting the journey first would break that pairing, and putting it nowhere would let two journeys
// that both visit one screen silently overwrite each other's evidence.
//
// AND OVERWRITING HAS A SHARP EDGE THAT CLEARING FIXES. If step 5 fails, steps 6-8 never shoot — so
// without clearing, the folder holds steps 1-5 from THIS run beside steps 6-8 from the LAST one, and
// reads as one coherent passing walk. That is strictly worse than accumulation, because it is
// plausible. \`clearJourneyShots\` in a beforeAll makes a missing shot MISSING.
//
// The viewport name must match tools/shoot.mjs's label(): <=600 mobile, <=1100 tablet, else desktop.
// It is derived from the project's own viewport rather than from its name, so a renamed project cannot
// silently mislabel a shot.
//
// import.meta.url rather than __dirname, because this package is "type": "module" and Playwright loads
// its tests as ESM there — __dirname does not exist and the failure is at import time, before any test.
import { test, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "${relative(JDIR, SHOTS).replace(/\\/g, "/")}");

function viewportLabel(w: number) {
  return w <= 600 ? "mobile" : w <= 1100 ? "tablet" : "desktop";
}

// The journey slug, from the SPEC FILENAME rather than from an argument or the describe title. It cannot
// drift from the file, needs no repeating in every call, and is the same string uijourney.mjs matches on.
function journeySlug() {
  return (test.info().file.split(/[\\\\/]/).pop() ?? "").replace(/\\.journey\\.spec\\.ts$/, "");
}

/**
 * Shoot the current state of the page as PROOF OF THE ASSERTION YOU JUST MADE.
 *
 * THE PAIRING IS THE POINT. An assertion is a claim the suite can check and a human cannot see; a shot
 * is the reverse. So the rule is one shot per STATE, taken immediately after the assertions that pin
 * that state — not one per assertion, because a journey asserts plenty of things no picture shows (a URL
 * that changed, a console that stayed quiet, a button that is genuinely disabled rather than merely
 * grey).
 *
 * A SHOT IS NEVER EVIDENCE FOR THE SUITE, and never an assertion. A state that was silently not being
 * rendered at all had its screenshot taken anyway and looked perfectly fine. Assert first, then shoot.
 *
 * Note this is NOT Playwright's toHaveScreenshot(): that compares against a committed pixel baseline and
 * FAILS on a diff, which is wrong here twice over — aesthetic judgement belongs to a human with
 * review.mjs, and a pixel baseline over a real app with real data is flaky by construction.
 */
export async function shot(page: Page, screen: string, state: string) {
  const w = page.viewportSize()?.width ?? 1440;
  const out = join(SHOTS, \`\${screen}__\${journeySlug()}-\${state}-\${viewportLabel(w)}.png\`);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: false });
  // The attachment goes in the HTML report, which is per-run and ephemeral and what you read when a step
  // failed. The file goes in review/, which is the snapshot a human reviews. Both, on purpose.
  await test.info().attach(\`\${screen} · \${state}\`, { path: out, contentType: "image/png" });
  return out;
}

/**
 * Throw away this journey's shots for THIS VIEWPORT before the walk starts. Call it in a beforeAll.
 *
 * Scoped to the viewport because the two projects run the same file one after the other, so clearing
 * every viewport would have the mobile run delete the desktop run's evidence. Scoped to the journey
 * because another journey's shots are not this one's to discard.
 */
export function clearJourneyShots(width: number) {
  if (!existsSync(SHOTS)) return;
  const mine = new RegExp(\`__\${journeySlug()}-.*-\${viewportLabel(width)}\\\\.png$\`);
  for (const f of readdirSync(SHOTS)) if (mine.test(f)) rmSync(join(SHOTS, f), { force: true });
}

/**
 * Fail the test on anything the browser complained about that the journey did not deliberately cause.
 *
 * WHY THIS IS NOT OPTIONAL. A wrong nginx proxy_pass prefix makes the API answer 404, and a 404 body is
 * not a paged result — so the screen renders AN EMPTY LIST WITH NO ERROR, which is indistinguishable
 * from "nothing here yet". A missing environment variable that leaves the demo seed unapplied looks
 * exactly the same. Both have happened; neither was caught by a passing suite.
 *
 * Pass \`allow\` for the requests a step means to fail — a rejected form is a 400 on purpose.
 *
 * A REQUEST THAT ALREADY GOT ITS RESPONSE IS NOT A FAILED REQUEST, and getting this wrong made the
 * guard fail on a SUCCESSFUL command. Measured: a 204 from Wolverine arrives, the caller returns
 * without reading the body (there is none to read), and Chrome then reports the request as
 * \`net::ERR_ABORTED\` about a millisecond after the 204 — because nothing ever consumed the response
 * stream. The command worked, the event was appended, the projection updated, and the journey failed.
 *
 * So an abort is only interesting when NO response was received: that is a connection refused, a DNS
 * failure, a request cancelled by a navigation mid-flight. Once a status line exists, the \`response\`
 * handler below is the thing that judges it, and judging it twice is how a green path goes red.
 *
 * Deliberately NOT solved with \`allow\`: excusing the URL would also excuse a genuine 400 from the same
 * endpoint, which is the one thing this guard most needs to see.
 */
export function watchForSilentFailure(page: Page, allow: RegExp[] = []) {
  const bad: string[] = [];
  const excused = (url: string) => allow.some((re) => re.test(url));
  page.on("console", (m) => { if (m.type() === "error") bad.push(\`console: \${m.text()}\`); });
  page.on("pageerror", (e) => bad.push(\`pageerror: \${e.message}\`));
  page.on("requestfailed", async (r) => {
    if (excused(r.url())) return;
    // null response => the request never got one, which is the real failure this is for.
    if (await r.response()) return;
    bad.push(\`requestfailed: \${r.url()} (\${r.failure()?.errorText ?? "no reason given"})\`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !excused(r.url())) bad.push(\`HTTP \${r.status()} \${r.url()}\`);
  });
  return () => bad;
}
`;
}

// PLAYWRIGHT TRANSPILES TYPESCRIPT AND DOES NOT TYPECHECK IT, so without this a type error in a spec is
// invisible until the line runs — and a journey's later steps are exactly the lines that do not run when an
// early one fails. The app's own tsconfig cannot be widened to cover this: it sets `types: ["vite/client"]`
// (so node:fs and process do not resolve) and `include: ["src", "harness", …]` (so journeys/ is outside it).
// Widening it would drag Node types into the browser build and put the specs into the frontend agent's
// `npm run typecheck` gate, which is not that agent's work. A scoped tsconfig that EXTENDS the app's keeps
// both true: the specs get checked, the app's own gate is untouched.
//
// It is emit() rather than scaffold() because every line of it is mechanical. There is no decision here.
function journeyTsconfig() {
  return `{
  "//": "<auto-generated> by tools/uijourney.mjs — regenerated every run, so do not edit.",
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "noEmit": true
  },
  "include": [".", "../playwright.config.ts"]
}
`;
}

function pwConfig() {
  return `// <auto-generated-scaffold> by tools/uijourney.mjs — yours from here on, and regeneration keeps it.
//
// TWO DECISIONS LIVE IN THIS FILE and neither is derivable, which is why it is a scaffold.
//
// 1. WHICH ORIGIN IS THE APP. The default is the Vite dev server, because that is what an implementer
//    has running. THE RUN THAT COUNTS IS THE COMPOSE ONE:
//
//        docker compose -f generated/${SYSTEM}/docker-compose.yml up -d --build
//        PW_BASE_URL=http://localhost:8080 npx playwright test
//
//    Vite proxies /api itself, so it cannot see a wrong nginx proxy_pass prefix, a missing
//    ASPNETCORE_ENVIRONMENT that leaves the seed unapplied, or a runtime that cannot do Wolverine's
//    codegen. All three have happened, and only the deployed artifact exercises them.
//
// 2. WHICH BROWSER. channel: "chrome" uses the Chrome already on this machine, so there is no
//    ~400MB browser download and the journey runs the same engine tools/shoot.mjs shoots with. Switch
//    to "msedge", or delete the channel for Playwright's bundled Chromium, if that is not true here.
//
// The mobile project is 390px of REAL layout viewport, from device metrics. tools/shoot.mjs needs an
// iframe to get that, because Windows will not make a Chrome window narrower than ~500px and Chrome
// silently lays out at 500 and crops to 390 — every sub-500px shot this kit produced before that fix
// was a lie. Playwright does not have the problem, so there is no excuse for a desktop-only run.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./journeys",
  testMatch: "**/*.journey.spec.ts",
  // A journey is expensive and it is a workflow: running its steps out of order proves nothing, and two
  // journeys writing to one database race each other. Serial, one worker, on purpose.
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // PLAYWRIGHT'S 30s DEFAULT TEST TIMEOUT SILENTLY CAPS EVERY expect() INSIDE THE TEST, and a journey
  // is longer than a test by construction — it crosses async projections, sweeps on clocks, and in this
  // kit's case a whole context boundary. Measured: a deliberate 90s wait on a cross-context hop was
  // truncated to 30s by this line's absence, and the failure read as "the data never arrived" rather
  // than "the test ran out of its own budget", which is a full debugging round in the wrong place.
  // Raise it to cover the slowest hop the walk contains; per-assertion timeouts still do the real work.
  timeout: 180_000,
  // AND BOUND THE ACTIONS, because Playwright's actionTimeout defaults to 0 — MEANING NO LIMIT. A
  // \`fill\` or \`click\` on a control that is disabled and never becomes enabled therefore waits for the
  // whole test budget and then reports the TEST as timing out, with no mention of the element. Measured:
  // three minutes of silence that read as "the browser hung", where a bounded action would have said
  // "this textarea is disabled" in fifteen seconds. A disabled control is the normal way this kit's
  // screens say "there is nothing to do here", so a journey meets one whenever it is early.
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.PW_BASE_URL ?? "http://localhost:5173",
    // actionTimeout lives HERE and not at the top level — it is a context option, not a runner one.
    actionTimeout: 15_000,
    // A failing journey may be broken in any slice it walks, or in none of them. The trace is what a
    // human reads to find out which, so keep it for the failure and throw it away for the pass.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "off",   // shots are taken deliberately by journeys/_shot.ts, where the human reviews them
  },
  projects: [
    { name: "desktop", use: { channel: "chrome", viewport: { width: 1440, height: 900 } } },${settings().mobile ? `
    { name: "mobile", use: { channel: "chrome", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },` : `
    // MOBILE IS OFF because project.json says "mobile": false. Turn it on there rather than here —
    // this file is emitted, so a project added by hand is reverted on the next scaffold, silently.
    // What it costs: a browser walk is the only check in this kit that gets a HONEST sub-500px
    // viewport (Playwright takes it from device metrics; every other shooter is an iframe inside a
    // 500px window), and responsive navigation is where getting from a list to a modal breaks.`}
  ],
});
`;
}

function spec(p) {
  const first = p.screens[0];
  const steps = p.screens.map((s, i) => `//   ${i + 1}. ${s.screen} — ${s.slices.join(", ")}`).join("\n");
  const sel = p.screens.map((s) =>
    `//   ${s.screen.padEnd(18)} ${s.selectors.join("  ") || "(no bound attribute)"}`).join("\n");
  // EVERY REJECTION CARRIES THE RULE NAME IN `title`, whichever enforcement point refused it — one
  // assertion, not two. This used to print `{ errors: { <Field>: [...] } }` for a periphery rule with no
  // title at all, which was measured false (KIT-FINDINGS BP1) and is the shape a spec would have been
  // written against. What differs is only what each carries IN ADDITION, so that is what is printed.
  const rejections = p.rejections.length
    ? p.rejections.map((r) => `//   ${r.name.padEnd(26)} title: "${r.name}"${r.enforce === "periphery"
        ? `   + errors.<Field>: ["${r.name}"]  (periphery — names the input)`
        : `   + detail: "…"  (decider — prose, names no field)`}`).join("\n")
    : "//   (none — no GWT on these slices expects a rejection)";
  const undrivable = p.screens.filter((s) => !s.entryDerivable).map((s) => s.screen);
  // THE WALK IS WHERE THE USER ACTS, AND NOT WHERE THEY ARRIVE. `slices=` orders the slices, so the
  // first screen of the walk is the first screen something HAPPENS on — which on a create-then-see story
  // is the modal, not the list you opened it from. Writing `goto("/")` above "assert you are on
  // new-recipe" is how the first version of this scaffold read, and it is wrong in the most expensive
  // way: plausible. So say which screen on this walk the data path CAN reach, and ask.
  const arrival = p.screens.find((s) => s.entryDerivable) ?? null;
  const startsElsewhere = arrival && arrival.screen !== first.screen;

  return `// <auto-generated-scaffold> by tools/uijourney.mjs — yours from here on, and regeneration keeps it.
//
// UI JOURNEY "${p.name}"${p.label ? ` — ${p.label}` : ""}
//
// Walks, in this order:
${steps}
//
// Backend outcome the model states: ${p.then ?? "(none — journey-needs-then)"}
//
// ============================================================================================
// THE ONE RULE, IN TWO HALVES. Everything here happens in the browser, as a user, in order.
//
//   NO STEP MAY FAKE THE BACKEND. No page.route, no fulfill, no addInitScript, no localStorage
//   seeding, no /harness/ state, no API call to set up step three. web/harness/ exists to make a
//   hard state LOOKABLE and it fakes transport to do it — which is right for looking and fatal
//   here, because the question is whether the state can be REACHED.
//
//   NO STEP MAY SKIP THE NAVIGATION IT IS TESTING. Reaching step three by typing its URL is the
//   exact UI equivalent of a backend journey appending its own GIVEN: the test still passes and
//   it has stopped asking the only question it was for. A deep link is legal AFTER a click has
//   proved the app produces it — which is not a loophole, it is the pager test (below).
//
// Both are reported by name: node tools/uijourney.mjs check
// ============================================================================================
//
// SELECTORS COME FROM THE MODEL. data-em / data-em-input / data-em-action are already in the shipped
// React, derived from displays= / inputs= / the command edge, and held to the model in both directions
// by \`design.mjs check\`. Use them. A test id invented here is a selector nothing keeps honest, and
// \`check\` reports one that names a field the screen does not declare.
//
${sel}
//
// RULE NAMES THIS WALK CAN SURFACE. The rule name is what the user sees and what the failing GWT is called
// after, so asserting it in the browser ties the two together — and it is ALWAYS in \`title\`, so one
// assertion covers both enforcement points. What each additionally carries differs, and only the periphery
// shape says WHICH INPUT was refused:
${rejections}
//
${undrivable.length ? `// HOW THE USER REACHES ${undrivable.join(", ")} IS NOT IN THE MODEL. ${undrivable.length > 1 ? "Those screens show" : "That screen shows"} no view
// data, so no event chain leads to ${undrivable.length > 1 ? "them — they are modals" : "it — it is a modal"}, a blank form, or the entry point. There is
// no attribute for navigation and nothing invented one. WRITE THE ANSWER HERE, in prose, because this
// comment is then the only place in the system where it is recorded:
//
//   TODO(uijourney): the user gets to ${undrivable[0]} by …
//` : `// Every screen on this walk is fed by a view, so the data path into each is in the model. How a user
// gets there is still not — if a step needs a click the model cannot describe, say so here.`}
// EVERY STATE THIS WALK ASSERTS GETS A SHOT, AND THE SHOT IS THE PROOF. An assertion is a claim the suite
// can check and a human cannot see; a screenshot is the reverse. So: assert, then shoot, in that order —
// one shot per STATE and not per assertion, because plenty of what a journey asserts has no picture (a URL
// that changed, a console that stayed quiet, a button genuinely disabled rather than merely grey).
//
// The set in review/_shots/ is a SNAPSHOT OF THE LAST RUN, not an archive: names carry no timestamp, so a
// re-run overwrites, and the beforeAll below clears this journey's own shots first. That second half is
// what stops a run where step 5 failed from leaving step 6's picture from the PREVIOUS run sitting there
// looking current.
import { test, expect } from "@playwright/test";
import { shot, watchForSilentFailure, clearJourneyShots } from "./_shot";

test.describe("${p.name}", () => {
  // A missing shot must read as MISSING rather than as last run's success.
  test.beforeAll(({}, testInfo) => {
    clearJourneyShots(testInfo.project.use.viewport?.width ?? 1440);
  });

  test("${(p.label ?? p.name).replace(/"/g, "'")}", async ({ page }) => {
    // Anything the browser complains about that this walk did not mean to cause is a failure. An empty
    // screen with no error is what a wrong proxy prefix and an unapplied seed both look like.
    const silent = watchForSilentFailure(page);

    // ---- step 0: WHERE THE USER ARRIVES -----------------------------------------------------------
    // The walk below is where the user ACTS. This is where they land, and it is the one part of a UI
    // journey the model cannot state.${startsElsewhere ? `
    //
    // The first screen acted on is "${first.screen}", which no data path reaches — so it is almost
    // certainly opened FROM somewhere. "${arrival.screen}" is the screen on this walk that IS fed by a
    // view (${arrival.views.join(", ") || "a view"}), which makes it the likely arrival. CONFIRM THAT; do not assume it.` : ""}
    const entry = "/";
    await page.goto(entry);
    // TODO(uijourney): replace this placeholder with a real assertion that THIS screen rendered — a step
    // whose page never rendered still screenshots, and the shot looks perfectly fine. That has happened
    // here, which is why the assertion comes FIRST and the shot second, in that order, every time.
    await expect(page).toHaveTitle(/./);
    await shot(page, "${(arrival ?? first).screen}", "arrival");

${p.screens.map((s, i) => `    // ---- step ${i + 1}: ${s.screen} — ${s.slices.join(", ")} ----------------------------------------
    // TODO(uijourney): get here BY CLICKING${i === 0 ? "" : ", from step " + i}. ${s.commands.length
      ? `Fill ${s.inputs.map((f) => `[data-em-input="${f}"]`).join(", ") || "the form"}, then press [data-em-action="${s.commands[0]}"].`
      : s.displays.length ? `Assert the real data: ${s.selectors.slice(0, 3).join(", ")}.`
      : `Follow the affordance a user would.`}
    ${i > 0 ? `// Use the values the UI HANDED BACK — an id read off the page, not one this test made up. That is
    // what makes this a journey rather than ${p.screens.length + 1} unrelated visits, and "an id minted in one
    // shape and read in another" is the first thing a journey exists to catch.` : `// This screen is the first thing that HAPPENS, which is not the same as the first thing seen.`}
    // ASSERT FIRST, THEN SHOOT — the shot is the proof of the assertion above it, not a substitute:
    //   await shot(page, "${s.screen}", "step${i + 1}");
    //
    // IF THE ASSERTION ONLY PASSES WITH A RETRY, SAY SO IN THE REPORT. Playwright's expect retries, so
    // an eventually-consistent read model passes here and looks immediate. A view registered Async is
    // stale for exactly as long as the daemon takes — which in production means this screen needs a
    // refetch or optimistic UI, and that is a requirement rather than a polish item.
`).join("\n")}
    // ---- the pager check: STATE THAT DOES NOT SURVIVE A RELOAD ---------------------------------
    // Measured, past 32 passing tests: shots of / and /?page=2 came back IDENTICAL, because the pager
    // was component state that never reached the URL — so a page could not be linked, bookmarked or
    // refreshed. Nothing else in the kit can see this.
    //
    // TODO(uijourney): for every state this walk reached by clicking — a page, a sort, an open modal,
    // a filter — do all three:
    //   const reached = page.url();
    //   expect(reached).not.toBe(new URL(entry, reached).href);   // the click reached the URL at all
    //   await page.reload();                 // and now the deep link is legal, because a click made it
    //   // assert the same state is still on screen
    expect(silent(), "the browser reported nothing the journey did not cause").toEqual([]);
  });
});
`;
}
