#!/usr/bin/env node
// Generate the deterministic half of the code from the system IR.
//
//   node tools/codegen.mjs <system-dir> [--out generated/<System>]
//
// The split matters. Anything mechanically derivable from the model belongs in a SCRIPT: it is
// total, idempotent, and its diff is how a model change gets reviewed. Anything needing judgement —
// the body of a business rule, the arithmetic behind a derived field, the example data a test needs
// — belongs to the `codegen` skill, which reads reference/llms/ and fills the marked holes.
//
// So this emits: the solution, both projects, Program.cs, every event record, every aggregate's
// Create/Apply skeleton, every view type, every validator for a periphery rule, the Alba harness,
// and one test per GWT. It emits NO business logic, and says so at every hole with TODO(codegen).
//
// API shapes here are taken from reference/llms/, never from memory:
//   [WolverinePost] + [Aggregate] + [EmptyResponse]     wolverine/guide/http/marten.md
//   StreamIdentity.AsString                             marten/events/configuration.md
//   self-aggregating Create/Apply snapshots             marten/events/projections/aggregate-projections.md
//   AlbaHost.For<Program> + RunWolverineInSoloMode      wolverine/guide/http/integration-testing.md
//   UseFluentValidationProblemDetailMiddleware          wolverine/guide/http/policies.md
// Testcontainers is NOT in the mirror (zero mentions across 392 pages), so its usage is the one
// part of this file written from unverifiable knowledge. Flagged in the output.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, renameSync } from "node:fs";
import { isMultiStream as isMultiStreamShared } from "./view-recipe.mjs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./project.mjs";
import { parseBindings, distinctTypes } from "./type-bindings.mjs";

const argvAll = process.argv.slice(2);
const explicit = argvAll[0] && !argvAll[0].startsWith("--") ? argvAll[0] : null;
const rest = explicit ? argvAll.slice(1) : argvAll;
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 && rest[i + 1] ? rest[i + 1] : d; };

// --- the IR is the only input -----------------------------------------------------------------
//
// Compile to stdout and let the IR name itself. The old code guessed the filename from the target
// directory's basename, which only worked while that directory was named after the system — with
// the <system> level dropped it is now literally "diagrams". Guessing the project name instead
// would be worse than wrong: a model cell's system= legitimately differs from the project folder,
// so codegen and a standalone `compile` would each write a differently-named copy of one artifact.
// Reading stdout and writing it here means there is exactly one IR file and nobody guesses.

const PROJECT = projectRoot(rest);
const target = explicit ?? join(PROJECT, "diagrams");
const MODEL = fileURLToPath(new URL("model.mjs", import.meta.url));
// Forward --project and nothing else. codegen's own --out names the GENERATED directory; passing
// rest wholesale would hand that value to compile, which reads --out as the IR's path.
const pass = flag("project", null) ? ["--project", flag("project", null)] : [];
const ir = JSON.parse(
  execFileSync(process.execPath, [MODEL, "compile", target, "--stdout", ...pass],
               { encoding: "utf8", maxBuffer: 1 << 28 }));
const irPath = join(PROJECT, "build", `${ir.system}.ir.json`);
mkdirSync(dirname(irPath), { recursive: true });
writeFileSync(irPath, JSON.stringify(ir, null, 2) + "\n", "utf8");

// --- WHICH SLICES ARE CONTENDED: ASKED, NEVER RECOMPUTED --------------------------------------------
//
// `architect.mjs` already derives this, in ~70 lines carrying several hard-won corrections — among them
// that the test is `key.length` and not `key.length > 1`, without which the simplest cross-stream rule
// there is gets misfiled as a contended invariant. Deriving it a second time here is **V9's exact shape**:
// that finding exists because architect and codegen each had their own idea of what "multi-stream" meant,
// and four Async views were never questioned as a result. So this shells out and reads the answer.
//
// Agreement is therefore STRUCTURAL rather than measured — there is one computation and one caller. What
// still needs proving is that the pipe is not empty, because a swallowed failure here would make every
// report below quietly vacuous. It very nearly was: `architect.mjs` hard-coded `<project>/diagrams` and
// died on all six reference implementations, and codegen's other call site swallows that in a try/catch.
// So a failure is RECORDED AND PRINTED rather than ignored.
let architectQuestions = [];
let architectFailure = null;
try {
  const ARCHITECT = fileURLToPath(new URL("architect.mjs", import.meta.url));
  architectQuestions = JSON.parse(execFileSync(process.execPath,
    [ARCHITECT, "questions", target, "--json", ...pass],
    { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] })).questions ?? [];
} catch (e) {
  architectFailure = (e.stderr || e.message || String(e)).toString().trim().split("\n")[0];
}
// ONLY `contended-invariant`. A `cross-stream-rule` slice needs a MECHANISM — guard row, reservation row,
// advisory lock, DCB — and every one of those is a deliberate hand-rolled transaction, which is one of
// CLAUDE.md's two good reasons to leave the aggregate handler workflow entirely. Forcing those onto the bus
// would be prescribing the wrong fix for a different problem.
const contendedSlices = new Set(architectQuestions
  .filter((q) => q.family === "contended-invariant")
  .map((q) => q.id.split("/")[2]));

const pascal = (s) => s.replace(/(^|[^a-zA-Z0-9])([a-z])/g, (_, a, b) => b.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
const camel = (s) => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1); };
const NS = pascal(ir.system);
const OUT = resolve(PROJECT, flag("out", join("generated", NS)));
const APP = join(OUT, "src", NS);
const TESTS = join(OUT, "tests", `${NS}.IntegrationTests`);

// --- package versions, and why a project may override them --------------------------------------
//
// Both .csproj files are `emit`, so a hand-edited version is REVERTED by the next regeneration —
// silently, and with a symptom that arrives much later as a behavioural difference rather than a
// build error. That is the worst shape a defect can have, so the pin needs somewhere to live that
// regeneration does not own.
//
// The case that forced it: reference-implementations/cross-aggregate-invariant needs Marten 9,
// because Marten 8.37.4 ships the whole DCB API — FetchForWritingByTags, DcbConcurrencyException —
// WITHOUT `mt_dcb_tag_version`, the side table the docs call the serialization point, added in 9.4
// to fix marten#4591. On 8 a DCB implementation compiles, runs, and can let both writers through.
// A reference implementation that proves a concurrency guarantee cannot be pinned by hand to the one
// version where the guarantee is real and then quietly reverted.
//
// THE OBVIOUS ALTERNATIVE WAS TRIED AND MEASURED WRONG. A `Directory.Build.targets` carrying
// `<PackageReference Update="Marten" Version="9.*" />` inside a target reads correctly and
// `dotnet restore` ignores it: restore resolved **Marten 2.10.3**, a 2018 package with a critical
// CVE, while the file looked right. A pin that fails must fail loudly; that one failed by
// downgrading. Hence a table here rather than MSBuild cleverness there.
//
//   <project>/package-versions.json     {"Marten": "9.*", "Marten.AspNetCore": "9.*", "JasperFx": "2.*"}
//
// An unknown package name is an ERROR rather than a no-op, because a typo in a pin is exactly how the
// pin goes missing — the same silence this whole mechanism exists to remove.
// THE MAJORS MOVE TOGETHER, AND THAT IS NOT A STYLE CHOICE. Wolverine 5 COMPILES against Marten 9 and
// then dies at host startup with `TypeLoadException: Could not load type 'Weasel.Core.IAdvisoryLock'` —
// it is bound to the Weasel that shipped with Marten 8. WolverineFx 6.25.1 depends on Marten 9.22.2, so
// the whole family is one decision. Mixing them is not a supported combination, it is a green build that
// cannot boot. KIT-FINDINGS AD11.
//
// WHY LATEST IS THE DEFAULT RATHER THAN A CONSERVATIVE PIN: `docs.mjs sync` always mirrors the CURRENT
// docs. A kit pinned a major behind therefore has a mirror permanently ahead of its own packages, and
// "read the mirror before writing generated code" becomes conditionally true — the documented member
// that will not compile (CLAUDE.md's `WaitForExecutionOf<T>` note) is that skew, not a namespace error.
// Moving to current makes the mirror and the packages agree, which retires the whole class.
const PACKAGES = {
  "Marten": "9.*",
  "Marten.AspNetCore": "9.*",
  "WolverineFx": "6.*",
  "WolverineFx.Http": "6.*",
  "WolverineFx.Http.Marten": "6.*",
  "WolverineFx.Http.FluentValidation": "6.*",
  "WolverineFx.Marten": "6.*",
  "WolverineFx.FluentValidation": "6.*",
  // Wolverine 6 DROPPED THE RUNTIME COMPILER FROM CORE (GH-2876). Without this package the app builds
  // at 0/0 and throws `InvalidOperationException: ... no IAssemblyGenerator (Roslyn) is registered` the
  // moment a handler is needed. Emitted rather than left to package-versions.json, which can override a
  // version but cannot ADD a package — the gap that forced a Directory.Build.props workaround before.
  "WolverineFx.RuntimeCompilation": "6.*",
  "Alba": "8.*",
  "JasperFx": "2.*",
  "Shouldly": "4.*",
  // PINNED EXACTLY, AND IT IS THE ONLY ONE — KIT-FINDINGS BT4.
  //
  // Everything above floats within its major because the docs mirror always mirrors CURRENT docs, so a kit
  // a major behind has a reference permanently ahead of its own packages. **That argument does not reach
  // Testcontainers**: it is not in the mirror at all (zero mentions across 392 pages), which the comment at
  // the top of this file already says. So the float here was never justified by the kit's stated reason.
  //
  // What it cost: `4.*` floated to 4.13.0, which pulled SSH.NET 2025.1.0 — Testcontainers uses it for port
  // forwarding — carrying NU1903, a high-severity advisory. NuGet audit reports that as a WARNING, twice
  // (once at restore, once at build), so EVERY brand-new project failed `scaffold`'s own 0-errors-0-warnings
  // gate before a line of code was written, for a reason nothing to do with the generated code.
  //
  // AND THE COST OF PINNING IS THE OTHER HALF OF THAT STORY, so it is written down rather than discovered:
  // that advisory is gone today only because the float carried the fix in by itself — 4.14.0 brings SSH.NET
  // 2026.0.0, and `dotnet list package --vulnerable` is clean. An exact pin gives that up. The next
  // transitive advisory will sit here until somebody bumps this line deliberately, which is now a
  // maintenance action exactly like a stack major — and, unlike a stack major, nothing in the kit will
  // prompt for it.
  "Testcontainers.PostgreSql": "4.14.0",
  "xunit": "2.*",
  "xunit.runner.visualstudio": "3.*",
  "Microsoft.NET.Test.Sdk": "17.*",
};

const OVERRIDES = (() => {
  const f = join(PROJECT, "package-versions.json");
  if (!existsSync(f)) return {};
  let o;
  try {
    o = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`package-versions.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  // A key starting with "_" is a comment. JSON has none, and the REASON for a pin is the most
  // valuable thing in this file — a bare version with no justification is how a departure from the
  // enforced stack becomes folklore. Dropped before anything else looks at the object.
  for (const k of Object.keys(o)) if (k.startsWith("_")) delete o[k];
  const unknown = Object.keys(o).filter((k) => !(k in PACKAGES));
  if (unknown.length) {
    console.error(
      `package-versions.json names package(s) this generator does not emit: ${unknown.join(", ")}\n` +
      `  emitted: ${Object.keys(PACKAGES).join(", ")}\n` +
      `  Refusing rather than ignoring: a typo in a pin is how the pin silently goes missing.`);
    process.exit(1);
  }
  return o;
})();

/** One PackageReference line, project override beating the default. */
const pkg = (name) =>
  `<PackageReference Include="${name}" Version="${OVERRIDES[name] ?? PACKAGES[name]}" />`;

// THE MODEL IS STACK-AGNOSTIC, SO THE TRANSLATION IS NOT ITS JOB — AND IT IS NOT THIS FILE'S EITHER.
//
// This used to be a hard-coded table whose every entry mapped a name to itself, with the comment
// "Anything unknown stays verbatim." That is not a translation layer, it is a silent pass-through: a model
// saying `aggregateId:UUID` — the book's own word, and what the kit's regression fixture says — emitted
// `UUID` as a C# type name and produced 68 compile errors with nothing anywhere naming the cause.
//
// A domain type is not a C# type, and deciding which C# type it becomes is a DECISION WITH A COST
// (`Double` or `decimal` for money is a rounding question, not a typo). Decisions with costs belong to the
// `architect` step and live in ARCHITECTURE.md. So the bindings are READ from there.
//
// The fallback is deliberately the identity, NOT an error: a project whose model already speaks C# needs no
// record at all, which is what keeps all four reference implementations working unchanged. What changed is
// that an unbound type is now REPORTED by name, before the build, instead of surfacing as CS0246 later.
const BINDINGS = parseBindings(
  existsSync(join(PROJECT, "ARCHITECTURE.md")) ? readFileSync(join(PROJECT, "ARCHITECTURE.md"), "utf8") : "");
// No alias table of its own. Falling back to one here would put the guessing back, one layer down.
const CS = BINDINGS;
// ALWAYS RESOLVE THROUGH THIS, never `CS[t]` bare. The old table's entries were identities (Guid -> Guid),
// so two call sites could read `CS[t]` directly and happen to work; with bindings coming from a record that
// may legitimately be empty, a bare lookup silently returns undefined. That turned `allGuid` false and
// re-keyed every stream from Guid to string — 0 warnings, 3 errors, and nothing pointing at the cause.
const cs = (t) => CS[t] ?? t;
// A `Type[]` field is an ARRAY, whether its members are primitives or a declared group:
//
//   recipients:string[]            -> string[]
//   ingredients:IngredientLine[]   -> IngredientLine[]      plus an emitted IngredientLine record
//
// The group form is what lets ONE read model hold a header and its line items; without it that shape
// needed two views, which is an anti-pattern.
//
// ARRAY RATHER THAN List<T>, and the reason is not tidiness. Both were run against real Marten and
// Postgres and behave identically — same JSONB containment SQL for a LINQ Any(), same rebuild. Marten's
// own child-collection sample declares `Company[]` and `IList<User>` side by side and queries both. Two
// things then decide it:
//
//   * `List<T>` lets somebody write `current.Ingredients.Add(...)` in an Apply. That compiles, appears
//     to work, and MUTATES the document instance Marten handed you — which with second-level projection
//     caching (Options.CacheLimitPerTenant) is a real bug that no test would obviously catch. On an
//     array it is a compile error, so the correct `with { X = [.. X, item] }` is the only way through.
//     The type makes the wrong thing impossible rather than merely discouraged.
//   * one documented query pattern is array-ONLY: for `Any(x => constants.Contains(x))`, Marten
//     requires BOTH the property and the compared values to be arrays.
const type = (f) => {
  const t = cs(f.type);
  return f.collection ? `${t}[]` : `${t}${f.nullable ? "?" : ""}`;
};
const params = (fields) => fields.map((f) => `${type(f)} ${pascal(f.name)}`).join(", ");

// ATOMIC, BECAUSE A CRASHED RUN USED TO LEAVE A HALF-WRITTEN SCAFFOLD THAT THE NEXT RUN COUNTED AS
// `kept` — KIT-FINDINGS BL3. `scaffold()` never overwrites a file that exists, so a truncated one is
// hand-owned from the moment the process died: the generator will not repair it, the report says
// `N written, M kept` with the wreckage inside M, and the only symptom is a compile error in a file
// nobody edited. Write to a sibling temp name and rename — rename is atomic on one filesystem, so the
// path either does not exist or holds a complete file, and there is no third state for the next run to
// misread.
const write = (p, body) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, body.replace(/\n{3,}/g, "\n\n"), "utf8");
  renameSync(tmp, p);
};
const banner = (what) =>
  `// <auto-generated>\n//   ${what}\n//   Generated by tools/codegen.mjs from the event model. Do not edit by hand:\n` +
  `//   re-run codegen and the change is lost. Holes marked TODO(codegen) are for the codegen skill.\n// </auto-generated>\n` +
  // #nullable enable IS REQUIRED, on every generated file, and not as a style choice. Roslyn treats a
  // file carrying a generated-code banner as outside the nullable context, so a `string?` in it warns
  // CS8669 — "the annotation should only be used in code within a '#nullable' annotations context". The
  // <auto-generated-scaffold> banner trips the same heuristic, which is why this sits in the shared
  // banner rather than being sprinkled on the files that happen to have a nullable today. The first
  // model to declare one nullable field turned CLAUDE.md's "0 warnings" claim false.
  `#nullable enable\n`;

// Where a rule is enforced. This was going to be derived from given= being empty — a rule needing no
// prior events settles from the request alone — but that fails on a real model: almost every GWT
// carries a CONTEXT given= like "the month is open", so on hour-booking the heuristic found zero
// periphery rules out of four. Declared instead, and defaulting to the safe answer (the aggregate,
// where the stream is visible). A misplaced rule in a validator cannot enforce itself.
const isPeriphery = (g) => (g.enforce ?? "aggregate") === "periphery";

// A slice nobody has started yet still gets its tests generated — they document the rules — but
// skipped, so `dotnet test` going green means the slices that ARE claimed actually pass. The skip
// count is then the honest measure of what is left.
const CLAIMED = new Set(["ready", "in-progress", "in-review", "closed"]);
const isClaimed = (s) => CLAIMED.has(s.status ?? "in-design");
const factAttr = (s) => isClaimed(s)
  ? "[Fact]"
  : `[Fact(Skip = ${JSON.stringify(`slice ${s.name} is ${s.status ?? "in-design"} — nobody has claimed these rules yet`)})]`;
const ruleName = (g) => pascal((/^error:\s*(.+)$/i.exec((g.then ?? "").trim())?.[1] ?? g.rule ?? g.id).trim());
const testName = (g, i) => {
  const base = (g.rule || g.label || g.id).replace(/\s*\n[\s\S]*$/, "");
  return pascal(base.replace(/[^a-zA-Z0-9 ]/g, " ").split(/\s+/).slice(0, 12).join(" ")) || `Rule${i + 1}`;
};

// TWO GWTs IN ONE SLICE LEGITIMATELY SHARE A RULE NAME — the same refusal reached by two different
// histories, which is exactly what "don't save on GWTs" produces: `servings=0` and `servings=-2` are
// both ServingsMustBePositive. The emitter below already knows this (it keeps each cell id in the
// comment for precisely that reason) and still named both test methods after the rule, so the test
// class did not compile: CS0111, "already defines a member called X". A rule name is not unique and
// nothing may assume it is — the same lesson as labels, one scope down.
//
// Suffix the later ones rather than reaching for the label: a label is prose and pascal-casing twelve
// words of it produces a name nobody can read, while the comment above each test already carries the
// label AND the unique cell id. Deterministic, so a re-run stays byte-identical.
const testNames = (gwts) => {
  const used = new Map();
  return gwts.map((g, i) => {
    const base = testName(g, i);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
};

// The fixed values a GIVEN needs to name things. Derived, because hard-coding them leaked one retired
// domain's vocabulary — EmployeeId, ProjectId, Month, WorkingDay — into every project the generator has
// ever produced, where those names mean nothing.
//
// Every name in a swimlane's identity= is a stream key, so it is exactly what a test must be able to
// refer to. Types come from the events that carry the field.
// WHETHER ONE ROW IS ONE STREAM. Factored out because the lifecycle below and the projection base class
// further down must agree: a view registered Async while declared SingleStreamProjection is a different
// bug from the two disagreeing, and one copy of this rule is the only way to be sure they cannot.
// THE RULE ITSELF NOW LIVES IN tools/view-recipe.mjs, so `architect` reads the SAME one — KIT-FINDINGS
// V9. It used to be defined here and re-derived, more weakly, there: a view fed by one stream but keyed
// by something other than that stream's key was multi to this file and single to that one, so four
// Voltway views were registered Async and never questioned.
const isMultiStream = (v) => {
  const feedingAggregates = v.from.map((l) => ir.shared.events.find((e) => e.label === l)?.aggregate);
  const streams = [...new Set(feedingAggregates.filter(Boolean))];
  return isMultiStreamShared({
    feedingAggregates,
    streamKeyOfSingle: streams.length === 1
      ? (ir.shared.aggregates.find((a) => a.name === streams[0])?.identity ?? [])
      : [],
    declaredIdentity: v.identity,
  });
};

// LIFECYCLE: SINGLE-STREAM INLINE, MULTI-STREAM ASYNC — and that is the library's recommendation rather
// than ours. Marten's multi-stream page states the shape outright: "Register the lookup projection inline
// and the multi-stream projection async." Verified in the mirror, where all 22 Projections.Add call sites
// pass a lifecycle EXPLICITLY.
//
// THIS FILE USED TO REGISTER EVERYTHING INLINE, and CLAUDE.md justified it with two claims that the mirror
// does not support: that Marten "registers multi-stream projections Async by default" — it has no default,
// the argument is required — and that Inline "invites apparent event skipping", which is an async-daemon
// high-water-mark phenomenon and so was attributed backwards. Standing rule from the human: where the kit
// and the critter-stack docs disagree, the docs win.
//
// The cost is real and is not hidden: an Async view is NOT assertable the moment the request returns, so a
// test must wait rather than assert. That is why the GT hints below branch on this, and why ConfigureStore
// starts the daemon when anything is Async.
const ownerOf = (v) => automations.find((s) => (s.views ?? []).includes(v.label));
const lifecycleFor = (v) => {
  const owner = ownerOf(v);
  // An automation's todo View may have to be Async whatever its shape — projection side effects, one way to
  // wake a trigger, are documented as built for asynchronous processing. Only the owning automation can
  // override, so it is still asked.
  if (owner) return `${pascal(owner.name)}Wakeup.LifecycleOf(ProjectionLifecycle.${isMultiStream(v) ? "Async" : "Inline"})`;
  return `ProjectionLifecycle.${isMultiStream(v) ? "Async" : "Inline"}`;
};
const anyAsync = () => ir.shared.views.some((v) => isMultiStream(v));

// THE MODEL'S OWN EXAMPLE DATA, GATHERED ONCE — KIT-FINDINGS BP3.
//
// `seedConstants()` used to build every value from a field's NAME and TYPE — "roomId-1", 2026-01-02 — while
// the SAME generator interpolated the model's real example into the TODO(codegen) text three lines away. So
// one file said *expect RoomBooked(roomId=Aurora, date=2026-09-01)* and *fixed values for every stream key
// are on SeedData*, with SeedData.RoomId = "roomId-1". Every implementer hand-corrected it, and a run that
// did not notice wrote tests whose data contradicts the model the tests came from.
//
// A `$Name` reference is SKIPPED, and that is not an omission: `$Name` already MEANS SeedData.Name, so
// seeding a constant from it would define the constant in terms of itself.
const modelExamples = (() => {
  const found = new Map();
  for (const s of ir.slices) {
    for (const g of s.gwts ?? []) {
      for (const step of [...(g.givenSteps ?? []), ...(g.whenSteps ?? []), ...(g.thenSteps ?? [])]) {
        for (const [name, value] of Object.entries(step.example ?? {})) {
          if (typeof value !== "string" || value.startsWith("$")) continue;
          if (!found.has(name)) found.set(name, []);
          found.get(name).push({ value, where: `${s.name}/${g.id}` });
        }
      }
    }
  }
  return found;
})();

// A LITERAL THE MODEL WROTE, RENDERED FOR ITS DECLARED C# TYPE — or null, which means "fall back and say
// so". Returning null rather than forcing it is the point: `gwt-example-type` already errors on a literal
// that cannot be its declared type, so anything reaching here and failing to render is a shape this
// generator does not understand, and a wrong constant is worse than an honest synthetic one.
const seedLiteral = (t, v) => {
  if (t === "Guid") return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)
    ? `Guid.Parse("${v}")` : null;
  if (t === "DateOnly") return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `DateOnly.Parse("${v}")` : null;
  if (t === "DateTimeOffset") return Number.isNaN(Date.parse(v)) ? null : `DateTimeOffset.Parse("${v}")`;
  if (t === "int" || t === "long") return /^-?\d+$/.test(v) ? v : null;
  if (t === "decimal") return /^-?\d+(\.\d+)?$/.test(v) ? `${v}m` : null;
  if (t === "bool") return /^(true|false)$/i.test(v) ? v.toLowerCase() : null;
  if (t === "string") return JSON.stringify(v);
  return null;
};

const seedConstants = () => {
  const keys = [...new Set(ir.shared.aggregates.flatMap((a) => a.identity ?? []))];
  const typeOf = (name) => {
    for (const e of ir.shared.events) {
      const f = (e.fields ?? []).find((x) => x.name === name);
      if (f) return cs(f.type);
    }
    return "string";
  };
  const hex = (n) => String(n % 10).repeat(8) + "-" + String(n % 10).repeat(4) + "-" +
    String(n % 10).repeat(4) + "-" + String(n % 10).repeat(4) + "-" + String(n % 10).repeat(12);
  const lines = keys.map((k, i) => {
    const t = typeOf(k);
    const N = pascal(k);
    // FIRST IN MODEL ORDER WINS, and a disagreement is NAMED rather than silently resolved. Several GWTs
    // legitimately mention the same key with different values — one per scenario — but a stream key is one
    // fixed value for the whole suite, so somebody has to be told which one the seed took.
    const seen = modelExamples.get(k) ?? [];
    const distinct = [...new Set(seen.map((x) => x.value))];
    const chosen = seen.find((x) => seedLiteral(t, x.value) !== null);
    const note = chosen
      ? `   // from the model: ${chosen.where}${distinct.length > 1
          ? `  (${distinct.length} different values in the GWTs; this is the first)` : ""}`
      : `   // synthesised: no GWT example names ${k}`;
    if (chosen) {
      const lit = seedLiteral(t, chosen.value);
      const decl = ["int", "long", "decimal", "bool", "string"].includes(t) && !/Parse\(/.test(lit)
        ? `public const ${t}` : `public static readonly ${t}`;
      return `    ${decl} ${N} = ${lit};${note}`;
    }
    if (t === "Guid") return `    public static readonly Guid ${N} = Guid.Parse("${hex(i + 1)}");${note}`;
    if (t === "DateOnly") return `    public static readonly DateOnly ${N} = new(2026, 1, ${(i % 28) + 1});${note}`;
    if (t === "DateTimeOffset") return `    public static readonly DateTimeOffset ${N} = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);${note}`;
    if (t === "int" || t === "long") return `    public const ${t} ${N} = ${i + 1};${note}`;
    if (t === "decimal") return `    public const decimal ${N} = ${i + 1}m;${note}`;
    if (t === "bool") return `    public const bool ${N} = true;${note}`;
    return `    public const string ${N} = "${k}-1";${note}`;
  });
  if (!keys.length)
    lines.push("    // No band declares identity=, so there are no stream keys to name. Add identity= first.");
  lines.push("");
  lines.push("    /// <summary>One fixed instant, so a seeded timestamp is assertable.</summary>");
  lines.push("    public static readonly DateTimeOffset SeededAt = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);");
  return lines.join("\n");
};

// WHAT KEYS A STREAM, in the store's terms. Marten fixes stream identity once per store, so this is a
// whole-system decision derived from every band's identity=:
//
//   every keyed band has ONE Guid identity field  ->  StreamIdentity.AsGuid, key IS the field
//   every keyed band has ONE field                ->  AsString, key IS the field
//   any band has a composite key                  ->  AsString, key is a prefixed join
//
// IT NO LONGER DECIDES WHETHER THE AGGREGATE HANDLER WORKFLOW IS AVAILABLE, and this comment used to say
// it did — "a composite key cannot satisfy [WriteAggregate]: there is no one member to read". Wrong, and
// wrong in the expensive direction: it sent every composite-keyed slice in the kit to a hand-rolled
// FetchForWriting. [WriteAggregate] resolves a stream from a public MEMBER, and a computed get-only
// property is one, so the command carries an assembled StreamKey and the workflow applies to any key
// shape. Measured in reference-implementations/reservation/; KIT-FINDINGS BM1.
//
// The prefix still mattered for a different reason: a key of `email:{id}` can never equal the `emailId` a
// command carries, so a single-field key must BE the field for the convention-based form to work.
const keyedAggs = ir.shared.aggregates.filter((a) => (a.identity ?? []).length);
const identityFieldOf = (a) => {
  const name = a.identity[0];
  for (const e of ir.shared.events) {
    const f = (e.fields ?? []).find((x) => x.name === name);
    if (f) return f;
  }
  return null;
};
const singleKeyed = keyedAggs.length > 0 && keyedAggs.every((a) => a.identity.length === 1);
const allGuid = singleKeyed && keyedAggs.every((a) => cs(identityFieldOf(a)?.type) === "Guid");
const STREAM_ID = allGuid ? "Guid" : "string";
const STREAM_IDENTITY = allGuid ? "AsGuid" : "AsString";

// A VIEW's document id is not the stream id, and assuming it was emitted code that could not compile.
// A read model rolled up over many streams is keyed by whatever its own identity= says — DeliveryLog is
// per (messageId, recipient), SenderMonthly per (senderId, month) — and neither of those is a stream key.
// Same rule as above, applied to the view's own grain:
//
//   identity= names ONE field  ->  that field's type, and Identity<T> is `e => e.Field` (no interpolation)
//   identity= is composite     ->  string, and Identity<T> joins the parts with ':'
//
// Interpolating a single Guid key into $"{e.CampaignId}" is what broke: the lambda returns string while
// the projection is declared MultiStreamProjection<T, Guid>. Silent in the model, a compile error in code.
const fieldTypeOf = (name) => {
  for (const e of ir.shared.events) {
    const f = (e.fields ?? []).find((x) => x.name === name);
    if (f) return type(f);
  }
  for (const a of ir.shared.aggregates) {
    for (const c of a.commands ?? []) {
      const f = (c.fields ?? []).find((x) => x.name === name);
      if (f) return type(f);
    }
  }
  for (const v of ir.shared.views) {
    const f = (v.fields ?? []).find((x) => x.name === name);
    if (f) return type(f);
  }
  return "string";
};
const viewIdType = (key) => (key.length === 1 ? fieldTypeOf(key[0]) : "string");
const viewIdExpr = (key) =>
  key.length === 1 ? `e => e.${pascal(key[0])}` : `e => $"${key.map((k) => `{e.${pascal(k)}}`).join(":")}"`;

const files = [];
const kept = [];
// Fully derived: always overwritten, because the diff IS the review of a model change.
const emit = (p, body) => { write(p, body); files.push(p); };
// Needs judgement: scaffolded once, then owned by whoever filled it in. Overwriting this would
// silently delete the only part of the code a model cannot express.
//
// The banner is rewritten HERE rather than at each call site, because a fresh scaffold file was being
// born with the <auto-generated> banner — which says "do not edit by hand: re-run codegen and the change
// is lost". That is the exact opposite of true for the one kind of file where editing is the whole point,
// and CLAUDE.md claimed the distinction already existed. Centralising it means no call site can forget.
const scaffold = (p, body) => {
  if (existsSync(p)) { kept.push(p); return; }
  write(p, body
    .replace("// <auto-generated>", "// <auto-generated-scaffold>")
    .replace("// </auto-generated>", "// </auto-generated-scaffold>")
    .replace(
      "//   Generated by tools/codegen.mjs from the event model. Do not edit by hand:\n" +
      "//   re-run codegen and the change is lost. Holes marked TODO(codegen) are for the codegen skill.",
      "//   Scaffolded once by tools/codegen.mjs, then FILLED IN BY HAND — regeneration KEEPS this file.\n" +
      "//   Holes marked TODO(codegen) are yours to close; they are reported until you do."));
  files.push(p);
};

// A GWT added to a slice that is ALREADY implemented gets no test, because the test file is
// scaffold — written once, then hand-owned, and regeneration keeps it. Nothing failed, nothing was
// skipped, and the rule simply had no test. That defeats the one gate the whole kit rests on: "the
// slice's tests are live, not skipped."
//
// Every generated test carries its rule text as a comment, so a kept file can be checked for
// coverage without parsing C#. Reported rather than repaired: appending into a file somebody else
// owns is how a generator destroys hand-written work.
// WHAT A GIVEN/THEN ASSERTS DEPENDS ON WHICH PATTERN IT IS ON, and one wording for both was wrong for one
// of them.
//
// On a VIEW slice the outcome is the read model's contents — there is no command, so THEN names the View.
// On an AUTOMATION or TRANSLATION the slice HAS a command, and the GT is its infrastructure half: the little
// book's shape is "GIVEN these 2 Events, we expect the automation to run automatically... and result in
// another Event". So THEN names an EVENT, and model.mjs enforces exactly that — it accepts a read-model
// then= only when the slice has no command.
//
// The hint said "assert the read model" for both, which on an automation sends the implementer looking for a
// document that may deliberately not exist: the todo View is often the durable inbox rather than a
// projection, and on a translation it CANNOT be a projection, because the foreign event is never in our
// store to fold.
// AND IT ALSO HAS TO SAY WHETHER THE VIEW IS ASSERTABLE YET. A multi-stream view is registered Async, per
// Marten's own guidance, so it is NOT current the moment the append returns — a test that asserts straight
// away fails intermittently and reads as a projection bug. Naming the wait here is the difference between a
// hint that helps and one that misleads, which this hint has already been twice.
const asyncViews = () => ir.shared.views.filter((v) => isMultiStream(v)).map((v) => v.label);
const gtHint = (s) => {
  if (s.commands.length) {
    return "\n    //   (no WHEN: this is a GIVEN/THEN — the infrastructure half. Nobody issues the command: append the"
      + "\n    //    GIVEN, let the trigger run, and assert the EVENT it produced. That the trigger selects its own"
      + "\n    //    work is the claim; that anything WAKES it is not, and no generated test can make it.)";
  }
  const mine = (s.views ?? []).filter((l) => asyncViews().includes(l));
  return "\n    //   (no WHEN: this is a GIVEN/THEN. Append the GIVEN, then assert the read model — through its read"
    + "\n    //    endpoint if the slice has one, else Store.QuerySession().)"
    + (mine.length
      ? `\n    //   ${mine.join(", ")} ${mine.length === 1 ? "is" : "are"} multi-stream and therefore registered ASYNC, so`
        + "\n    //    it is NOT current when the append returns. Wait first:"
        + "\n    //      await Store.WaitForNonStaleProjectionDataAsync(5.Seconds());"
        + "\n    //    The import is `using Marten.Events;` — TestingExtensions is a STATIC CLASS in that"
        + "\n    //    namespace, not a namespace itself, so `using Marten.Events.TestingExtensions;` is CS0138."
        + "\n    //    (Settled from Marten.xml: `M:Marten.Events.TestingExtensions.WaitForNonStale…`. No doc"
        + "\n    //    page states it. Overloads exist on both IHost and IDocumentStore, so Store.… is right.)"
        + "\n    //    Asserting without the wait fails intermittently and looks exactly like a broken projection."
      : "");
};

const untested = [];
const ambiguous = [];
const checkGwtCoverage = (p, gwts) => {
  if (!existsSync(p)) return;
  const src = readFileSync(p, "utf8");

  // A RULE NAME IS NOT UNIQUE, AND THIS CHECK USED TO ASSUME IT WAS — KIT-FINDINGS V13.
  //
  // Two GWTs legitimately share a rule name: the same refusal reached by two different histories. The kit
  // DEPENDS on that elsewhere — deduping the generated rejection constants by rule name is what fixed a
  // CS0102 collision. But a substring search for the name cannot tell them apart, so once one scenario has
  // a test, every later scenario for that rule reported as covered. Measured: a GWT was added to an
  // implemented slice under an existing rule name and this report stayed silent. The model grew and the
  // check went quiet, which is the worst direction for a report to fail in.
  //
  // The fix is NOT to require the id everywhere — every correct test written before this change would then
  // be reported as missing, and a check that cries wolf on a correct project is worse than the gap. So the
  // id is required ONLY where the name is genuinely ambiguous, and the finding says so in those words
  // rather than claiming a test is absent. That is a true statement about this file either way.
  const byRule = new Map();
  for (const g of gwts) byRule.set(g.rule, (byRule.get(g.rule) ?? 0) + 1);

  for (const g of gwts) {
    if (!src.includes(g.rule)) { untested.push({ path: p, rule: g.rule, id: g.id }); continue; }
    if (byRule.get(g.rule) > 1 && !src.includes(g.id))
      ambiguous.push({ path: p, rule: g.rule, id: g.id, n: byRule.get(g.rule) });
  }
};

// A STALE SKIP, which is the same class of bug as an untested GWT and was doing more damage.
//
// CLAUDE.md promises: "A slice at in-design has not been claimed, so its GWT tests are generated but
// skipped. From ready onward somebody is answerable for them and they run." That is FALSE after the first
// generation. factAttr() bakes [Fact(Skip = ...)] into the file from status= at scaffold time, and the
// test file is a scaffold — so it is KEPT. Promote the slice afterwards and the tests go on being skipped
// for ever, reporting `Skipped` where the whole gate depends on `Passed`.
//
// Nobody noticed because the first project happened to generate its slice while already `ready`. The
// second one generated everything at in-design first, promoted later, and every test stayed off.
//
// Reported, not repaired: the file is hand-owned by then, and rewriting an attribute inside somebody's
// test file is how a generator destroys work. The remedy is one hand edit, and now it is visible.
// A VIEW WITH NO REGISTRATION, which is the quietest failure in the whole kit.
//
// Views/ViewRegistrations.cs is a scaffold — written once, then hand-owned, and KEPT. So a view added to
// the model AFTERWARDS gets its projection class scaffolded and never gets a line in Register(), because
// that file was written before the view existed.
//
// There is no symptom. The build is clean, startup is clean, no table is created, and LoadAsync just
// returns null. codegen even prints "N views" on the line above while one of them is dark. The file's own
// header warns about a read-side decision being LOST to a scaffold; this is the same bug inverted — the
// decision was never made at all.
//
// Reported, not repaired, for the usual reason: appending into a file somebody else owns is how a
// generator destroys hand-written work. A commented-out TODO registration counts as unregistered on
// purpose — that is exactly the state a multi-stream view with no slicing rule is parked in.
const unregisteredViews = [];
const checkViewsRegistered = (p, views) => {
  if (!existsSync(p)) return;
  const src = readFileSync(p, "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\/\/\/)/.test(l)).join("\n");   // ignore commented-out lines
  for (const v of views) {
    const t = pascal(v.label);
    // THREE LEGITIMATE FORMS, and the first version of this check knew only one — it matched
    // `Add<XProjection>` and so accused three correctly-registered views in the six-recipe reference
    // implementation, on a fully green suite. Precisely the cry-wolf failure this file warns about
    // elsewhere, and only a model exercising more than one recipe could expose it:
    //
    //   opts.Projections.Add<XProjection>(...)              the generic form
    //   opts.Projections.Add(new XProjection(), ...)        BY INSTANCE, when config lives in its ctor
    //   opts.Projections.Snapshot<X>(...)                   self-aggregating: the DOCUMENT type, no
    //                                                       "Projection" suffix anywhere
    const registered = src.includes(`${t}Projection`) || new RegExp(`Snapshot<\\s*${t}\\s*>`).test(src);
    if (!registered) unregisteredViews.push({ path: p, view: v.label });
  }
};

const staleSkips = [];
const checkSkipFreshness = (p, s) => {
  if (!existsSync(p) || !isClaimed(s)) return;
  const src = readFileSync(p, "utf8");
  // An ATTRIBUTE, not the string anywhere in the file. A plain substring search reported a file whose
  // only match was a /// comment explaining that it had been un-skipped by hand — a false positive that
  // tells the reader to fix something already fixed, which is how a report stops being read.
  if (/^[ \t]*\[Fact\(Skip/m.test(src)) staleSkips.push({ path: p, slice: s.name, status: s.status });
};

// THE INVERSE, and it was a blind spot in the check above: an UNCLAIMED slice whose tests are written.
//
// checkSkipFreshness returns early unless the slice is claimed, so a slice left at in-design with every
// test body filled in produces no signal at all — the work is done, the tests are dark, and the skip count
// that CLAUDE.md calls "the honest measure of what is left" over-reports by however many they are.
//
// Detected by the absence of the stub: a scaffolded test throws NotImplementedException, so a file with
// none left has been implemented. The remedy is a status= change on the slice cell, which is a MODELLING
// edit and squarely the human's.
const doneButUnclaimed = [];
const checkImplementedYetUnclaimed = (p, s) => {
  if (!existsSync(p) || isClaimed(s) || !s.gwts.length) return;
  const src = readFileSync(p, "utf8");
  if (!src.includes("NotImplementedException")) {
    doneButUnclaimed.push({ path: p, slice: s.name, status: s.status ?? "in-design", tests: s.gwts.length });
  }
};

// An automation nothing ever wakes passes every test it has, because the tests drive the trigger
// directly. The generator deliberately does not choose the mechanism (see the automations block below),
// so the hole it leaves has to be reported until somebody closes it — otherwise "not chosen yet" and
// "chosen and working" look identical from the outside, which is how it shipped once.
//
// Looks for the marker the generator itself wrote, not for any of the four implementation shapes. An
// earlier version grepped for `ScheduleAsync` and therefore fired on every correct non-sweep automation;
// a check that flags correct code is worse than no check.
const unwoken = [];
const checkWakeupChosen = (p, slice) => {
  if (!existsSync(p)) return;                       // not scaffolded yet; this run will write it
  if (readFileSync(p, "utf8").includes("TODO(codegen): choose how"))
    unwoken.push({ path: p, slice });
};

// There WAS a check here for "the trigger never schedules its successor", from when the beat was meant
// to come from the handler rescheduling itself. That design does not work on this stack (see
// AutomationHeartbeat) and the cadence now lives in generated code, so there is no line left for a human
// to forget — and a check that fires on every correct automation is worse than no check.
//
// What replaced it is structural rather than a lint: the generator emits the heartbeat and its
// registration for every automation slice past in-design. The thing still NOT verifiable here is whether
// the clock actually ticks in a running process; only starting the app and watching a second sweep does
// that. ANTI-PATTERNS.md #14.

// --- events -----------------------------------------------------------------------------------

const owned = ir.shared.events.filter((e) => e.ownedBy);
const foreign = ir.shared.events.filter((e) => !e.ownedBy);
emit(join(APP, "Contracts", "Events.cs"),
  `${banner(`${ir.shared.events.length} event records — every distinct event in the system`)}
namespace ${NS}.Contracts;

${owned.map((e) => `/// <summary>${e.aggregate} stream. Produced by ${e.ownedBy}.${e.isPublic ? " Public: other contexts consume it." : ""}</summary>
public sealed record ${pascal(e.label)}(${params(e.fields)});`).join("\n\n")}

// Events we do not produce. We model the incoming contract so it can be deserialised and projected;
// nothing in this system appends them.
${foreign.map((e) => `/// <summary>External — arrives from ${e.origin}. Terminal: we have no control over it.</summary>
public sealed record ${pascal(e.label)}(${params(e.fields)});`).join("\n\n")}
`);

// --- per-slice aggregates ---------------------------------------------------------------------
//
// There is no such thing as "the" aggregate. Wolverine + Marten let every state-change slice fold
// the stream into whatever shape ITS decision needs, and live aggregation means no projection is
// registered for any of them — FetchForWriting folds on demand. So the aggregate is per SLICE, not
// per stream, which also takes it out of the shared layer and makes slices that much more
// independent.
//
// The endpoint is the decider: it receives the folded state and returns events. So a state type is
// a pure left fold and holds no rules.
//
// No Create methods. Marten will build from a no-arg constructor, and its own docs say that is
// "probably safest unless you can guarantee that a certain event type will always be first in the
// event stream" — which does not hold here: the Timesheet stream is opened by HoursBooked or by
// ZeroHoursFilled depending on whether the employee booked anything before leaving a project.

const stateName = (s) => `${pascal(s.name)}State`;
const streamOf = (s) => ir.shared.aggregates.find((a) => a.commands.some((c) => c.label === s.commands[0]));

for (const s of ir.slices) {
  if (!s.generates || !s.commands.length) continue;
  const agg = streamOf(s);
  if (!agg || !agg.events.length) continue;
  const evs = agg.events.map((l) => ir.shared.events.find((e) => e.label === l));
  const keyed = agg.identity;
  scaffold(join(APP, "Slices", pascal(s.context), pascal(s.name), `${stateName(s)}.cs`),
    `${banner(`${s.name} — the state this slice folds to make its decision`)}
${keyed.length > 1 ? "using System.Globalization;\n" : ""}using ${NS}.Contracts;

namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// Live aggregation over the ${agg.name} stream, keyed by ${keyed.join(" + ") || "an undeclared identity"}.
/// Nothing registers a projection for this: Marten folds it on demand when the endpoint asks.
///
/// Folds every event of the stream, not only this slice's, because a decision may depend on any of
/// them — the daily cap needs the whole month's bookings, not just the one being added.
///
/// The model draws ${evs[0].label} first in this stream, but there is deliberately no Create method:
/// a no-arg constructor lets any event open the stream.
/// </summary>
public sealed record ${stateName(s)}
{
    public ${STREAM_ID} Id { get; init; }${STREAM_ID === "string" ? " = default!;" : ""}

    /// <summary>Marten's convention. The aggregate workflow uses it for optimistic concurrency.</summary>
    public int Version { get; set; }

${keyed.length === 1 ? `    /// <summary>
    /// The stream key IS the identity field — no prefix, no composition. That is what lets Wolverine's
    /// aggregate handler workflow find the stream from a command member or a route argument.
    /// </summary>
    public static ${STREAM_ID} StreamKey(${STREAM_ID} ${camel(keyed[0])}) => ${camel(keyed[0])};
` : keyed.length ? `    /// <summary>
    /// A COMPOSITE key, so it is a joined string. THAT DOES NOT PUT THE AGGREGATE HANDLER WORKFLOW OUT OF
    /// REACH, and this comment used to say it did — in five places across the kit, for five runs, untested.
    ///
    /// <c>[WriteAggregate]</c> resolves the stream from a public MEMBER of the command, and a computed
    /// get-only property is a member. So a command that carries every part of this key exposes
    /// <c>StreamKey</c> (emitted on the command for exactly that reason) and opts straight in:
    ///
    ///     [WriteAggregate(nameof(TheCommand.StreamKey), Required = false)] TheState? state
    ///
    /// Measured against a composite-keyed stream in reference-implementations/reservation/, whose whole
    /// suite passes against a pure decider with no session in it. KIT-FINDINGS BM1.
    ///
    /// This method stays, because a decider that must SEARCH for its stream — a reservation walking
    /// candidate slots — has no key to hand the middleware, and calls FetchForWriting itself.
    /// </summary>
    /// CULTURE-INVARIANT, AND EVERY DATE PART EXPLICITLY FORMATTED. A composite key is BUILT BY STRING
    /// INTERPOLATION, so without this the machine's culture leaks into the stream id: a DateOnly renders
    /// "2026. 09. 01." under hu-HU and "09/01/2026" under invariant, and a decimal swaps its separator.
    /// Two hosts would then compose two different streams for one desk-day and the invariant the key
    /// exists to enforce would silently stop holding — with no error anywhere. KIT-FINDINGS Z4.
    public static string StreamKey(${keyed.map((k) => {
      const f = evs[0].fields.find((x) => x.name === k);
      return `${f ? type(f) : "string"} ${camel(k)}`;
    }).join(", ")})
        => string.Create(CultureInfo.InvariantCulture, $"${camel(agg.name)}:${keyed.map((k) => {
          const f = evs[0].fields.find((x) => x.name === k);
          const t = f ? cs(f.type) : "string";
          // A round-trippable, sortable, separator-free rendering for the types that have one. Everything
          // else is left to InvariantCulture, which is already enough for Guid/int/long/string.
          const fmt = t === "DateOnly" ? ":yyyy-MM-dd"
                    : t === "DateTime" || t === "DateTimeOffset" ? ":O"
                    : t === "TimeOnly" ? ":HH\\\\:mm\\\\:ss" : "";
          return `{${camel(k)}${fmt}}`;
        }).join(":")}");
` : ""}
${evs.map((e) => `    public static ${stateName(s)} Apply(${pascal(e.label)} e, ${stateName(s)} current)
        // TODO(codegen): fold ${pascal(e.label)} into whatever ${pascal(s.commands[0])} needs to decide.
        // Carries: ${e.fields.map((f) => f.name).join(", ")}.
        => current;`).join("\n\n")}
}
`);
}

// --- views ------------------------------------------------------------------------------------

const SYS_KEY = [...new Set(ir.shared.aggregates.flatMap((a) => a.identity))];
const registerable = [];   // views whose projection is valid enough to register inline

for (const v of ir.shared.views) {
  const derived = Object.entries(v.derived ?? {});
  const streams = [...new Set(v.from.map((l) => ir.shared.events.find((e) => e.label === l)?.aggregate).filter(Boolean))];
  // One row is one stream only when the view is keyed as its single feeding stream is. Stream COUNT
  // alone does not say that: WorkingDays is fed from one stream and keyed by date, so one stream holds
  // many rows and the single-stream base class cannot express it.
  //
  // But an undeclared grain is not evidence of a finer one. A view that declares no identity= is
  // assumed to be one row per stream, which is what it was before anyone asked — demanding a match
  // there dropped `Admins` (one row per admin, fed by one stream, grain never declared) to
  // multi-stream with no slicing rule, and the generator then commented its registration out
  // entirely. A stricter check that silently stops projecting a working view is worse than the bug it
  // fixed.
  //
  // So the multi-stream base class is used when there is real evidence of it: several feeding
  // streams, or a declared grain that the single feeding stream's key does not match.
  const declared = v.identity?.length ? v.identity : null;
  // One copy of this rule, shared with lifecycleFor() above — see the comment there. Two copies could
  // disagree, and a view registered Async while declared SingleStreamProjection would be the result.
  const multi = isMultiStream(v);
  const ownKey = declared ?? SYS_KEY;
  // A row of THIS view, not of the system. Declared on the read model where the grain is known;
  // where it is not, fall back to the system key and say so, because guessing a view's grain
  // silently is how a projection ends up grouping the wrong rows together.
  const KEY = v.identity?.length ? v.identity : SYS_KEY;
  const guessedKey = !v.identity?.length;
  // A single-stream projection is keyed BY THE STREAM, so its document id is the stream id whatever the
  // view's own identity= says. Only a multi-stream projection is free to be keyed by its own grain.
  const VIEW_ID = multi ? viewIdType(KEY) : STREAM_ID;
  const sliceable = v.from.filter((l) => {
    const e = ir.shared.events.find((x) => x.label === l);
    return KEY.every((k) => e?.fields.some((f) => f.name === k));
  });
  if (!multi || sliceable.length) registerable.push(v.label);
  scaffold(join(APP, "Views", `${pascal(v.label)}.cs`),
    `${banner(`${v.label} read model — fed by ${v.from.length} event type(s)`)}
using Marten.Events.Aggregation;   // SingleStreamProjection
using Marten.Events.Projections;   // only used when this view is MULTI-stream; harmless otherwise
using ${NS}.Contracts;

namespace ${NS}.Views;

${Object.entries(v.children ?? {}).map(([child, fields]) => `/// <summary>
/// One member of the <c>${pascal(child)}</c> group inside a ${pascal(v.label)} row. Declared on the model as
/// <c>children="${child}: ${fields.map((f) => `${f.name}:${f.type}`).join(", ")}"</c>, which is what lets one read
/// model hold a header AND its repeated lines. The alternative — a second read model, one row per line —
/// is an anti-pattern: a screen fed by two views is a smell, and it cannot answer a brand-new parent
/// with no lines at all.
/// </summary>
public sealed record ${pascal(child)}(${fields.map((f) => `${type(f)} ${pascal(f.name)}`).join(", ")});

`).join("")}/// <summary>
/// Context: ${v.context}. Slice: ${v.slice}.
/// Fed by: ${v.from.join(", ")}.${v.todoFor?.length ? `\n/// TODO LIST for the ${v.todoFor.join(", ")} automation: a row here is pending work.` : ""}
/// </summary>
public sealed record ${pascal(v.label)}
{
    public ${VIEW_ID} Id { get; init; }${VIEW_ID === "string" ? " = default!;" : ""}

${v.fields.map((f) => {
      const d = v.derived?.[f.name];
      return `    /// <summary>${
        f.collection ? `A repeated group: many ${pascal(f.type)}, not one. An ARRAY so it cannot be mutated in place — see the Apply below.`
        : d ? `Computed from ${d.join(" + ")} — not carried by any event.` : "Carried by an upstream event."}</summary>
    public ${type(f)} ${pascal(f.name)} { get; init; }${
        f.collection ? " = [];" : f.nullable || cs(f.type) === "string" ? " = default!;" : ""}`;
    }).join("\n\n")}
}

${derived.length ? `// ${derived.length} field(s) are derived and the model records their INPUTS, not the arithmetic:
${derived.map(([k, srcs]) => `//   ${k} <- ${srcs.join(" + ")}`).join("\n")}
// A human decides whether each is a sum, a count, a difference or a fold. See OPEN-QUESTIONS.md.
` : ""}
/// <summary>
/// ${multi ? "Multi-stream" : "Single-stream"} projection, registered INLINE in Program.cs: read models are
/// updated in the same transaction as the append, so a GWT's THEN can be asserted immediately.
/// Contrast the write side, which registers nothing and folds live.
${multi ? `///
/// Fed from ${streams.length} streams (${streams.join(", ")}), so events must be grouped explicitly.
/// Grouped by ${KEY.join(" + ")}${guessedKey ? " — GUESSED from the system key, because this read model\n/// declares no identity=. Declare it: a wrong grain groups the wrong rows together." : " (declared on the read model)"}.` : ""}
/// </summary>
// PARTIAL, AND IT IS NOT COSMETIC. Marten 9 dispatches a projection's conventional Apply/Create/ShouldDelete
// methods through the compile-time JasperFx.Events.SourceGenerator, which can only emit into a partial class
// and has NO runtime fallback. Without it the code still COMPILES — 0 errors, 0 warnings — and the host then
// throws InvalidProjectionException("No source-generated dispatcher found") at startup, which is the AD11
// failure shape: a green build proving nothing. Harmless on Marten 8, required on 9, so it is emitted always.
// Measured in reference-implementations/cross-aggregate-invariant/; KIT-FINDINGS AD11.
public sealed partial class ${pascal(v.label)}Projection : ${multi
      ? `MultiStreamProjection<${pascal(v.label)}, ${VIEW_ID}>`
      : `SingleStreamProjection<${pascal(v.label)}, ${VIEW_ID}>`}
{
${multi ? `    public ${pascal(v.label)}Projection()
    {
${v.from.map((l) => {
        const e = ir.shared.events.find((x) => x.label === l);
        const has = KEY.every((k) => e?.fields.some((f) => f.name === k));
        return has
          ? `        Identity<${pascal(l)}>(${viewIdExpr(KEY)});`
          : `        // TODO(codegen): ${pascal(l)} carries ${e?.fields.map((f) => f.name).join(", ") || "nothing"} —\n` +
            `        // not ${KEY.join(" + ")}, so how it groups into this view is a decision.\n` +
            `        // Identity<${pascal(l)}>(e => ...);`;
      }).join("\n")}
    }

` : ""}${v.from.map((l) => {
      const ev = ir.shared.events.find((x) => x.label === l);
      // Does this event look like a member of one of the repeated groups? If it carries every field of
      // a child shape, it almost certainly APPENDS one rather than revising the header — and saying so
      // is the difference between a useful scaffold and a blank `=> current`.
      // MAPPINGS COUNT. A child field may be a rename of what the event carries — children="Revision:
      // revisedTo:..." fed by an event carrying `subject`, with mappings="revisedTo=subject". The
      // completeness check honours that; this hint did not, so the one view in the kit that renames
      // through a group got a blank `=> current` instead of the append line. Same lookup the checker uses.
      const supplies = (c) => {
        const wanted = v.mappings?.[c.name] ?? c.name;
        return ev?.fields.some((ef) => ef.name === wanted);
      };
      // A LIST OF PRIMITIVES IS NOT A GROUP, and `[].every(...)` is TRUE. `takenSlots:int[]` declares no
      // children= — CLAUDE.md is explicit that it needs none — so `v.children["int"]` is undefined, the
      // `?? []` made every() vacuously true, and `shape.map` then crashed codegen outright. The first
      // primitive array on a READ MODEL took the whole run down; the ones that already existed
      // (`recipients:string[]`) are on a command and an event, which never reach this line. So the group
      // has to be DECLARED, not merely absent. KIT-FINDINGS BK3.
      const group = v.fields.find((f) => f.collection && v.children?.[f.type]?.length
                                      && v.children[f.type].every(supplies));
      const shape = group ? v.children[group.type] : null;
      return `    public static ${pascal(v.label)} Apply(${pascal(l)} e, ${pascal(v.label)} current)
${group
        ? `        // TODO(codegen): ${pascal(l)} carries every field of ${pascal(group.type)}, so it almost certainly
        // APPENDS a member rather than revising the header. Immutably, which is the shape Marten's own
        // aggregate-projections docs use for a collection:
        //   => current with { ${pascal(group.name)} = [.. current.${pascal(group.name)}, new ${pascal(group.type)}(${shape.map((c) => `e.${pascal(v.mappings?.[c.name] ?? c.name)}`).join(", ")})] };
        => current;`
        : `        // TODO(codegen): fold ${pascal(l)} into the row.
        => current;`}`;
    }).join("\n\n")}
}
`);
}

// --- validators: the periphery rules ----------------------------------------------------------

const peripheryBySlice = new Map();
for (const s of ir.slices) {
  const p = s.gwts.filter(isPeriphery);
  if (p.length && s.commands.length) peripheryBySlice.set(s, p);
}
// A COMMAND DOES NOT CARRY A VALUE THE MODEL SAYS THE HANDLER MINTS — KIT-FINDINGS BT6.
//
// `terminal="recipeId:generated"` is the model stating that the recipe id arrives from the HANDLER and not
// from the caller. The command record still DECLARES the field — it has to, the event carries it — so every
// "does this command carry the whole key?" test based on `fields=` answered yes, and the generator wired
// stream resolution to a value nobody sends. `default(Guid)` is a perfectly legal stream id, so:
//
//   build clean, host starts, POST returns 204, every stream key resolves 00000000-0000-0000-0000-000000000000,
//   every record in the system lands in ONE stream, and a single-stream view over it is last-write-wins.
//
// Nothing fails, and the first test passes because one record in one stream reads back correctly. It only
// bites on the SECOND instance, which is the pattern this kit's own modelling-debt table already names.
//
// ONE DEFINITION, TWO CALLERS — the command emit below and the decider further down must agree. Two copies
// of this is V9's shape at small scale: the emit would drop the key member while the decider still asked
// the middleware to resolve it, or the reverse.
const mintedIdentityOf = (aggregate, commandLabel) => {
  const owner = ir.shared.aggregates.find((a) => a.commands.some((c) => c.label === commandLabel));
  const minted = new Set((owner?.commands.find((c) => c.label === commandLabel)?.terminal ?? [])
    .filter((t) => t.type === "generated").map((t) => t.name));
  return (aggregate?.identity ?? []).filter((k) => minted.has(k));
};

// One command record per command, always. Derived from the IR, so emit() and not scaffold().
for (const s of ir.slices) {
  if (!s.generates || !s.commands.length) continue;
  const cmd = s.commands[0];
  const agg = ir.shared.aggregates.find((a) => a.commands.some((c) => c.label === cmd));
  const fields = agg?.commands.find((c) => c.label === cmd)?.fields ?? [];

  // THE STREAM KEY, AS A MEMBER OF THE COMMAND — and this exists because a claim this kit repeated in five
  // places turned out to be false.
  //
  // The claim was: "[WriteAggregate] resolves the stream identity from ONE member, so a COMPOSITE key
  // cannot satisfy it and the aggregate handler workflow is unavailable." Measured, and wrong. Wolverine
  // reads any public MEMBER — a computed, get-only property counts — so a command that carries every part
  // of the key can expose the assembled key and opt straight into the workflow:
  //
  //     [WriteAggregate(nameof(ReleaseSlot.StreamKey), Required = false)] ReleaseSlotState? slot
  //
  // Emitted only when the command actually carries every identity field. Where it does not — a create
  // slice whose id is minted, or a decider that must SEARCH for its stream — there is genuinely no key to
  // assemble, and that is a real limit rather than the one the kit used to state. KIT-FINDINGS BM1.
  // Renders `SomeState.StreamKey(A, B)` for an aggregate, given a slice whose state type can compose it.
  // DELEGATED rather than re-interpolated, so the key format has exactly one definition: two copies of a
  // composite key format is how two call sites end up addressing two different streams.
  const keyMemberFor = (a, memberName, why) => {
    const keys = a?.identity ?? [];
    if (!keys.length || !keys.every((k) => fields.some((f) => f.name === k))) return "";
    // DECLARED IS NOT CARRIED. A key field the model marks terminal="…:generated" is minted by the handler,
    // so the caller never sends it and an assembled key would evaluate to default(T) on every request.
    // There is no member to emit, and emitting one is worse than emitting none — it compiles. BT6.
    if (mintedIdentityOf(a, cmd).length) return "";
    const writesThis = (x) => x.generates && x.commands.length
      && ir.shared.aggregates.find((g) => g.commands.some((c) => c.label === x.commands[0]))?.name === a.name;
    // PREFER A SLICE IN THIS COMMAND'S OWN CONTEXT. Any slice writing the aggregate can compose the key —
    // they all delegate to the same identity — but picking the first in IR order is arbitrary, and with two
    // models it reached ACROSS CONTEXTS: charging's LapseHold resolved its stream key through estate's
    // AutoWithdrawState. Correct, and confusing to read and fragile to a rename in a context that has no
    // other reason to care. Falls back to any writer, because a command may legitimately write an aggregate
    // its own context never otherwise touches.
    const owner = ir.slices.find((x) => x.context === s.context && writesThis(x))
               ?? ir.slices.find(writesThis);
    if (!owner) return "";
    // QUALIFY THE STATE TYPE BY ITS OWN CONTEXT, because the slice that owns an aggregate's key is not
    // necessarily in the same namespace as the command using it. State classes live in
    // `<NS>.Slices.<Context>`, and with TWO MODELS one aggregate is legitimately written from both: in
    // Voltway the Bay stream carries the estate team's commissioning and faults AND the charging team's
    // holds and charges, so charging's CancelHold resolved its key through estate's AutoWithdrawState and
    // did not compile — CS0103, six times. Latent until a system had a second model, which is exactly the
    // class of defect a one-model kit cannot find.
    //
    // `global::` IS LOAD-BEARING, not decoration. A plain `Allocation.Slices.Allocation.ReserveSlotState`
    // written INSIDE namespace `Allocation.Slices.Allocation` resolves relative to the current namespace
    // and looks for `Allocation.Slices.Allocation.Allocation.…` — CS0234. Voltway happened to compile
    // without it only because its system name (Voltway) differs from its context names (Charging, Estate);
    // every reference implementation, where system and context are the same word, did not. Caught by
    // regenerating three of them rather than by reading the diff.
    const qualified = `global::${NS}.Slices.${pascal(owner.context)}.${stateName(owner)}`;
    return `
    /// <summary>${why}</summary>
    public ${STREAM_ID} ${memberName} => ${qualified}.StreamKey(${keys.map((k) => {
      const f = fields.find((x) => x.name === k);
      // The state's StreamKey takes the field's own type for a composite key and the STORE's id type for
      // a single one — so a single Guid key on a string-identity store needs .ToString().
      const needsToString = keys.length === 1 && STREAM_ID === "string" && cs(f?.type) !== "string";
      return pascal(k) + (needsToString ? ".ToString()" : "");
    }).join(", ")});
`;
  };

  const ownKey = fields.some((f) => f.name === "streamKey") ? "" : keyMemberFor(agg, "StreamKey",
    `The stream this command WRITES to, assembled from the identity fields the model says it carries.
    /// A COMPUTED member on purpose: the aggregate handler workflow resolves a stream from a public MEMBER,
    /// and a get-only property is one — which is what lets a composite-keyed stream use
    /// <c>[WriteAggregate(nameof(${pascal(cmd)}.StreamKey))]</c> instead of a hand-rolled FetchForWriting.`);

  // AND THE STREAMS IT ONLY READS. A command whose fields carry another aggregate's whole key is a
  // cross-stream slice — exactly the ones `architect` raises as `cross-stream-rule` — and Wolverine can
  // fetch that stream too, with `AlwaysEnforceConsistency = true` to version-check it even though nothing
  // is appended there. Without the member there is no seam and the answer defaults to "accept the window".
  const otherKeys = ir.shared.aggregates
    .filter((a) => a.name !== agg?.name)
    .map((a) => keyMemberFor(a, `${pascal(a.name)}StreamKey`,
      `A stream this command READS but does not write. Hand it to a second
    /// <c>[WriteAggregate(nameof(${pascal(cmd)}.${pascal(a.name)}StreamKey), AlwaysEnforceConsistency = true)]</c>
    /// parameter and Marten refuses the save if that stream moved between the fetch and the commit.`))
    .join("");

  const streamKeyMember = ownKey + otherKeys;

  emit(join(APP, "Slices", pascal(s.context), pascal(s.name), `${pascal(cmd)}.cs`),
    `${banner(`${cmd} — the command as the model declares it`)}
namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// Slice: ${s.name}. Fields exactly as the model declares them: ${fields.map((f) => f.name).join(", ") || "none"}.
/// Emitted for every command, whether or not the slice has periphery rules — a validator-free
/// command still needs a type.
/// </summary>
public sealed record ${pascal(cmd)}(${params(fields)})${streamKeyMember ? `
{${streamKeyMember}}` : ";"}
`);
}

for (const [s, gwts] of peripheryBySlice) {
  const cmd = s.commands[0];
  const agg = ir.shared.aggregates.find((a) => a.commands.some((c) => c.label === cmd));
  const fields = agg?.commands.find((c) => c.label === cmd)?.fields ?? [];
  scaffold(join(APP, "Slices", pascal(s.context), pascal(s.name), `${pascal(cmd)}Validator.cs`),
    `${banner(`${cmd} — periphery validation for slice "${s.name}"`)}
using FluentValidation;

// The CONTEXT namespace, not a per-slice one. A per-slice namespace collides with the command record
// itself whenever the slice and its command share a name — prepare-email / PrepareEmail, book-hours /
// BookHours — which is the normal case, not an edge one. Declaring namespace X.Y.PrepareEmail puts a
// member PrepareEmail in X.Y, where the record already lives: CS0101.
//
// This shipped broken for months because the validator is SCAFFOLD: the first agent to hit it fixed the
// namespace by hand, its project went green, and the generator never learned. A hand fix to a scaffold
// file does not feed back — see ANTI-PATTERNS.md #13 for the same shape.
namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// Only rules that need nothing but the request. A GWT with no GIVEN is a statement about the
/// message alone, so it can be rejected before any stream is read. Rules whose GIVEN names events
/// are decisions about accumulated state and live in the endpoint, where the aggregate is visible.
/// </summary>
public sealed class ${pascal(cmd)}Validator : AbstractValidator<${pascal(cmd)}>
{
    public ${pascal(cmd)}Validator()
    {
${gwts.map((g) => `        // ${ruleName(g)}: ${(g.rule ?? "").replace(/\s+/g, " ")}
        // TODO(codegen): RuleFor(x => x.?).Must(...).WithMessage("${ruleName(g)}");`).join("\n\n")}
    }
}

// The ${pascal(cmd)} record itself is emitted next door, per command rather than per validator.
`);
}

// --- the decider: an A-FRAME seam per command slice --------------------------------------------
//
// KIT-FINDINGS A11 for five runs: "the command record, the fold and the test are generated; THE DECIDER IS
// NOT, so every state-change slice starts with an empty folder and a hand-written file." Every one of those
// hand-written files then reached for `IDocumentSession` + `FetchForWriting` + `SaveChangesAsync` + a
// try/catch, because nothing showed them the alternative — and the kit's own docs told them the alternative
// was unavailable (BM1). The absent scaffold is *how* the drift happened, so closing the gap is also the fix.
//
// What is emitted is the SHAPE, never the decision: the signature, the middleware attributes, the stream
// key member to resolve, and one TODO per rule the model states. SCAFFOLD, so a hand edit survives.
//
//   state-change   an HTTP endpoint — somebody types this command
//   automation     a message HANDLER — the trigger issues it in process, and giving it a route would
//   translation    invent public surface the model does not draw
// WHAT SHAPE IS THIS SLICE'S DECIDER, ACCORDING TO THE TREE?
//
// BY SHAPE, NEVER BY FILENAME — the lesson the read endpoint paid for in BP4, and the stakes here are
// higher. Hand-written deciders are named after the COMMAND and not the slice, so the filenames in this repo
// include `RaiseRepairJobHandler.cs` on slice `schedule-repair`, `WithdrawFaultyBayHandler.cs` on
// `auto-withdraw` and `RecordChargingStopHandler.cs` on `translate-charge-stop`. A filename check would miss
// every one of them and write a SECOND handler for the same command.
//
// WHAT A DUPLICATE HANDLER COSTS WAS MEASURED, not assumed, and it is worse than a duplicate route because
// nothing at all complains. A second discovered handler for `BookRoom` in Demo001: build 0 warnings
// 0 errors, host starts, fixture comes up, **no exception and no ambiguity error anywhere** — the caller
// simply got the OTHER handler's answer (`title: "ZzProbeRanInstead"`), and 7 of 18 tests failed on wrong
// business behaviour rather than on any infrastructure signal. Whether Wolverine also ran the real one was
// not established and does not change the symptom: a silently substituted decision.
//
// (The first attempt at that measurement returned GREEN and was nearly believed. The probe class was named
// `...Probe`, and Wolverine's conventional discovery only finds `*Handler`/`*Consumer` — so it was never
// registered. A broken instrument reporting "no problem", caught only by asking why it could not fail.)
const httpArmOnContended = [];
const twoFileWritten = [];
// BT6: slices whose stream key is minted, split by whether the generator could write the whole recipe.
const createStreamWritten = [];
const idGenerationUndecided = [];
const streamFromMintedMember = [];
const HTTP_ATTR = /\[Wolverine(Post|Put|Delete|Patch)/;
const stripComments = (t) => t.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const sliceCsFiles = (dir) => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".cs"))
      .map((e) => ({ path: join(dir, e.name), src: stripComments(readFileSync(join(dir, e.name), "utf8")) }))
  : []);

const existingDeciderShape = (cmd, dir) => {
  const files = sliceCsFiles(dir);
  // A DECIDER IS ANY METHOD THAT TAKES THE COMMAND — however it resolves its stream.
  //
  // The first version of this required `[WriteAggregate]`/`[Aggregate]`, and that was WRONG in the most
  // expensive available way. CLAUDE.md names two good reasons to leave the aggregate handler workflow — a
  // decider that must SEARCH for its stream, and a slice whose whole point is a concurrency MECHANISM — and
  // a hand-rolled `FetchForWriting` decider carries neither attribute. So four such slices read as "no
  // decider here" and got a second one written beside them: Voltway's hold-bay, register-driver and
  // commission-bay, and `cross-aggregate-invariant`'s release-commitment — the last in the folder built to
  // study exactly those mechanisms. That is the duplicate handler measured above, generated on purpose by
  // the check meant to prevent it.
  //
  // So the test is the command type followed by a parameter name, which every one of those forms has. A
  // false positive means a scaffold is not written; a false negative means a silently substituted decision.
  // Only one of those is recoverable, so the loose test is the correct one.
  const takesCommand = (f) => new RegExp(String.raw`\b${pascal(cmd)}\s+[a-z]\w*`).test(f.src);
  const isDecider = (f) => takesCommand(f) && !/bus\.InvokeAsync/.test(f.src);
  // TWO PREDICATES, FOR TWO DIFFERENT QUESTIONS, and conflating them made the report cry wolf.
  //
  //   "is there already a decider here?"  -> LOOSE. Any mechanism counts, so nothing is duplicated.
  //   "is it on the arm the retry cannot reach?" -> STRICT. Only where the MIDDLEWARE owns the save.
  //
  // The distinction is CLAUDE.md's own: once `[WriteAggregate]`/`[Aggregate]` owns the transaction the
  // decider *cannot* catch the collision, so the message-pipeline retry is the only answer and an HTTP
  // endpoint does not get it. A hand-rolled `FetchForWriting`/`IDocumentSession` endpoint owns its own
  // transaction and catches for itself — that is one of the two documented good reasons to leave the
  // workflow, and reporting it would be flatly wrong. Measured on `release-commitment` in
  // reference-implementations/cross-aggregate-invariant/, the folder built to study those mechanisms: the
  // loose predicate reported it, and its endpoint is a deliberate guard-row arm.
  const middlewareOwned = (f) => /\[WriteAggregate|\[Aggregate\]/.test(f.src);
  return {
    anyDecider: files.find(isDecider)?.path ?? null,
    httpArmDecider: files.find((f) => HTTP_ATTR.test(f.src) && isDecider(f) && middlewareOwned(f))?.path ?? null,
    messageDecider: files.find((f) => !/\[Wolverine(Post|Put|Delete|Patch|Get)/.test(f.src) && isDecider(f))?.path ?? null,
    thinEndpoint: files.find((f) => HTTP_ATTR.test(f.src) && /bus\.InvokeAsync/.test(f.src))?.path ?? null,
  };
};

for (const s of ir.slices) {
  if (!s.generates || !s.commands.length) continue;
  const cmd = s.commands[0];
  const agg = ir.shared.aggregates.find((a) => a.commands.some((c) => c.label === cmd));
  const fields = agg?.commands.find((c) => c.label === cmd)?.fields ?? [];
  // A SLICE THAT MINTS ITS OWN STREAM KEY CREATES THE STREAM — it does not resolve one. BT6.
  const mintedKeys = mintedIdentityOf(agg, cmd);
  const createsStream = mintedKeys.length > 0;
  const carriesKey = !createsStream
    && (agg?.identity ?? []).length && agg.identity.every((k) => fields.some((f) => f.name === k));
  const http = s.pattern === "state-change";
  const rejections = (s.gwts ?? []).filter((g) => !isPeriphery(g) && /^error:/i.test((g.then ?? "").trim()));
  const emitted = (s.emits ?? []);

  // A decider that must SEARCH for its stream has no key to hand the middleware. Say so instead of
  // emitting an attribute that cannot work — reference-implementations/reservation/SlotReservation is the
  // worked example, and it is the honest limit of the workflow rather than the one the kit used to state.
  const aggregateParam = carriesKey
    ? `        [WriteAggregate(nameof(${pascal(cmd)}.StreamKey), Required = false)] ${stateName(s)}? state`
    : `        // TODO(codegen): this command does not carry ${agg?.name ?? "the aggregate"}'s whole key
        //   (${(agg?.identity ?? []).join(" + ") || "no identity="}), so the middleware has no stream to resolve.
        //   Either add the missing field to the command on the MODEL, or fetch the stream by hand — see
        //   reference-implementations/reservation/SlotReservation, a decider that has to search for its stream.
        IDocumentSession session`;

  // --- V7 / BP2: A CONTENDED HTTP SLICE NEEDS THE DECIDER OFF THE HTTP ARM ------------------------
  //
  // `opts.OnException<...>().RetryTimes(3)` is a MESSAGE-PIPELINE policy. A Wolverine.HTTP endpoint never
  // enters that pipeline, so on a contended slice a lost race escapes as a bare 500 instead of the ordinary
  // refusal — measured, both arms, 8 writers at one room-day:
  //
  //   decider through the bus   204x1, 400x7  (the rule name)
  //   decider inline on HTTP    204x1, 7x escaped EventStreamUnexpectedMaxEventIdException
  //
  // So a contended slice gets TWO files: the decider as a message handler, and a thin endpoint that invokes
  // it through the bus. Everything else keeps the single HTTP arm, which CLAUDE.md calls the DEFAULT — a
  // slice with no contended rejection has no race to retry, so the extra hop and the extra outcome type buy
  // nothing. KIT-FINDINGS BP2.
  //
  // THE PAIR IS A UNIT, AND THAT DECIDES WHAT HAPPENS TO AN EXISTING PROJECT. Both files are `scaffold`, so
  // a hand-owned endpoint with the decider inline cannot be restructured by a generator. Writing only the
  // handler half would leave a discovered message handler that NOTHING INVOKES, throwing
  // NotImplementedException, with a TODO nobody can honestly close — the same dead-scaffold shape as the
  // translation ingest seam in BP12. So: write both when neither exists, keep both when both do, and
  // otherwise write NOTHING and report. That is BP2's own prescription — "the fix is a report".
  const sliceDir = join(APP, "Slices", pascal(s.context), pascal(s.name));
  const contended = http && contendedSlices.has(s.name);
  const existing = existingDeciderShape(cmd, sliceDir);
  // Write the pair ONLY when this slice has no decider of any kind — a fresh slice. Anything already
  // deciding this command is hand-owned and cannot be restructured from here.
  const twoFile = contended && !existing.anyDecider;

  if (contended && existing.httpArmDecider && !existing.messageDecider) {
    httpArmOnContended.push({ slice: s.name, path: existing.httpArmDecider });
  }

  // --- BT6: A SLICE THAT MINTS ITS OWN KEY *CREATES* ITS STREAM, IT DOES NOT RESOLVE ONE ----------
  //
  // The generator used to hand `[WriteAggregate(nameof(Cmd.StreamKey))]` to a command whose key the model
  // marks terminal="…:generated". The caller never sends that value, so the key was default(Guid) on every
  // request and every record in the system landed in ONE stream — with a clean build, a 204, and a first
  // test that passes because one record in one stream reads back correctly.
  //
  // WHAT REPLACES IT IS WOLVERINE'S OWN DOCUMENTED IDIOM, not an invention of this kit:
  // `guide/http/metadata` + `tutorials/cqrs-with-marten` show `(CreationResponse<Guid>, IStartStream)` with
  // `MartenOps.StartStream`, and CreationResponse writes 201, the Location header and the new id into the
  // body. That is why [EmptyResponse] cannot survive here: a caller cannot know an id it did not supply.
  //
  // THE ID IS MINTED IN THE HANDLER RATHER THAN BY MARTEN, and that is forced by the MODEL rather than
  // chosen. `MartenOps.StartStream<T>(events)` — the no-id overload — has Marten assign the stream id, but
  // it assigns it AFTER the events are built, so the events cannot carry it. Every model in this kit
  // declares the key as a FIELD of its event (that is how a view keyed on it is sourced at all), so the
  // value has to exist before the event does. Minting it here and passing it to both is the only shape that
  // satisfies the model.
  //
  // Guid.CreateVersion7() and not Guid.NewGuid(): a stream id is a primary key, and Marten's own identity
  // page recommends a sequential Guid because a random v4 fragments the index. Marten's `CombGuid` is that
  // recommendation, and `CombGuidIdGeneration` carries [Obsolete] as of the Marten 9 migration guide — so
  // the BCL's sequential v7 is the non-obsolete form of the same advice, and it is what the critter-stack's
  // own docs use for a caller-minted id (wolverine/guide/durability/efcore/domain-events).
  if (createsStream && http) {
    // A kept scaffold cannot be restructured from here — the generator does not reach backwards — so an
    // already-hand-owned endpoint on the wrong shape is REPORTED and left alone.
    if (existing.httpArmDecider) {
      streamFromMintedMember.push({ slice: s.name, cmd: pascal(cmd), path: existing.httpArmDecider,
        keys: mintedKeys.join(", ") });
    }
    if (!existing.anyDecider) {
      const C = pascal(cmd);
      const idField = mintedKeys[0];
      // WHERE THE GENERATOR STOPS. A Guid key on a Guid-identity store is fully derivable. Anything else —
      // a string key, a composite with a minted part — needs an id FORMAT, and a format is a domain
      // decision with a collision rule attached. Named rather than guessed, exactly as a view whose recipe
      // cannot be read off the tree gets NO READ ENDPOINT GENERATED instead of a Query<T>() that compiles
      // and returns nothing for ever.
      const derivable = STREAM_ID === "Guid" && (agg?.identity ?? []).length === 1 && mintedKeys.length === 1;
      if (!derivable) idGenerationUndecided.push({ slice: s.name, cmd: C, keys: mintedKeys.join(", "),
        why: STREAM_ID === "string"
          ? `the store's stream identity is AsString, so no Guid scheme applies and the FORMAT of ${idField} is a domain decision`
          : `${(agg?.identity ?? []).join(" + ")} is composite, so only part of the key is minted` });
      else createStreamWritten.push({ slice: s.name, cmd: C, idField });

      const eventShape = emitted.map((l) => {
        const e = ir.shared.events.find((x) => x.label === l);
        return `        //   new ${pascal(l)}(${(e?.fields ?? []).map((f) =>
          f.name === idField ? camel(idField) : `command.${pascal(f.name)}`).join(", ")})`;
      }).join("\n") || "        //   (the model names no event for this slice)";

      scaffold(join(sliceDir, `${C}Endpoint.cs`),
        `${banner(`${s.name} — the decider for a slice that CREATES its stream. Scaffolded once, then hand-owned.`)}
using Wolverine.Http;
using Wolverine.Marten;
using ${NS}.Contracts;

namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// THIS SLICE CREATES ITS STREAM, so there is no stream to resolve and no <c>[WriteAggregate]</c> here.
/// The model marks <c>${mintedKeys.join(", ")}</c> as <c>terminal="…:generated"</c> — the handler supplies
/// it, the caller does not — which is precisely why the aggregate handler workflow does not apply: an
/// assembled key would read a value nobody sent and resolve <c>default</c> on every request, putting every
/// record in the system into one stream with a clean build and a 204. KIT-FINDINGS BT6.
///
/// <c>(CreationResponse&lt;T&gt;, IStartStream)</c> IS WOLVERINE'S OWN SHAPE for this, not a local
/// invention — see <c>guide/http/metadata</c> and <c>tutorials/cqrs-with-marten</c> in the docs mirror.
/// <c>CreationResponse</c> implements <c>IHttpAware</c>: it writes <b>201</b>, sets the <c>Location</c>
/// header, and puts the new id in the body. <c>[EmptyResponse]</c> is therefore impossible here, and that is
/// the point rather than a limitation — a caller cannot know an id it did not supply.
///
/// THE ID IS MINTED HERE AND CARRIED INTO BOTH the event and the stream key, and they must be the SAME
/// value or a view keyed on <c>${idField}</c> can never find the stream it came from. Marten can assign a
/// stream id itself (the <c>MartenOps.StartStream&lt;T&gt;(events)</c> overload with no id), but it assigns
/// it after the events are built — and this model declares <c>${idField}</c> as a field OF the event, so the
/// value must exist first.
///
/// <c>Guid.CreateVersion7()</c>, never <c>Guid.NewGuid()</c>: a stream id is a primary key and Marten's
/// identity page asks for a sequential Guid because a random v4 fragments the index. Marten's own
/// <c>CombGuidIdGeneration</c> is that idea and is <c>[Obsolete]</c> as of Marten 9, so v7 is the
/// non-obsolete form of the same advice.
/// </summary>
public static class ${C}Endpoint
{
    public const string Route = "/${camel(s.context)}/${camel(s.name)}";
${[...new Set(rejections.map((g) => ruleName(g)))]
  .map((n) => `    public const string ${n} = "${n}";`).join("\n")}${rejections.length ? "\n" : ""}
    [WolverinePost(Route)]
    public static (CreationResponse<${STREAM_ID}>, IStartStream) Handle(${C} command)
    {${rejections.length ? `
        // TODO(codegen): THIS SLICE HAS ${rejections.length} MODELLED REJECTION(S), and a creating slice has no
        // prior state to fold — so each is either a periphery rule (put it in ${C}Validator) or a rule about
        // ANOTHER stream, which needs a read this signature does not have. Returning a refusal from here
        // means widening the return to (IResult, IStartStream?) — Wolverine null-checks the side effect —
        // and building the 201 with Results.Created instead of CreationResponse:
${rejections.map((g) => `        //   ${ruleName(g)}: ${(g.rule ?? "").replace(/\s+/g, " ")}`).join("\n")}
` : ""}
        // TODO(codegen): mint the id, build the event(s) this slice promises, and start the stream:
        //
        //   var ${camel(idField)} = Guid.CreateVersion7();
${eventShape}
        //   var start = MartenOps.StartStream<${stateName(s)}>(${camel(idField)}, /* the event(s) above */);
        //   return (new CreationResponse<${STREAM_ID}>($"{Route}/{start.StreamId}", start.StreamId), start);
${derivable ? "" : `        //
        // AND THE ID FORMAT IS NOT DECIDED. ${STREAM_ID === "string"
          ? "This store's stream identity is AsString, so Guid.CreateVersion7() does NOT apply"
          : `${(agg?.identity ?? []).join(" + ")} is composite, so only ${mintedKeys.join(", ")} is minted`} —
        // what a valid ${idField} looks like, and what happens when two callers mint the same one, is a
        // domain decision. It belongs in ARCHITECTURE.md under id-generation/${s.name}, not in this file.
`}        throw new NotImplementedException("TODO(codegen): the decision for ${s.name}.");
    }
}
`);
    }
    continue;
  }

  if (twoFile) {
    const C = pascal(cmd);
    const outcome = `${C}Outcome`;
    const consts = [...new Set(rejections.map((g) => ruleName(g)))];

    if (!existing.messageDecider) twoFileWritten.push({ slice: s.name, cmd: C });

    // ---- file 1: the decider, as a MESSAGE handler ------------------------------------------------
    scaffold(join(sliceDir, `${C}Handler.cs`),
      `${banner(`${s.name} — the decider, OFF the HTTP arm. Scaffolded once, then hand-owned.`)}
using JasperFx.Events;
using Marten;
using Wolverine.Marten;
using ${NS}.Contracts;

namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// A PURE DECIDER: <c>(command, state) -&gt; events</c>, as a Wolverine MESSAGE handler — no HTTP anywhere in
/// this file. No session, no fetch, no save, no try/catch; <c>[WriteAggregate]</c> fetches the stream, folds
/// it live, and carries its version into the append.
///
/// WHY THIS IS NOT ON THE ENDPOINT, WHICH IS THE WHOLE POINT OF THE PAIR. \`architect\` flagged this slice as
/// a CONTENDED INVARIANT: a rejection here depends on state in the very stream the command appends to, so two
/// callers at the same instant can both fold a state that passes the rule. What refuses the loser is
/// optimistic concurrency plus <c>opts.OnException&lt;...&gt;().RetryTimes(3)</c> in Program.cs — and that is a
/// MESSAGE-PIPELINE policy. A Wolverine.HTTP endpoint never enters that pipeline, so with the decider inline
/// on the endpoint the collision escapes as a bare 500. Measured, 8 writers at one key:
///
/// <code>
///   decider through the bus   204x1, 400x7  (the rule name)
///   decider inline on HTTP    204x1, 7x escaped EventStreamUnexpectedMaxEventIdException
/// </code>
///
/// On the retry the middleware re-fetches, the state now includes the winner's event, and THE ORDINARY RULE
/// below refuses it. So do NOT add a try/catch here and do NOT translate a version conflict into a rule
/// name: a conflict does not mean the business rule failed, and on a stream another context also appends to
/// an unrelated write collides too. A retry re-reads; a translation guesses. KIT-FINDINGS V7, BP2.
///
/// THE RETURN TUPLE IS <c>(${outcome}, Events)</c> AND BOTH SLOTS ARE LOAD-BEARING. In the aggregate handler
/// workflow a returned value is APPENDED, so an outcome returned on its own would be written to the stream —
/// which is not an event and has no business there. <c>Events</c> is Wolverine's explicit "these go on the
/// stream" collection, leaving the other slot as what <c>InvokeAsync&lt;T&gt;</c> hands back. An empty
/// <c>Events</c> appends nothing, so a refusal is a tuple with nothing in it. An <c>out</c> parameter does not
/// work — <c>CS1615</c> — and because the failure is in GENERATED code it takes the whole host down.
///
/// <c>Required = false</c> so a MISSING stream reaches the decider as null. Left required, a message handler
/// "logs that the aggregate was not found and stops processing" — the message is discarded, so a GWT saying
/// <c>then="error: X"</c> would be unobservable: nothing fails and the rule quietly does not exist.
/// </summary>
public static class ${C}Handler
{
${consts.map((n) => `    public const string ${n} = "${n}";`).join("\n")}${consts.length ? "\n" : ""}
    public static (${outcome}, Events) Handle(
        ${C} command,
${aggregateParam})
    {
        var events = new Events();

${rejections.map((g) => `        // ${ruleName(g)}: ${(g.rule ?? "").replace(/\s+/g, " ")}
        // TODO(codegen): if (state is ...) return (${outcome}.Rejected(${ruleName(g)}, "…"), events);`).join("\n\n")}${rejections.length ? "\n" : ""}
        // TODO(codegen): decide, then append the event(s) this slice promises and return the outcome:
${emitted.map((e) => `        //   events += new ${pascal(e)}(…);`).join("\n") || "        //   (the model names none)"}
        throw new NotImplementedException("TODO(codegen): the decision for ${s.name}.");
    }
}

/// <summary>
/// What the caller reads back. Same shape as an automation's outcome, and for the same reason: this handler
/// has no HTTP caller, so <c>Rule</c> carries what <c>Title</c> would have. The thin endpoint next door is
/// what turns it back into ProblemDetails — see Rejections.cs for why the rule name is in <c>title</c> on
/// both enforcement paths.
///
/// IT CARRIES NO SUCCESS PAYLOAD, and that is a refusal to guess rather than an oversight. What a caller
/// wants back is a domain answer the model does not state: on a slice that MINTS an id
/// (<c>terminal="x:generated"</c>) it is usually that new id, which is not any part of the stream key. Add
/// the field if the caller needs one — <c>Succeeded</c> plus the rule name is all the contract requires.
/// </summary>
public sealed record ${outcome}(string? Rule, string? Detail)
{
    public bool Succeeded => Rule is null;

    // TODO(codegen): if the caller needs something back on success — a minted id, a new version — add it
    // here and to Ok(). ${(s.terminals ?? []).some((t) => t.kind === "generated")
      ? `This slice declares terminal="${(s.terminals ?? []).filter((t) => t.kind === "generated").map((t) => t.name).join(", ")}:generated", so it probably does.`
      : "Nothing on the model suggests it does."}
    public static ${outcome} Ok() => new(null, null);

    public static ${outcome} Rejected(string rule, string detail) => new(rule, detail);
}
`);

    // ---- file 2: the thin HTTP adapter -----------------------------------------------------------
    scaffold(join(sliceDir, `${C}Endpoint.cs`),
      `${banner(`${s.name} — the thin HTTP adapter. Scaffolded once, then hand-owned.`)}
using Wolverine;
using Wolverine.Http;

namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// FIVE LINES, AND NO DECISION IN THEM. The decider is <see cref="${C}Handler"/>; this invokes it through the
/// bus, which is the only path on which Program.cs's <c>OnException&lt;...&gt;().RetryTimes(3)</c> exists.
/// Inlining the decision back into this method would compile, pass every GWT, and silently give that up —
/// which is exactly the defect KIT-FINDINGS BP2 records.
///
/// <c>[EmptyResponse]</c> IS DELIBERATELY ABSENT. It forces 204 and a returned ProblemDetails is discarded, so
/// on a slice that can REFUSE it makes the endpoint report success for a rejected command.
///
/// WHERE A TERMINAL VALUE GOES. <c>terminal="x:generated"</c> and <c>terminal="x:actor"</c> are facts about the
/// REQUEST, not about the stream, so they are resolved HERE and not in the decider — that is what keeps the
/// decider a pure function of (command, state).${(s.terminals ?? []).length ? `
/// This slice declares: ${(s.terminals ?? []).map((t) => `${t.name}:${t.kind}`).join(", ")}.` : ""}
/// </summary>
public static class ${C}Endpoint
{
    public const string Route = "/${camel(s.context)}/${camel(s.name)}";
${consts.map((n) => `
    /// <summary>The rule name lives on the decider; re-exported so a caller of either has one spelling.</summary>
    public const string ${n} = ${C}Handler.${n};`).join("")}

    [WolverinePost(Route)]
    public static async Task<IResult> Handle(${C} command, IMessageBus bus)
    {
        // TODO(codegen): resolve any terminal= value here (a generated id, the authenticated principal, the
        // clock) and pass it on the command. Then leave the decision where it is.
        var outcome = await bus.InvokeAsync<${outcome}>(command);

        return outcome.Succeeded
            ? Results.NoContent()
            : Rejections.Problem(outcome.Rule!, outcome.Detail!);
    }
}
`);
    continue;
  }

  scaffold(join(sliceDir, `${pascal(cmd)}${http ? "Endpoint" : "Handler"}.cs`),
    `${banner(`${s.name} — the decider. Scaffolded once, then hand-owned.`)}
using JasperFx.Events;
using Marten;
using Wolverine.Marten;${http ? `
using Wolverine.Http;` : ""}
using ${NS}.Contracts;

namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// A PURE DECIDER: <c>(command, state) -&gt; events</c>. No session, no fetch, no save, no try/catch —
/// Wolverine's aggregate handler workflow does all of it as middleware, which is the "A-Frame" shape its
/// own docs recommend and the Decider pattern its Marten page names.
///
/// It is also what both books ask for. <em>The little Eventmodeling Book</em> ch. 15 warns that a command
/// handler which reaches for its own dependencies "is no longer pure" and that testing it then "requires a
/// mocking framework"; its implementation example is exactly this signature.
///
/// <c>Required = false</c> so a MISSING stream reaches the decider as null instead of becoming a framework
/// 404 with no rule name in the body — this kit's contract is that the rule name is the machine-readable
/// outcome, because a GWT says <c>then="error: X"</c>.${http ? `
///
/// <c>[EmptyResponse]</c> makes a returned event get APPENDED rather than serialised as the response body.
/// Drop it and return <c>(IResult, Events)</c> as soon as this slice can REFUSE: with [EmptyResponse] a
/// returned ProblemDetails is silently discarded and the endpoint reports success for a rejected command.` : ""}
///
/// APPENDING TO MORE THAN ONE STREAM? Returned events then have no unambiguous destination and are appended
/// NOWHERE, silently. Take <c>IEventStream&lt;T&gt;</c> for the stream you write, and add a second
/// <c>[WriteAggregate(..., AlwaysEnforceConsistency = true)]</c> for a stream you only READ so Marten
/// version-checks it too. The command already carries a key member for every such stream.
///
/// A CONCURRENT DUPLICATE IS NOT CAUGHT HERE, and WHERE IT GOES DEPENDS ON HOW THIS IS INVOKED.
///
///   as a MESSAGE (IMessageBus.InvokeAsync)  -> Program.cs's OnException(...).RetryTimes(3) applies, the
///                                              middleware re-fetches, and THE ORDINARY RULE below refuses
///                                              the loser. This is the shape the kit describes.
///   as an HTTP ENDPOINT                     -> IT DOES NOT. A Wolverine.HTTP endpoint never enters the
///                                              message pipeline, so that policy is not reached and the
///                                              collision leaves as a 500. KIT-FINDINGS V7, measured by
///                                              dumping this method with the codegen-write command:
///                                              FetchForWriting -> Handle -> AppendMany -> SaveChangesAsync,
///                                              with no try/catch anywhere in it.
///
/// So an HTTP state-change slice that relies on the retry needs a 5-line endpoint that invokes this
/// decider through the bus. Do NOT instead translate the collision with Wolverine.HTTP's OnException
/// convention: a version conflict does not mean the business rule failed — on a stream shared with another
/// context, an unrelated concurrent append collides too, and the translation refuses a valid command with
/// a rule name that is untrue. A retry re-reads; a translation guesses.
///
/// Either way, do not re-implement it as a try/catch in the decider: the decider stays a pure function.
/// </summary>
public static class ${pascal(cmd)}${http ? "Endpoint" : "Handler"}
{
${http ? `    public const string Route = "/${camel(s.context)}/${camel(s.name)}";
` : ""}${
// ONE CONSTANT PER DISTINCT RULE NAME, NOT PER GWT — and the difference is a project that does not
// compile. Two GWTs on one slice legitimately share a rejection: "there is nothing to cancel on a free
// bay" and "a hold that already lapsed cannot be cancelled" are both `error: NoLiveHold`, because the
// caller genuinely gets the same refusal for two different histories. That is good modelling, and it
// emitted `public const string NoLiveHold` twice — CS0102, five times over, on the first model that had
// one. Found by the scaffold gate rather than by reading, which is the whole reason that gate exists.
[...new Set(rejections.map((g) => ruleName(g)))]
  .map((n) => `    public const string ${n} = "${n}";`).join("\n")}${rejections.length ? "\n" : ""}
${http ? `    [WolverinePost(Route), EmptyResponse]
    public static ${emitted.length === 1 ? pascal(emitted[0]) : "Events"} Handle(
` : `    public static Events Handle(
`}        ${pascal(cmd)} command,
${aggregateParam})
    {
${rejections.map((g) => `        // ${ruleName(g)}: ${(g.rule ?? "").replace(/\s+/g, " ")}
        // TODO(codegen): if (state is ...) return ${http ? "the refusal" : "no events"};`).join("\n\n")}${rejections.length ? "\n" : ""}
        // TODO(codegen): decide, and return the event(s) this slice promises:
${emitted.map((e) => `        //   ${pascal(e)}`).join("\n") || "        //   (the model names none)"}
        throw new NotImplementedException("TODO(codegen): the decision for ${s.name}.");
    }
}
`);
}

// --- the Alba harness -------------------------------------------------------------------------

emit(join(TESTS, "AppFixture.cs"),
  `${banner("Alba + Testcontainers harness shared across the whole test collection")}
using Alba;
using JasperFx.CommandLine;
using Marten;
using Marten.Schema;
// UseEnvironment is an extension on IWebHostBuilder and lives HERE, not in Microsoft.Extensions.Hosting.
// Without it the call below fails with CS1061 and reads like the method does not exist.
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;
using Wolverine;
using Wolverine.ErrorHandling;         // OnException<T>() is an extension on IWithFailurePolicies; no doc page names it
using Xunit;

namespace ${NS}.IntegrationTests;

/// <summary>
/// One Postgres for the whole assembly, and one host. Building either per test is the difference
/// between a suite that runs in seconds and one nobody waits for.
///
/// This container is NOT the docker-compose Postgres. They must never share a connection string:
/// Marten manages schema, so a test run pointed at the demo database would drop the demo data, and
/// Testcontainers owns a lifecycle that compose would fight.
/// </summary>
public sealed class AppFixture : IAsyncLifetime
{
    // The image goes in the CONSTRUCTOR, not in .WithImage(). The parameterless PostgreSqlBuilder() is
    // obsolete and warns (CS0618). Testcontainers is the one library not in reference/llms/, so this was
    // written from unverifiable knowledge and the compiler is what caught it.
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:16-alpine")
        .WithDatabase("${camel(ir.system)}_tests")
        .Build();

    public IAlbaHost Host { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _postgres.StartAsync();

        // Required when the app uses JasperFx command line integration.
        JasperFxEnvironment.AutoStartHost = true;

        Host = await AlbaHost.For<Program>(builder =>
        {
            // NAME THE ENVIRONMENT, and do not trust the default. Alba's own docs say it "does not do
            // anything to set the hosting environment", which reads as "tests run as Production". A probe
            // inside this very host measured EnvironmentName=Development with ASPNETCORE_ENVIRONMENT
            // unset — so every IsDevelopment()-gated line of production code was silently active inside
            // the suite. On one model that attached the demo seed data and broke 14 tests, including
            // every test of a slice that had nothing to do with it.
            builder.UseEnvironment("Testing");

            builder.ConfigureServices(services =>
            {
                // Solo mode skips leader election and the durability agents: much faster startup.
                services.RunWolverineInSoloMode();

                // NO BROKER IN TESTS, and this is the same operation as StubAllExternalTransports() — the
                // Wolverine docs describe both as "disabling all external listeners, stubbing all outgoing
                // subscriber endpoints, and not making any connection to external brokers". Sends are still
                // tracked, just not delivered.
                //
                // IT COSTS LESS THAN IT LOOKS, because Wolverine ships an in-memory mediator: InvokeAsync on
                // any message runs THE REAL PRODUCTION HANDLER with no transport involved at all. So every
                // behavioural test — every GWT, every Given/Then, an automation's trigger, a translation's
                // foreign notice — works fine in here. You do not stub an inbound message; you send it.
                //
                // WHAT IT DOES COST is the ability to test WIRING: whether a listener was actually configured,
                // whether a foreign notice really arrives. Those are configuration tests rather than
                // behavioural ones, and they belong in a class that boots its OWN host with the transport
                // live — see WakeupMechanismTests and LandingMechanismTests in reference-implementations/.
                // Keeping them out of the shared fixture is deliberate twice over: a clock or a listener
                // firing mid-test appends events into streams other tests are asserting on.
                services.DisableAllExternalWolverineTransports();

                // Marten attaches any IInitialData in the container to StoreOptions, and
                // ResetAllMartenDataAsync re-applies it — so every test starts in the same world.
                services.AddSingleton<IInitialData, SeedData>();
            });
            builder.UseSetting("ConnectionStrings:Marten", _postgres.GetConnectionString());

            // No automation CLOCK in tests, whatever mechanism a slice chose. Anything firing on its own
            // mid-test appends events into streams other slices are asserting on, and every GIVEN in the
            // suite becomes a race. Tests send the Run<Slice> message themselves — the same message every
            // mechanism ends up sending, to the same trigger — so the production path is still the tested
            // path. Only the clock is absent, and a clock is the one part of an automation a test must
            // control rather than observe.
            builder.UseSetting("Automation:Wakeup", "false");
        });
    }

    public async Task DisposeAsync()
    {
        await Host.StopAsync();
        await Host.DisposeAsync();
        await _postgres.DisposeAsync();
    }
}

[CollectionDefinition("integration")]
public sealed class IntegrationCollection : ICollectionFixture<AppFixture>;
`);

// Marten's IInitialData is the answer to "a test needs example data and the model has none". The
// genesis events are seeded once with fixed ids, ResetAllData re-applies them, and every test then
// starts from the same known world instead of inventing its own.
scaffold(join(TESTS, "SeedData.cs"),
  `${banner("baseline data — one known world, re-applied before every test")}
using Marten;
using Marten.Schema;
using ${NS}.Contracts;

namespace ${NS}.IntegrationTests;

/// <summary>
/// Fixed ids so a GIVEN can name things, and so a failing test is reproducible. The model declares
/// field names and types but never example values — this is where the values live, once.
///
${foreign.length
  ? `/// SEEDS NOTHING, and specifically NOT the ${foreign.length} foreign event(s) this system reads but never
/// produces: ${foreign.map((e) => e.label).join(", ")}.
///
/// Those carry origin=, meaning a genuine third party — so they are never in OUR event store at all, and a
/// band holding only foreign events is exempt from identity= for exactly that reason: "we never start those
/// streams, we only project from them." Appending one here would put another system's schema into our
/// append-only history for ever, which is the coupling a Translation slice exists to prevent.
///
/// It would also break the tests it appears to help. A seeded foreign event is present before every test
/// begins, so a trigger translates it into streams other tests are asserting on, and "a notice arrived and
/// was handled" becomes unassertable because one is always already there.
///
/// A test that needs a foreign event to ARRIVE sends the message its landing mechanism sends. Everything
/// else is appended by the test's own GIVEN, because that is what a GIVEN is for.`
  : `/// NOTHING TO SEED, and that is the expected state for most systems: every event here is produced by a
/// slice of this system, so a test's own GIVEN appends whatever it needs. The class exists for the fixed
/// ids below, which is what lets a GIVEN name things and a failing test be reproducible.
/// (The previous wording said "seeds only the 0 events ... ()", which read as an unfinished sentence and
/// cost a reader a minute checking whether they had missed a seeding step.)`}
/// </summary>
public sealed class SeedData : IInitialData
{
${seedConstants()}

    public async Task Populate(IDocumentStore store, CancellationToken cancellation)
    {
        await using var session = store.LightweightSession();

        // TODO(codegen): fixed ids and values go in the constants above, not here. Populate stays empty
        // unless this system genuinely needs baseline DOCUMENTS — see the class comment for why a foreign
        // event must not be appended.

        await session.SaveChangesAsync(cancellation);
    }
}
`);

emit(join(TESTS, "IntegrationContext.cs"),
  `${banner("Base class for every GWT test")}
using Alba;
using Marten;
using Microsoft.Extensions.DependencyInjection;
using Wolverine.Tracking;
using Xunit;

namespace ${NS}.IntegrationTests;

[Collection("integration")]
public abstract class IntegrationContext(AppFixture fixture) : IAsyncLifetime
{
    protected IAlbaHost Host => fixture.Host;
    protected IDocumentStore Store => Host.Services.GetRequiredService<IDocumentStore>();

    /// <summary>Every test starts from an empty event store, so GIVEN means exactly what it says.</summary>
    public Task InitializeAsync() => Host.ResetAllMartenDataAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    /// <summary>
    /// GIVEN: append prior events straight to the stream, bypassing the endpoints. A GWT's GIVEN is
    /// history, not a sequence of requests to replay.
    /// </summary>
    protected async Task Given(${STREAM_ID} streamKey, params object[] events)
    {
        await using var session = Store.LightweightSession();
        session.Events.Append(streamKey, events);
        await session.SaveChangesAsync();
    }

    /// <summary>THEN: the events a stream actually holds, in order.</summary>
    protected async Task<object[]> EventsFor(${STREAM_ID} streamKey)
    {
        await using var session = Store.QuerySession();
        var raw = await session.Events.FetchStreamAsync(streamKey);
        return raw.Select(x => x.Data).ToArray();
    }

    /// <summary>
    /// WHEN: an HTTP call that waits for ALL cascading Wolverine work before returning. Not an Alba
    /// extension — Alba makes the request, Wolverine.ExecuteAndWaitAsync wraps it and blocks until
    /// every message published or cascaded as a result has finished. Without the wrapper an
    /// assertion can run before the projection it is asserting on has been updated.
    /// </summary>
    protected async Task<(ITrackedSession, IScenarioResult)> WhenPosting(
        Action<Scenario> configure, int timeoutInMilliseconds = 10000)
    {
        IScenarioResult result = null!;
        var tracked = await Host.ExecuteAndWaitAsync(
            async () => { result = await Host.Scenario(configure); }, timeoutInMilliseconds);
        return (tracked, result);
    }

    /// <summary>
    /// WHEN: a message ARRIVES, rather than a person posting. The other half of <see cref="WhenPosting"/>,
    /// and the seam a translation slice is tested through.
    ///
    /// A foreign event has no endpoint of ours to be posted to — something outside hands it to Wolverine and
    /// a handler picks it up. So a test hands it to Wolverine too, and by doing that it drives THE PRODUCTION
    /// PATH rather than a test-only shortcut: the same handler, the same local queue, the same retries.
    ///
    /// Waits for all cascading work exactly as WhenPosting does, so the command the translation issues and
    /// the event it appends have both landed before the assertion runs.
    ///
    /// WHAT IT STILL CANNOT SEE, and it is the one thing worth remembering: whether anything in production
    /// ever sends this. The transport in front of the queue — a webhook, a table they INSERT into, a broker,
    /// a poll — is hand-owned, and a feed wired to nothing at all leaves this test green. KIT-FINDINGS T4.
    /// </summary>
    protected Task<ITrackedSession> WhenReceiving(object message, int timeoutInMilliseconds = 10000) =>
        Host.InvokeMessageAndWaitAsync(message, timeoutInMilliseconds);
}
`);

// --- one test per GWT -------------------------------------------------------------------------

let gwtCount = 0;
for (const s of ir.slices) {
  if (!s.gwts.length) continue;
  // A GT — a GWT with no when= — belongs to a slice with no command, so there is no fold to ask for a
  // stream key. But its GIVEN events still have to be appended SOMEWHERE, which makes the key the one
  // hint that implementer actually needs. Saying "no stream is written" is true of the slice and false
  // of the test, so fall back to the aggregate that owns the events this slice's GTs name.
  const agg = ir.shared.aggregates.find((a) => a.commands.some((c) => s.commands.includes(c.label)));
  const givenAgg = agg ?? ir.shared.aggregates.find((a) =>
    s.gwts.some((g) => `${g.given ?? ""},${g.then ?? ""}`.split(",").map((x) => x.trim()).some((n) => a.events.includes(n))));
  const key = (s.commands.length && agg?.identity.length)
    ? `${stateName(s)}.StreamKey(/* ${agg.identity.join(", ")} */)`
    : givenAgg?.identity.length
      ? `a ${givenAgg.name} stream, keyed by ${givenAgg.identity.join(" + ")} — this slice appends nothing itself, but a GIVEN has to go somewhere`
      : "/* no command in this slice, so no stream is written */";
  gwtCount += s.gwts.length;
  const testPath = join(TESTS, "Slices", pascal(s.context), `${pascal(s.name)}Tests.cs`);
  checkGwtCoverage(testPath, s.gwts);
  checkSkipFreshness(testPath, s);
  checkImplementedYetUnclaimed(testPath, s);
  scaffold(join(TESTS, "Slices", pascal(s.context), `${pascal(s.name)}Tests.cs`),
    `${banner(`slice "${s.name}" — ${s.gwts.length} ${s.gwts.every((g) => !g.when) ? "GIVEN/THEN" : "GWT"}(s), one test each`)}
using Alba;
using ${NS}.Contracts;
using ${NS}.Slices.${pascal(s.context)};
using Shouldly;
using Xunit;

namespace ${NS}.IntegrationTests.Slices.${pascal(s.context)};

/// <summary>
/// Generated from the model's GWT cells, NOT from the implementation — which is the only reason
/// these tests mean anything. Pattern: ${s.pattern}. Status: ${s.status}.
///
/// ALBA'S ASSERTIONS HANG OFF THE <c>Scenario</c>, NOT OFF THE SEND EXPRESSION — and getting it wrong
/// reads exactly like a missing <c>using</c>, which is why the note is here rather than somewhere you
/// reach afterwards. KIT-FINDINGS BT5.
/// <code>
///   _.Post.Json(cmd).ToUrl(route).StatusCodeShouldBe(204);   // does NOT compile
///   _.Post.Json(cmd).ToUrl(route);
///   _.StatusCodeShouldBe(204);                               // this does
/// </code>
/// ${isClaimed(s) ? "LIVE: this slice is claimed, so every test here must pass." : "SKIPPED: promote the slice past in-design to turn these on."}
/// ${s.owners.length > 1 ? `This slice needs ${s.owners.join(" and ")}, so these are the contract between them.` : `Owned by ${s.owner ?? "nobody in particular"}.`}
/// </summary>
public sealed class ${pascal(s.name)}Tests(AppFixture fixture) : IntegrationContext(fixture)
{
${((names) => s.gwts.map((g, i) => {
      const thens = (g.then ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const err = thens.find((t) => /^error:/i.test(t));
      // No when= means this is a GT, not a GWT — a read model reads events that already exist, so there
      // is no command to be the WHEN. Printing "WHEN (nothing)" invited the reader to think one was
      // missing; omitting the line says what the book says.
      // THE CELL ID IS EMITTED BESIDE THE RULE NAME, and it is not decoration — KIT-FINDINGS V13.
      // GWT coverage is checked by looking for the rule name in the kept test file, and two GWTs
      // legitimately SHARE a rule name (the same refusal reached by two different histories). Once one of
      // them has a test, every later scenario for that rule reports as covered. The id is unique by
      // construction, so a test that quotes it can be told apart; keep it in the comment.
      return `    // ${(g.rule || g.label || g.id).replace(/\s+/g, " ")}  [${g.id}]
    //   GIVEN ${g.given || "(nothing)"}${g.when ? `\n    //   WHEN  ${g.when}` : ""}
    //   THEN  ${g.then || "(nothing)"}${g.when ? "" : gtHint(s)}${isPeriphery(g) && g.when ? "\n    //   enforce=\"periphery\": rejected by the validator before any stream is read." : ""}
    ${factAttr(s)}
    public Task ${names[i]}()
        => throw new NotImplementedException(
            "TODO(codegen): ${err ? `expect a 400 whose ProblemDetails title is \\"${ruleName(g)}\\" — title carries the rule name at BOTH enforcement points, so assert that and not the ${isPeriphery(g) ? "errors dictionary" : "detail sentence"}` : `expect ${thens.join(", ") || "the modelled outcome"}`}. " +
            "Stream key: ${key.replace(/"/g, "'")}. Fixed values for every stream key are on SeedData: ${
      [...new Set(ir.shared.aggregates.flatMap((a) => a.identity ?? []))].map((k) => `SeedData.${pascal(k)}`).join(", ") || "none — no band declares identity="
    }.");`;
    }).join("\n\n"))(testNames(s.gwts))}
}
`);
}

// --- automation heartbeats --------------------------------------------------------------------

// An automation that only runs when a human POSTs to a route is not an automation. What wakes the
// processor is transport and the model says nothing about it — but that a `pattern="automation"`
// slice needs SOMETHING to wake it is mechanically derivable, so the generator owns it rather than
// leaving it to whoever remembers.
//
// Only slices past in-design get one: the message has no handler until the slice is implemented, and
// Wolverine asserts a subscriber exists.
// TRANSLATION COUNTS AS AN AUTOMATION HERE, and leaving it out was the most dangerous bug in this file.
//
// The cheat sheet defines translation as
//   Event(s) (source system) -> View -> Automated Trigger -> Command -> Event(s)
// which is an automation whose source is foreign — and CLAUDE.md's own table says translation is "the
// automation choice, plus how the foreign event lands". Filtering on pattern === "automation" alone meant
// a translation slice got NO Run<Slice> message, NO trigger scaffold, NO wakeup decision table, and —
// worst — checkWakeupChosen could never fire for it. So the kit's one structural defence against
// "nothing ever wakes this in production", the bug CLAUDE.md says shipped once, was unreachable for the
// slice type most likely to need it. Program.cs even asserted "No automation slice is past in-design, so
// nothing needs waking" over a translation slice that very much needed waking.
//
// Found by modelling ch.16 of the book, which is a translation, and watching the generator emit nothing.
const WOKEN_PATTERNS = new Set(["automation", "translation"]);
const automations = ir.slices.filter(
  (s) => WOKEN_PATTERNS.has(s.pattern) && s.status !== "in-design");
const sweepMessage = (s) => `Run${pascal(s.name)}`;
// THE GENERATOR DOES NOT CHOOSE HOW A TRIGGER IS WOKEN, and that is a deliberate reversal.
//
// It used to emit an AutomationHeartbeat — a clock-driven sweep — for every automation slice. That was
// generalised from a single model whose automations were all triggered by FOREIGN events or by the
// PASSAGE OF TIME, which is a property of that model and not of the pattern. Event forwarding, a Marten
// subscription and projection RaiseSideEffects are all valid, and the right one depends on the slice:
// see the decision table in .claude/agents/backend-agent.md, and the worked comparison in
// reference-implementations/automation/.
//
// What IS derivable, and so still generated:
//
//   * Run<Slice>, the message the trigger handles. Every mechanism ends up invoking the same trigger,
//     so this is the one seam all four share — and it is what lets a test drive the production path.
//   * Discovery.IncludeType for the trigger class, because conventional discovery only finds
//     *Handler / *Consumer and a processor named after its automation cell is neither.
//   * a Register hook per slice, called from Program.cs, whose BODY is scaffold.
//
// What is not: the body of that hook. It carries a TODO(codegen) marker, and the marker is reported
// until somebody removes it — so "nothing wakes this" is caught at generation time instead of
// surviving a green test suite, which is exactly how it got through once.
if (automations.length) {
  emit(join(APP, "Contracts", "AutomationMessages.cs"),
    `${banner(`${automations.length} automation trigger message(s) — one per automation slice`)}
namespace ${NS}.Contracts;

${automations.map((s) => `/// <summary>
/// Runs the ${s.name} trigger once: read the View, issue commands for whatever is outstanding.
///
/// It carries nothing on purpose. The trigger decides from ACCUMULATED STATE — that is what makes it an
/// automation rather than an event handler — so anything this message carried would be a second source of
/// truth competing with the View.
///
/// Whatever wakes the trigger sends this: a forwarded event, a subscription, a projection side effect or a
/// clock. See ${pascal(s.name)}Wakeup.
/// </summary>
public sealed record ${sweepMessage(s)};`).join("\n\n")}
`);

  for (const s of automations) {
    // The TRIGGER class. Program.cs registers it by name, so a project without it does not compile —
    // and for a long time the generator emitted the registration and not the class, which only ever
    // worked because the first project's trigger happened to be written by hand.
    // pascal(a), NOT a. An automation's label is a DOMAIN label and may contain spaces — the book writes
    // "Inventory Processor". Used verbatim it produced a file called "Inventory Processor.cs" containing
    // `class Inventory Processor`, and a matching typeof() in Program.cs: eleven compiler errors. Latent
    // until a model used a label of more than one word; every earlier one happened to say "EmailProcessor".
    //
    // AND THE FIX WAS HALF-APPLIED. The file name and the typeof() got pascal(); the class DECLARATION
    // below kept `${a}` and went on emitting `public static class Stock Feed Translator` — four syntax
    // errors, and a generated project that does not build, against CLAUDE.md's standing claim that it
    // does. Found on CPOC03, the first model since to name an automation in more than one word.
    // The lesson is the comment's, not the code's: a note saying a bug is fixed is not a test that it is.
    for (const a of s.automations ?? []) {
      scaffold(join(APP, "Slices", pascal(s.context), pascal(s.name), `${pascal(a)}.cs`),
        `${banner(`${a} — the automated trigger for slice "${s.name}"`)}
using Marten;
using Wolverine;
using Wolverine.ErrorHandling;         // OnException<T>() is an extension on IWithFailurePolicies; no doc page names it
using ${NS}.Contracts;
using ${NS}.Views;

namespace ${NS}.Slices.${pascal(s.context)};

/// <summary>
/// The Automated Trigger of ${s.name}: <c>Event(s) -> View -> TRIGGER -> Command -> Event(s)</c>.
///
/// It is a peer of a person at a screen — it reads a View and issues a Command. It never takes an event as
/// input and never appends one; <c>Event -> Processor -> Event</c> is the classic anti-pattern.
///
/// <see cref="IQuerySession"/> and not <see cref="IDocumentSession"/> on purpose: that makes "a trigger
/// never appends" a compile error rather than a convention. The events come from the decider, reached
/// through the command.
///
/// Returns <see cref="Task"/> and NOT a result object. Wolverine treats a handler's return value as a
/// CASCADING MESSAGE with no opt-out, so a report returned from a fire-and-forget run is unroutable and
/// takes the whole outgoing batch with it. If a human needs to see what a run did, log it or give the run
/// its own operational route.
///
/// What wakes this is NOT here: see ${pascal(s.name)}Wakeup.
/// </summary>
public static class ${pascal(a)}
{
    public static async Task Handle(
        ${sweepMessage(s)} message,
        IQuerySession session,
        IMessageBus bus,
        ILogger logger,
        CancellationToken cancellation)
    {
        // TODO(codegen): read the slice's View for outstanding work, and issue its Command per item.
        //
        //   var work = await session.Query<SomeTodoView>().Where(r => r.IsPending).ToListAsync(cancellation);
        //   foreach (var row in work) await bus.InvokeAsync(new SomeCommand(row.Id), cancellation);
        //
        // Two things that are not optional:
        //   * the run must be safe to REPEAT. At-least-once is the normal case for every wakeup mechanism,
        //     so correctness cannot depend on how often this fires.
        //   * log every run, including one that did nothing — otherwise "alive with no work" and "dead"
        //     produce identical output, and that ambiguity has hidden a broken wakeup before.
        await Task.CompletedTask;
        logger.LogInformation("${s.name}: nothing implemented yet.");
    }
}
`);
    }

    const p = join(APP, "Automation", `${pascal(s.name)}Wakeup.cs`);
    checkWakeupChosen(p, s.name);
    scaffold(p,
      `${banner(`${s.name} — HOW this automation is woken. Choose one; regeneration keeps this file.`)}
using JasperFx.Events.Projections;
using Marten;
using Wolverine;
using Wolverine.ErrorHandling;         // OnException<T>() is an extension on IWithFailurePolicies; no doc page names it
using Wolverine.Marten;
using ${NS}.Contracts;

namespace ${NS}.Automation;

/// <summary>
/// The one thing the model does not tell you about an automation slice.
///
/// \`Event(s) -> View -> Trigger -> Command\` constrains the CONTRACT: the trigger decides from accumulated
/// state rather than from one event's payload, and issues a command rather than appending one. It says
/// nothing about what wakes the trigger, and it does not require the View to be a materialised projection —
/// a subscription's checkpoint is a record of what has been worked, a durable inbox is a list of pending
/// work. The green box on the diagram is the concept.
///
/// So this is an implementation choice, not a domain fact, which is why it lives in code and not on a cell.
/// Pick the row you are in:
///
///   the trigger event is OURS, appended in our own transaction   -> event forwarding to a handler
///   ours, and ordering or replay matters                         -> Marten ISubscription
///   ours, and the decision is a function of the VIEW ROW         -> projection RaiseSideEffects
///   the trigger event is FOREIGN — we never append it            -> THE ARRIVAL IS THE WAKEUP: see below
///   there is no event at all — the trigger is TIME               -> sweep the View on a clock
///
/// THE FOREIGN ROW IS THE ONE PEOPLE GET WRONG, and this file used to send you to a clock for it. For a
/// 1:1 translation there is nothing to sweep: the notice is not in our store and no Marten projection can
/// fold it, so the handler in Landing/ IS the trigger — it arrives, it translates, it issues the command,
/// and the durable local queue underneath it is the todo list. Nothing else has to wake anything, and
/// ${sweepMessage(s)} goes unused.
///
/// A translation needs a wakeup from the table above only when it is CONDITIONAL — deciding from several
/// notices accumulated over time rather than mapping one. That needs a todo View fed by events of OURS,
/// which means the handler records something first, and then every row above applies again.
///
/// Worked implementations of all of these, against one shared model, are in
/// reference-implementations/automation/. Read that before writing this.
///
/// Whatever you choose, it must end up sending <see cref="${sweepMessage(s)}"/>. Keeping that seam means a
/// test drives the same path production does — and while the trigger was reachable only over HTTP, "nothing
/// ever wakes this in production" was invisible to a green suite.
///
/// TWO RULES THAT HOLD FOR EVERY CHOICE:
///   * a clock must be absent in tests, or a run firing mid-test turns every other slice's GIVEN into a
///     race. Gate it on configuration and let tests send ${sweepMessage(s)} themselves.
///   * whatever you register, the run must be safe to repeat. At-least-once is the normal case for all of
///     these, so correctness cannot depend on how often it fires.
/// </summary>
public static class ${pascal(s.name)}Wakeup
{
    /// <summary>
    /// Resolves WHICH mechanism was chosen. Called first, before every Configure hook below asks for it —
    /// resolve it later and a mechanism silently configures nothing.
    /// </summary>
    public static void Choose(IConfiguration config) { }

    /// <summary>Hosted services and anything needing the app builder. A clock lives here.</summary>
    public static void RegisterServices(WebApplicationBuilder builder)
    {
        // TODO(codegen): choose how ${s.name} is woken, then delete this line.
        //
        // Until it is gone, codegen reports this slice under AUTOMATION NOT WOKEN — because an
        // automation nothing ever runs passes every test it has, and that is not hypothetical.${s.pattern === "translation" ? `
        //
        // THIS IS A TRANSLATION, so the answer is very often "nothing here". If the ingest handler in
        // Landing/ translates each notice as it arrives, the arrival IS the wakeup and this file has no
        // work to do — delete the line above and leave every hook empty. That is a decision, not a
        // shortcut, and the report going quiet is what records that you made it.` : ""}
    }

    /// <summary>
    /// The lifecycle of this slice's todo View. Inline unless the chosen mechanism needs otherwise —
    /// projection side effects are documented as built for ASYNC projection processing.
    /// </summary>
    public static ProjectionLifecycle LifecycleOf(ProjectionLifecycle fallback) => fallback;

    /// <summary>Marten options: a projection lifecycle, a subscription registration.</summary>
    public static void ConfigureMarten(StoreOptions opts) { }

    /// <summary>The store: AddAsyncDaemon, which a subscription and an async projection both need.</summary>
    public static void ConfigureStore(MartenServiceCollectionExtensions.MartenConfigurationExpression marten) { }

    /// <summary>The Marten-to-Wolverine integration: where event forwarding is switched on.</summary>
    public static void ConfigureIntegration(MartenIntegration integration) { }

    /// <summary>Wolverine options: discovery, policies, whatever a doorbell handler needs.</summary>
    public static void ConfigureWolverine(WolverineOptions opts) { }
}
`);
  }
}

// --- how a foreign event ARRIVES --------------------------------------------------------------
//
// The counterpart of the wakeup hooks above, and it was missing for five runs. KIT-FINDINGS T1: the
// generator emitted a foreign event's RECORD and a SeedData note about it, and nothing whatever in the
// application — so no production path existed by which one could enter the system, and "nothing ever
// ingests this" was invisible to a green suite in exactly the way "nothing ever wakes this" was.
//
// WHAT IS DERIVABLE, and therefore generated: that a foreign event needs a way in, and that it arrives as
// a MESSAGE on a durable local queue. Program.cs already sets opts.Policies.UseDurableLocalQueues(), so
// the queue Wolverine routes this message to is backed by the Postgres envelope tables — persisted on
// arrival, retried on failure, dead-lettered when it keeps failing. None of that is code anybody writes.
//
// WHAT IS NOT, and stays hand-owned: the transport IN FRONT of that queue. A webhook they call, a table
// they INSERT into, a broker they publish to, or a poll of their API differ in durability and in who is
// responsible for a notice that goes missing — a decision the model cannot make and this generator must
// not. Whichever is chosen, its only job is to send this message, which is the seam that stops three
// transports each growing their own copy of the translation. reference-implementations/translation/
// measures all four.
//
// ONE HANDLER PER FOREIGN EVENT, not per slice. Two slices consuming the same foreign event would
// otherwise get two handler classes for one message type, and Wolverine would cheerfully run both.
const foreignLabels = new Map(foreign.map((e) => [e.label, e]));
const ingestsByEvent = new Map();
for (const s of ir.slices) {
  if (!s.generates || s.status === "in-design") continue;
  for (const label of s.imports ?? []) {
    // An import whose label IS produced somewhere in this system is a sibling context's event, not a
    // foreign one. It is already in our store, appended by the context that owns it, and there is
    // nothing to ingest — the consuming context just projects it. Only `origin=` events land here.
    if (!foreignLabels.has(label)) continue;
    // AND NOT WHEN THE MODEL ALREADY NAMES A TRIGGER FOR THIS SLICE. On a translation slice the automation
    // cell IS the thing the arrival wakes — `Event(s) → View → Automated Trigger → Command` — and codegen
    // emits `opts.Discovery.IncludeType(typeof(<Trigger>))` into Program.cs, which is `emit`, so that class
    // is REQUIRED to exist. Scaffolding a seam as well produced a SECOND consumer of the same message, which
    // is the duplicate-handler hazard: no exception, no ambiguity error, and the caller gets whichever
    // handler Wolverine picked.
    //
    // KIT-FINDINGS BP12 filed this as the folder being behind the generator — the generated seam took the
    // model's event label while the folder's took its own transport record. That reading was wrong. The
    // folder's two records were byte-identical and one was genuinely redundant, but the seam itself was the
    // generator emitting a handler for a message the model had already assigned a trigger. An
    // `INGEST NOT WIRED` on it could therefore never be satisfied — the fix was always to not emit it.
    if ((s.automations ?? []).length) continue;
    if (!ingestsByEvent.has(label)) ingestsByEvent.set(label, []);
    ingestsByEvent.get(label).push(s);
  }
}

const unIngested = [];
const ingestsFound = [];   // BO1: a translation that already exists, under a name this generator never chose
const checkIngestWired = (p, event) => {
  if (!existsSync(p)) return;                       // not scaffolded yet; this run will write it
  if (readFileSync(p, "utf8").includes("TODO(codegen): translate"))
    unIngested.push({ path: p, event });
};

// IS THIS NOTICE ALREADY TRANSLATED? BY SHAPE, NEVER BY EXPECTED FILENAME — KIT-FINDINGS BO1.
//
// The check used to look at ONE hard-coded path — `Landing/Ingest<Event>Handler.cs`, the file this generator
// would have written — and so asked "did I write this?" rather than "does a translation exist?". That is the
// same mistake the read endpoint (BP4) and the decider (BP2) each paid for, here for the third time.
//
// Measured on reference-implementations/translation/, the folder whose whole purpose is demonstrating a
// wired ingest: its translation is `StockTranslator`, which lives in the SLICE folder rather than Landing/
// and is fed four ways — a webhook, a table the far side writes to, a broker and a poll. The generator saw
// none of it, reported INGEST NOT WIRED on every run for ever, and scaffolded a handler beside it. Filed as
// NOISE on the assumption the extra file was merely dead; it is worse than that, because that folder's
// transports send the contract type itself, so the scaffold would be a SECOND discovered handler for one
// message — the duplicate-handler failure measured in BP2, where nothing complains and the caller simply
// gets the other handler's answer.
const ingestScanFiles = (() => {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const q = join(dir, e.name);
      if (e.isDirectory()) { if (!["bin", "obj"].includes(e.name)) walk(q); }
      else if (e.name.endsWith(".cs")) out.push({ path: q, src: stripComments(readFileSync(q, "utf8")) });
    }
  };
  walk(APP);
  return out;
})();

for (const [label, slices] of ingestsByEvent) {
  const e = foreignLabels.get(label);
  const cls = `Ingest${pascal(label)}Handler`;
  const p = join(APP, "Landing", `${cls}.cs`);

  // TWO SIGNALS, BOTH REQUIRED: something TAKES the notice, and something ISSUES one of our commands with
  // it. Taking it alone is not a translation — `InMemoryWarehouseFeed.Publish(StockNoticed notice)` stores
  // them and translates nothing, and reading that as "wired" would suppress a real finding. Issuing is
  // either through the bus or by constructing the command directly for Wolverine to cascade.
  const cmds = [...new Set(slices.map((s) => s.commands[0]).filter(Boolean).map(pascal))];
  const takesNotice = new RegExp(String.raw`\b${pascal(label)}\s+[a-z]\w*`);
  const issuesCommand = (src) => /IMessageBus|InvokeAsync|SendAsync|PublishAsync/.test(src)
    || cmds.some((c) => new RegExp(String.raw`\bnew ${c}\s*\(`).test(src));
  const already = ingestScanFiles.find((f) => f.path !== p && takesNotice.test(f.src) && issuesCommand(f.src));
  if (already) {
    ingestsFound.push({ event: label, path: already.path });
    continue;                                       // writing the seam here would DUPLICATE this handler
  }

  checkIngestWired(p, label);
  scaffold(p,
    `${banner(`${label} — HOW this foreign event gets in. The transport in front of it is yours.`)}
using Wolverine;
using ${NS}.Contracts;

namespace ${NS}.Landing;

/// <summary>
/// THE INGEST SEAM for <see cref="${NS}.Contracts.${pascal(label)}"/>, which arrives from ${e.origin} and is
/// consumed by ${slices.map((s) => `"${s.name}"`).join(", ")}.
///
/// Named *Handler so Wolverine's conventional discovery finds it — no registration in Program.cs, and no
/// Discovery.IncludeType the way an automation trigger needs one.
///
/// IT ARRIVES ON A DURABLE LOCAL QUEUE. Program.cs sets <c>Policies.UseDurableLocalQueues()</c>, so
/// whatever sends this message hands it to Postgres before this method is ever called: the envelope is
/// persisted on arrival and survives a restart. That is the durable record of what they told us.
///
/// **BUT IT IS NOT RETRIED UNLESS YOU CONFIGURE A RETRY, and this comment used to claim it was.** Wolverine
/// moves a message to the dead letter queue when it "exhausts all its configured retry/requeue slots" — and
/// with no policy configured there are no slots, so the FIRST throw dead-letters. For an at-least-once feed
/// that is usually wrong: a transient database blip loses a notice that the far side will never re-send.
///
/// Add one in this slice's <c>&lt;Slice&gt;Wakeup.ConfigureWolverine</c>, and prefer <c>RetryWithCooldown</c>:
/// the docs state that only "Retry" and "Retry With Cooldown" are applied automatically to an inline
/// <c>InvokeAsync</c>, so any other policy works in production and silently does nothing in the suite —
/// which is the worst possible split. KIT-FINDINGS T1b.
///
/// IT IS ALSO THE TODO LIST. \`Event(s) -> View -> Trigger -> Command\` does not require the View to be a
/// materialised projection, and on a translation it CANNOT be one — the foreign event is never in our
/// store, so no Marten projection could ever fold it. The transport's inbox is the list of pending work,
/// with retries and dead-lettering nobody wrote.
///
/// **NEVER APPEND THIS RECORD TO OUR STORE.** The schema belongs to ${e.origin}. Our event store is
/// append-only, so a foreign schema written into it is in our history for ever — which is exactly the coupling a
/// translation exists to prevent, installed by the thing meant to prevent it. The only thing that gets
/// persisted is what WE decided, as an event of ours, through a command.
///
/// WHAT THIS FILE DOES NOT DECIDE — the transport in front of the queue:
///
/// <code>
///   they call us, and a lost call is THEIR retry to make    -> an HTTP endpoint
///   they can INSERT into our database                       -> ListenForMessagesFromExternalDatabaseTable
///   they publish to a broker                                -> a Wolverine listener
///   they offer only a query API, or push nothing            -> poll on a clock, with a high-water mark
/// </code>
///
/// Whichever it is, it does one thing: <c>await bus.SendAsync(new ${pascal(label)}(...));</c> — and then
/// everything below is reached identically by production and by a test. Measured comparison of all four:
/// reference-implementations/translation/.
///
/// A test drives this with <c>WhenReceiving(new ${pascal(label)}(...))</c>, which is the production path.
/// It cannot tell you that anything in production actually sends it; nothing can except running it.
/// </summary>
public static class ${cls}
{
    public static async Task Handle(
        ${pascal(label)} notice,
        IMessageBus bus,
        ILogger logger,
        CancellationToken cancellation)
    {
        // TODO(codegen): translate this into one of OUR commands and issue it.
        //
        //   await bus.InvokeAsync(new SomeCommand(notice.${e.fields[0] ? pascal(e.fields[0].name) : "…"}, …), cancellation);
        //
        // InvokeAsync, not SendAsync: it runs the command inline and THROWS if the command fails, so a
        // translation that cannot be applied fails this message — which is what makes the retry and the
        // dead letter queue above mean anything. SendAsync would succeed here and lose the failure.
        //
        // FOUR THINGS THE FAR SIDE WILL DO TO YOU, and none of them are exceptional:
        //
        //   * DUPLICATES. At-least-once is the normal case for every transport, and a black box
        //     re-sending after a reconnect is ordinary. Dedupe on a correlation value carried by OUR OWN
        //     event and folded by the decider — one value of theirs, not their schema. The transport's
        //     own inbox catches only its own redelivery and is pruned, so it cannot be the durable answer.
        //   * OUT OF ORDER. Nothing guarantees the arrival order matches the order things happened.
        //   * VOCABULARY. Their names are theirs. This record and the command are the only two places
        //     their words may appear; the rename belongs on the way into the command, which is what
        //     mappings= on the model records.
        //   * IDENTIFIERS THAT ARE NOT OURS. A correspondence between their key and ours has no notation
        //     on the model at all — the GWT's example data is the only place it is pinned. If their id
        //     resolves to nothing of ours, that is a decision (refuse? park? raise?), not a null check.
        await Task.CompletedTask;
        logger.LogInformation("${label} arrived and nothing is implemented yet.");
    }
}
`);
}


// Development seed data. Program.cs constructs this under IsDevelopment, so a project without it does
// not compile — another type the generator referenced and never wrote. Scaffold, because the VALUES are a
// judgement the model deliberately does not carry: it declares field names and types and never examples.
scaffold(join(APP, "GenesisData.cs"),
  `${banner("development-only starting data — a world to click around in")}
using Marten;
using Marten.Schema;
using ${NS}.Contracts;

namespace ${NS};

/// <summary>
/// A lived-in world for running the app by hand. NOT used by the tests — they have their own SeedData with
/// fixed ids, because a test needs a world it controls and a demo needs one that looks used.
///
/// Attached via <c>.InitializeWith(...)</c> on the Marten chain. Registering an IInitialData in the DI
/// container alone does nothing.
/// </summary>
public sealed class GenesisData : IInitialData
{
    public async Task Populate(IDocumentStore store, CancellationToken cancellation)
    {
        // Populate runs on EVERY startup, so this has to be idempotent.
        //
        // Careful with the usual guard — "if any row of view X exists, return". It fires on the OLD data,
        // so genesis events added later never land on an existing demo database and the feature that needs
        // them looks broken. \`docker compose down -v\` is the fix; knowing that is cheaper than debugging it.
        await using var query = store.QuerySession();

        // TODO(codegen): seed enough of THIS system's own history to make the screens worth looking at. The
        // model names the fields; the values are yours.
        //
        // NOT the foreign events. Anything with origin= belongs to another system and is never in our store,
        // so appending one here is not a shortcut — it makes a completely disconnected feed look identical to
        // a working one, which is the single failure a demo run is supposed to expose. Seed THE FAR SIDE
        // instead: whatever stands in for the other system in Development, so the app has to go and fetch.
        //
        // Note this type is constructed with \`new GenesisData()\` in Program.cs, which is emit — so it can
        // take no constructor dependency. Anything needing the container is registered elsewhere.
        await Task.CompletedTask;
    }
}
`);

// --- view registrations: the one file that decides WHICH recipe each read model is --------------
//
// This was inline in Program.cs, which is emit() and therefore overwritten — so every read-side
// decision an implementer made was lost on the next regeneration. And the decisions are real:
// `Event(s) -> View` narrows to six Marten recipes and no further, `Inline` is only the default for
// two of them, and three of the six are not even the base class the view file was scaffolded with.
// Registration is where all of that lands, so registration has to be scaffold().
if (ir.shared.views.length) {
  checkViewsRegistered(join(APP, "Views", "ViewRegistrations.cs"), ir.shared.views);
  scaffold(join(APP, "Views", "ViewRegistrations.cs"),
    `${banner("read-model registration — WHICH Marten recipe each view is")}
using JasperFx.Events.Daemon;        // DaemonMode — no doc page states this namespace; verified by compiling
using JasperFx.Events.Projections;
using Marten;
using ${NS}.Views;
${automations.length ? `using ${NS}.Automation;   // a wakeup mechanism may override a todo View's lifecycle\n` : ""}
namespace ${NS};

/// <summary>
/// Called once from Program.cs. Every line below is the DEFAULT, not the answer: single- or
/// multi-stream, registered Inline. Marten also offers EventProjection (one event, many documents),
/// FlatTableProjection (a SQL table, not a document), composite/chained projections and raw
/// IProjection — see reference/llms/marten/events/projections/ and
/// reference-implementations/state-view/.
///
/// Changing a line here is the supported way to choose. Regeneration KEEPS this file.
///
/// Two costs to know before moving anything off Inline:
///   - Inline updates the view in the append's own transaction, so a GWT's THEN is assertable the
///     moment the request returns. Async means tests must WAIT instead of assert.
///   - Async needs the daemon: AddAsyncDaemon(DaemonMode.Solo) on the Marten chain, or nothing runs
///     and Marten only warns.
/// </summary>
public static class ViewRegistrations
{
    public static void Register(StoreOptions opts)
    {
${ir.shared.views.map((v) => registerable.includes(v.label)
      ? `        opts.Projections.Add<${pascal(v.label)}Projection>(${lifecycleFor(v)});`
      : `        // TODO(codegen): ${pascal(v.label)}Projection groups events that do not carry
        // ${SYS_KEY.join(" + ")}, so it has no slicing rule yet. Marten rejects a multi-stream
        // projection with no rules AT STARTUP, so registering it now would take the host down.
        // opts.Projections.Add<${pascal(v.label)}Projection>(${lifecycleFor(v)});`
    ).join("\n")}
    }

    /// <summary>
    /// The read side sometimes needs the STORE and not just its options. Any projection registered Async
    /// runs in the async daemon, and WITHOUT THE DAEMON NOTHING PROCESSES IT — Marten only logs a warning
    /// at startup, so the symptom is a view that stays empty for ever with a clean build and a clean boot.
    ///
    /// Solo rather than HotCold: one node, no leader election, much faster startup.
    /// </summary>
    public static void ConfigureStore(MartenServiceCollectionExtensions.MartenConfigurationExpression marten)
    {
${(() => {
  // Only the views ACTUALLY REGISTERED Async need the daemon. A multi-stream view whose registration is
  // commented out because it has no slicing rule is not running at all, and naming it here would send a
  // reader looking for a projection that Register() never adds — the first version of this did exactly that.
  const live = ir.shared.views.filter((v) => isMultiStream(v) && registerable.includes(v.label))
    .map((v) => pascal(v.label));
  return live.length
    ? `        // ${live.join(", ")} ${live.length === 1 ? "is" : "are"} multi-stream, so registered Async above —
        // per Marten's own guidance: "Register the lookup projection inline and the multi-stream projection
        // async." WITHOUT THIS LINE those views never update, and Marten only logs a warning.
        marten.AddAsyncDaemon(DaemonMode.Solo);`
    : `        // Nothing above is registered Async, so no daemon is needed yet. Add
        // marten.AddAsyncDaemon(DaemonMode.Solo) the moment you register one — Async with no daemon is a
        // view that stays empty for ever, with a clean build and a clean boot.`;
})()}
    }
}
`);
}

// --- the read endpoint of a state-view slice ----------------------------------------------------
//
// A state-view slice's whole contract IS its read model, and nothing generated one — so the GT hint said
// to assert *"through its read endpoint IF the slice has one"*, and every project hand-wrote them.
// KIT-FINDINGS BP4.
//
// TWO THINGS MAKE THIS NOT MECHANICAL, and both would have shipped a plausible wrong endpoint.
//
// 1. `Event(s) -> View` DOES NOT PROMISE A DOCUMENT. CLAUDE.md's identity= table lists six Marten
//    recipes and this generator knows two; the view file and its registration are both SCAFFOLD, so a
//    human has legitimately chosen another. A generated `Query<T>()` endpoint is **wrong** for a live
//    aggregation (nothing is stored — it needs `FetchLatest<T>`) and wrong for a `FlatTableProjection`
//    (a SQL table, not a document at all). Both COMPILE and both return an empty list for ever.
//    Measured: `MessageMetrics` in reference-implementations/state-view/ is a `FlatTableProjection` ON A
//    STATE-VIEW SLICE, so this is not hypothetical — 1 view in 5 there.
//    So the recipe is READ OFF THE TREE, and where it is not document-backed the endpoint is NOT
//    written and the gap is REPORTED. Same logic as stamping a projection GUESSED rather than silently
//    grouping the wrong rows: a named gap beats a plausible wrong answer.
//
// 2. FILE-ABSENT IS NOT ENDPOINT-ABSENT, and keying on a filename would have broken routes in four projects.
//    Eight projects already have hand-written read endpoints, and they agree on neither the location nor
//    the route: Voltway/Spend/Allocation put them in `Views/<View>Endpoint.cs`, Demo001 in the slice
//    folder, and Voltway's `OperationsConsoleEndpoints.cs` serves TWO views from one file under routes
//    named after neither it nor its slice. "Scaffold where the expected file is missing" emits a SECOND
//    endpoint for every one of those. So detection asks *"does an endpoint for this view exist anywhere?"*,
//    never *"is this path on disk?"* — measured both ways, including renaming an endpoint's FILE, which
//    still suppresses the scaffold.
//
//    WHAT A DUPLICATE ROUTE ACTUALLY DOES WAS MEASURED, because the first version of this comment asserted
//    it and was wrong. It said Wolverine rejects one at host startup and takes the Alba fixture down. It
//    does not: two [WolverineGet] methods on one template BUILD at 0/0 and the HOST STARTS FINE. The
//    failure is per request — `AmbiguousMatchException: "The request matched multiple endpoints"`, naming
//    both handler types — so only the tests hitting that route fail (measured: 4 of 18 in Demo001). In
//    production every request to that route is a 500. KIT-HISTORY BP4 (part 2).
//
// THE BIAS IS DELIBERATE AND ASYMMETRIC. A false positive (we think one exists, so we write nothing) costs
// a missing scaffold, which the GT hint already covers. A false negative costs a broken route. So any
// GET-bearing file naming the view type counts as an endpoint.
const readEndpointsWritten = [];
const readEndpointsFound = [];
const readEndpointsSkipped = [];

const appCsFiles = () => {
  const out = [];
  (function walk(d) {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!/^(bin|obj)$/.test(e.name)) walk(p); }
      else if (e.name.endsWith(".cs")) out.push(p);
    }
  })(APP);
  return out;
};

if (ir.shared.views.length) {
  const tree = appCsFiles().map((p) => ({ path: p, src: readFileSync(p, "utf8") }));
  const uncommented = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  // A WORD-BOUNDARY REGEX BUILT FROM A REGEX LITERAL, not from a string — `\\b` in a template literal is
  // a backspace character and the test then never matches, which for a detector means it reports
  // "nothing exists" and cheerfully writes the duplicate. CLAUDE.md's standing warning, and it bit while
  // measuring this very feature: a first pass run through `node -e` said no project had a read endpoint
  // at all, on a tree where five files plainly did.
  const namesType = (src, label) => new RegExp(String.raw`\b${pascal(label)}\b`).test(src);

  for (const v of ir.shared.views) {
    const onStateView = ir.slices.some(
      (s) => (s.kind ?? s.pattern) === "state-view" && (s.views ?? []).includes(v.label));
    // A todo View is machinery an automation consults, not a contract anybody reads — `then=` on such a
    // slice names an EVENT. Giving it a public GET would publish the inside of a process.
    if (!onStateView || (v.todoFor ?? []).length) continue;

    const existing = tree.find((f) => f.src.includes("WolverineGet") && namesType(uncommented(f.src), v.label));
    if (existing) {
      readEndpointsFound.push({ view: v.label, path: existing.path });
      continue;
    }

    // WHICH RECIPE, read off the tree rather than assumed. `FlatTableProjection` is the one that is
    // registered like any other and is NOT a document; a live aggregation registers nothing at all.
    // UNCOMMENTED, like every other check here. `Campaigns/Views/MessageStatus.cs` carries a doc comment
    // reading "scaffolded this as a separate MessageStatusProjection : SingleStreamProjection<…>" — prose
    // about a decision that was then REVERSED. Reading comments would let a sentence about the past decide
    // what gets generated now, which is the same class of mistake as matching a rule name inside a comment
    // that says the rule was removed.
    const decl = tree.map((f) => uncommented(f.src))
      .find((s) => new RegExp(String.raw`class\s+${pascal(v.label)}Projection\b`).test(s));
    const base = decl?.match(
      new RegExp(String.raw`class\s+${pascal(v.label)}Projection\s*:\s*([A-Za-z]+)`))?.[1] ?? null;
    const snapshotted = tree.some((f) =>
      new RegExp(String.raw`Snapshot<\s*${pascal(v.label)}\s*>`).test(uncommented(f.src)));
    const registered = snapshotted || tree.some((f) =>
      uncommented(f.src).includes(`${pascal(v.label)}Projection`) && f.path.endsWith("ViewRegistrations.cs"));

    if (base === "FlatTableProjection" || !registered) {
      readEndpointsSkipped.push({
        view: v.label,
        why: base === "FlatTableProjection"
          ? "a FlatTableProjection — rows in a SQL table, not documents, so Query<T>() would return nothing for ever"
          : "registered nowhere as a document projection — a live aggregation needs FetchLatest<T>, and an "
            + "unregistered view has no store to read",
      });
      continue;
    }

    // THE ROUTE FOLLOWS THE CONVENTION THE HAND-WRITTEN ONES CONVERGED ON — `/{context}/{view}`, camel,
    // which is what Voltway, Demo001, Spend and Allocation all chose independently. It is a starting
    // point and not a promise: this file is SCAFFOLD precisely because Demo001 then added `/{date}` and
    // every reference implementation moved a route.
    const route = `/${camel(v.context ?? ir.system)}/${camel(v.label)}`;
    // LAST GUARD, and it is the one whose absence takes down a fixture: if that route string is already
    // in the tree under any name, do not write a second endpoint on it. Detection above is by view type,
    // so a GET that serves this route while naming a DIFFERENT type would slip past it.
    if (tree.some((f) => uncommented(f.src).includes(`"${route}"`))) {
      readEndpointsSkipped.push({ view: v.label, why: `route ${route} is already taken in this tree` });
      continue;
    }

    const t = pascal(v.label);
    const p = join(APP, "Views", `${t}Endpoint.cs`);
    if (!existsSync(p)) readEndpointsWritten.push({ view: v.label, route });
    scaffold(p,
      `${banner(`${v.label} — the read endpoint of a state-view slice`)}
using Marten;
using Wolverine.Http;

namespace ${NS}.Views;

/// <summary>
/// THE CONTRACT OF A STATE-VIEW SLICE IS THIS ENDPOINT, which is why it is generated at all — a GT
/// asserts "the read model shows this" and the honest place to assert it is through the query surface a
/// caller actually gets, not against the document store. Finding <b>BP4</b> — which resolves with
/// <c>grep -n BP4 KIT-FINDINGS.md KIT-HISTORY.md</c>, since an id lives in whichever file matches its status.
///
/// SCAFFOLD: yours from here, and regeneration keeps it. Three things below are a starting point rather
/// than an answer, and all three are why this is not <c>emit</c>:
/// <list type="number">
///   <item><b>the route.</b> <c>/{context}/{view}</c> is the convention every hand-written read endpoint
///     in this kit converged on, and every one of them then changed it. Moving it is a legal edit — but
///     if this app is served behind nginx, run <c>codegen</c> afterwards: an unproxied route reaches the
///     SPA fallback and a fetch gets <c>index.html</c> with a <b>200</b>, and <c>ROUTE NOT PROXIED</c> is
///     what says so.</item>
///   <item><b>the query.</b> This returns every row, because <c>identity=</c> says what one row IS and
///     the model never says which subset a screen wants. "${v.label}" almost certainly implies a filter
///     the model does not carry — take it from the screen's own <c>displays=</c> and the GT.</item>
///   <item><b>list or one row.</b> One row is keyed by ${(v.identity ?? []).length
        ? `<c>${(v.identity ?? []).join(", ")}</c>` : "nothing the model declares"}. A detail screen wants
///     that single row; add the second route rather than making the caller filter a list.</item>
/// </list>
///
/// <c>IQuerySession</c>, not <c>IDocumentSession</c> — then "a read endpoint never writes" is a compile
/// error rather than a code review.
/// </summary>
public static class ${t}Endpoint
{
    public const string Route = "${route}";

    [WolverineGet(Route)]
    public static Task<IReadOnlyList<${t}>> Get(IQuerySession session, CancellationToken cancellation)
        // TODO(codegen): narrow this. Every row of every ${t} is almost never what the screen asked for.
        => session.Query<${t}>().ToListAsync(cancellation);
}
`);
  }
}

// HOW A RULE NAME REACHES AN HTTP CALLER — one helper per SYSTEM, and EMIT rather than scaffold.
//
// WHY ONE PER SYSTEM, at the root namespace rather than in Slices/<Context>/: the body holds no domain
// fact and no context-specific content, so a per-context copy would be N byte-identical files. The root
// namespace is an ancestor of every `<NS>.Slices.<Context>` namespace, so every call site resolves
// `Rejections` with no using at all — measured on Voltway, 14 call sites across 8 endpoints in TWO
// contexts, against exactly this placement.
//
// WHY EMIT: the file has no judgement in it, and there is independent evidence of that — two projects
// wrote it by hand in two uncoordinated runs and converged on the same signature and the same one-line
// body, differing only in `400` vs `StatusCodes.Status400BadRequest`. But the decisive reason is the doc
// comment. That comment IS the rejection wire contract, and KIT-FINDINGS BP1 is what happens when the
// contract is wrong: a false sentence in CLAUDE.md propagated into both hand-written copies and nothing
// could reach back to fix either. `scaffold` would rebuild that exact trap — a corrected contract would
// never reach a project that already exists. Emit is the only setting under which fixing the shape fixes
// every project on the next run.
//
// The rejection SHAPE below is measured, not asserted: probes/rejection-shape.cs runs both paths through
// a real [WolverinePost] with a real validator attached, with a control.
emit(join(APP, "Rejections.cs"),
  `${banner("how a rule name reaches an HTTP caller")}
namespace ${NS};

/// <summary>
/// THE RULE NAME IS ALWAYS IN <c>Title</c>, ON BOTH ENFORCEMENT PATHS — but only because Program.cs
/// installs a ProblemDetails customiser that puts it there for a periphery failure. Without that line the
/// two shapes differ, and a UI reading <c>title</c> shows the user "One or more validation errors
/// occurred." instead of the rule that refused them. KIT-FINDINGS BP1.
///
/// What each path additionally carries is NOT the same, and a reader must not assume it is:
/// <list type="bullet">
///   <item>a PERIPHERY rejection (FluentValidation) additionally carries <c>errors.&lt;Property&gt;</c></item>
///   <item>a DECIDER rejection (this helper) additionally carries <c>detail</c></item>
/// </list>
/// With two periphery failures at once, <c>title</c> holds the FIRST — in the validator's own
/// <c>RuleFor</c> declaration order — and the full set stays in <c>errors</c>. So a caller that needs
/// every broken rule must read <c>errors</c>; <c>title</c> alone is one of them.
///
/// <c>then="error: RuleName"</c> on a GWT therefore asserts <c>title</c> whichever path refused the
/// command, which is what makes <c>enforce=</c> an implementation choice rather than a contract change.
/// </summary>
public static class Rejections
{
    public static IResult Problem(string rule, string detail) =>
        Results.Problem(title: rule, detail: detail, statusCode: StatusCodes.Status400BadRequest);
}
`);

// WHICH COMMANDS CAN BE PARTITIONED BY STREAM — KIT-FINDINGS V12.
//
// Exactly those that carry their whole stream key as a member, which is the same predicate the decider
// uses to hand `[WriteAggregate]` a `StreamKey`. A creating slice is excluded because its key is minted
// inside the handler (BT6) and does not exist at routing time, which is when a group id must be known.
//
// One computation, two readers — the same rule that keeps the decider and the command record in agreement.
const partitionRules = ir.slices
  .filter((s) => s.generates && s.commands.length)
  .map((s) => {
    const cmd = s.commands[0];
    const agg = ir.shared.aggregates.find((a) => a.commands.some((c) => c.label === cmd));
    const fields = agg?.commands.find((c) => c.label === cmd)?.fields ?? [];
    const carries = !mintedIdentityOf(agg, cmd).length
      && (agg?.identity ?? []).length && agg.identity.every((k) => fields.some((f) => f.name === k));
    return carries ? { type: `${NS}.Slices.${pascal(s.context)}.${pascal(cmd)}`, slice: s.name } : null;
  })
  .filter(Boolean)
  // A command type is emitted ONCE even where two slices name it, or the generated config would not compile.
  .filter((r, i, all) => all.findIndex((x) => x.type === r.type) === i);

emit(join(APP, "Program.cs"),
  `${banner("application bootstrapping")}
using JasperFx;
// TypeLoadMode is JasperFx.CodeGeneration.TypeLoadMode (values Dynamic, Auto, Static), TYPE-FORWARDED into
// JasperFx.dll — so this using is required and referencing the JasperFx.CodeGeneration package is not. No
// doc page states the namespace and the package .xml does not document the enum; settled by reflecting over
// the assembly, which is this kit's documented tiebreaker.
using JasperFx.CodeGeneration;
using JasperFx.Resources;
using JasperFx.Events;
using Weasel.Core;
using JasperFx.Events.Projections;
using Marten;
using Wolverine;
using Wolverine.ErrorHandling;         // OnException<T>() is an extension on IWithFailurePolicies; no doc page names it
using Wolverine.FluentValidation;
using Wolverine.Http;
using Wolverine.Http.FluentValidation;
using Marten.Schema;
// ExistingStreamIdCollisionException is Marten.Exceptions.*, settled from the package .xml
// (T:Marten.Exceptions.ExistingStreamIdCollisionException) — no doc page names it.
using Marten.Exceptions;
using Wolverine.Marten;
using Microsoft.AspNetCore.Mvc;        // ValidationProblemDetails, for the rejection-shape customiser below
using Microsoft.AspNetCore.Diagnostics; // IExceptionHandlerFeature, for the 409 below. No doc page names it
using ${NS};
using ${NS}.Views;${automations.length ? `
using ${NS}.Automation;
${[...new Set(automations.map((s) => `using ${NS}.Slices.${pascal(s.context)};`))].join("\n")}` : ""}

var builder = WebApplication.CreateBuilder(args);
${automations.length === 0 ? "" : `
// FIRST, and the order matters: each wakeup resolves which mechanism was chosen here, and every
// Configure* hook below asks it. Resolved last, a mechanism sets flags after the callbacks that read
// them have already run — no error, and the automation never wakes.
${automations.map((s) => `${pascal(s.name)}Wakeup.Choose(builder.Configuration);`).join("\n")}`}

var marten = builder.Services.AddMarten(opts =>
    {
        opts.Connection(builder.Configuration.GetConnectionString("Marten")!);
        opts.DatabaseSchemaName = "${camel(ir.system)}";

        // Marten fixes stream identity ONCE PER STORE — Guid and string streams cannot be mixed — so this
        // follows from the keys every swimlane declares:
${[...new Set(ir.shared.aggregates.filter((a) => a.identity.length).map((a) => a.identity.join(" + ")))]
      .map((k) => `        //   ${k}`).join("\n")}
        // ${STREAM_IDENTITY === "AsGuid"
        ? "Every one of them is a single Guid field, so the stream id IS that field."
        : "At least one is a composite, and a composite cannot be a Guid — so every stream id is a string."}
        opts.Events.StreamIdentity = StreamIdentity.${STREAM_IDENTITY};

        // StreamOne/StreamMany write Marten's RAW JSON to the response, which bypasses ASP.NET's
        // camelCase policy entirely. Set the casing here or every read endpoint quietly returns
        // PascalCase and the front end silently reads undefined.
        opts.UseSystemTextJsonForSerialization(EnumStorage.AsString, Casing.CamelCase);

        // Read side. WHICH recipe each read model uses is a decision this generator cannot make —
        // identity= narrows it to one of Marten's six and no further — so the registrations live in a
        // SCAFFOLD that regeneration keeps. Write side registers NOTHING: the per-slice state types
        // are folded live on demand.
        ViewRegistrations.Register(opts);
${automations.length === 0 ? "" : `
${automations.map((s) => `        ${pascal(s.name)}Wakeup.ConfigureMarten(opts);`).join("\n")}`}
    })
    .IntegrateWithWolverine(${automations.length === 0 ? "" : `integration =>
    {
${automations.map((s) => `        ${pascal(s.name)}Wakeup.ConfigureIntegration(integration);`).join("\n")}
    }`});

// Starting data for running the app by hand: membership, an open month, one booking. Development
// only, and idempotent, because Populate runs on every startup.
if (builder.Environment.IsDevelopment()) marten.InitializeWith(new GenesisData());

${ir.shared.views.length === 0 ? "" : `// The read side may need the STORE, not just its options: any projection registered Async runs in the
// async daemon, and without the daemon nothing processes it and Marten only warns.
ViewRegistrations.ConfigureStore(marten);

`}${automations.length === 0 ? "" : `// A wakeup mechanism may need the STORE, not just its options — AddAsyncDaemon, for instance. A
// subscription and an async projection both run in the daemon, and neither exists without it.
${automations.map((s) => `${pascal(s.name)}Wakeup.ConfigureStore(marten);`).join("\n")}

`}builder.Services.AddResourceSetupOnStartup();

builder.Host.UseWolverine(opts =>
{
    // LOAD THE PRE-GENERATED DISPATCH CODE INSTEAD OF COMPILING IT, where it has been pre-generated.
    //
    // Wolverine's default is \`TypeLoadMode.Dynamic\`: it compiles handler and endpoint wrappers with Roslyn
    // on first use. \`Static\` says "the pre-generated types are in this assembly; load them by name and skip
    // the compile step" — and per the AOT page, a handler with no pre-generated code then fails HOST STARTUP
    // with an error naming the missing file, "rather than silent fallback to Roslyn". That loud failure is
    // the whole point; the faster cold start is a bonus.
    //
    // OPT-IN BY ENVIRONMENT VARIABLE, BECAUSE ONLY SOME BUILDS HAVE RUN \`codegen write\`. The Dockerfile
    // does it at build time and sets this; \`dotnet run\` and the test host do not, and Static there would
    // fail startup for a completely correct reason. So the variable is the question "has codegen run?" and
    // nothing else.
    //
    // THIS VARIABLE IS OURS, AND SAYING SO MATTERS. Nothing in JasperFx, Wolverine or the docs mirror reads
    // any \`JASPERFX_*\` environment variable — the string appears zero times across 394 mirrored pages and
    // in none of the three assemblies. This kit shipped \`ENV JASPERFX_CODEGEN_TYPE_LOAD_MODE=Static\` in a
    // hand-written Dockerfile for a whole project, and it did nothing at all: the container ran Dynamic and
    // said so in its own startup log, while three documents recorded Static as measured. KIT-HISTORY BO2.
    // The line below is the mechanism the mirror actually documents, and it works because something READS it.
    if (Environment.GetEnvironmentVariable("WOLVERINE_CODEGEN_STATIC") == "true")
        opts.CodeGeneration.TypeLoadMode = TypeLoadMode.Static;

    opts.Policies.AutoApplyTransactions();

    // WHERE THE OPTIMISTIC-CONCURRENCY GUARD LIVES ONCE THE MIDDLEWARE OWNS THE SAVE.
    //
    // A decider written in the aggregate handler workflow does not call SaveChangesAsync, so it cannot
    // catch the collision that a SIMULTANEOUS duplicate produces — two runs that both folded before
    // either appended, both legitimately passing the business rule. The kit used to catch
    // EventStreamUnexpectedMaxEventIdException inside each decider and translate it into that slice's
    // rejection, which meant every slice carried a second, hand-written copy of a rule it already had.
    //
    // Retrying is better and it is what the Marten page means by "you're going to want some resiliency
    // and selective retry capabilities for concurrent access violations": on the retry the middleware
    // re-fetches, the state now includes the winner's event, and THE ORDINARY RULE refuses it. One source
    // of the refusal instead of two that have to be kept in agreement.
    //
    // Both names, because they are the same verdict and Marten has used both: ConcurrencyException moved
    // to JasperFx in Marten 9, and an append that collides on (stream_id, version) surfaces as
    // EventStreamUnexpectedMaxEventIdException regardless of what the docs say. KIT-FINDINGS BM2.
    //
    // AND THE CHAIN NOW ENDS SOMEWHERE — \`.Then.MoveToErrorQueue()\`. Without a terminal action an
    // exhausted retry escapes as a bare 500 and the work is GONE, with no dead letter and nothing to
    // inspect. Measured (probes/retry-budget.cs): at 16 concurrent writers to one stream, 9 of 16 appends
    // were destroyed exactly that way. Wolverine's own samples always terminate the chain; the kit never
    // did. KIT-FINDINGS V12.
    opts.OnException<ConcurrencyException>().RetryTimes(3).Then.MoveToErrorQueue();
    opts.OnException<EventStreamUnexpectedMaxEventIdException>().RetryTimes(3).Then.MoveToErrorQueue();
    // THE THIRD ONE, AND ITS ABSENCE WAS A MEASURED DEFECT. There are TWO refusal mechanisms, not one, and
    // which you get depends on whether the stream already existed:
    //
    //   creating the stream — a first write to the key   the stream table's primary key
    //                                                    -> ExistingStreamIdCollisionException
    //   appending to a stream that exists                the optimistic version check
    //                                                    -> EventStreamUnexpectedMaxEventIdException
    //
    // Only the second was retried. So on any slice whose command CREATES the stream — every "already X"
    // latch on a first notice — a lost race escaped \`InvokeAsync\` as an unhandled exception, which is
    // exactly the V7 failure the bus path is supposed to prevent. Measured on Voltway: 8 concurrent
    // \`PublishBayOffered\` gave "Stream #… already exists in the database" out of the handler, and the same
    // for \`ListBay\`. Two of five race tests, red on the mechanism and not on the rule.
    //
    // THE KIT ALREADY KNEW. \`architect.mjs\`'s own \`ConcurrencyHarness.Classify\` switches on all THREE
    // names, and the architect skill tabulates both mechanisms — so one tool documented what the other
    // omitted, which is V9's shape at the level of a single line. KIT-FINDINGS BS1.
    opts.OnException<ExistingStreamIdCollisionException>().RetryTimes(3).Then.MoveToErrorQueue();
${partitionRules.length === 0 ? "" : `
    // PARTITIONED SEQUENTIAL MESSAGING — the only thing measured to actually FIX contention, rather than
    // retry it. Commands carrying the same stream key are routed to ONE local queue and run in order, so
    // the race never happens; different streams still run in parallel. Measured across three arms
    // (probes/retry-budget.cs), 16 concurrent writers to one stream:
    //
    //   RetryTimes(3)                 7 of 16 landed, 9 destroyed
    //   RetryWithCooldown             6 of 16 landed  (it moves the cliff by ONE writer, it is not a fix)
    //   partitioned + published      16 of 16 landed
    //
    // THE ByMessage RULES BELOW ARE NOT OPTIONAL AND THIS IS THE TRAP. \`UseInferredMessageGrouping()\` is
    // documented as grouping by "the stream id of any command that is part of the aggregate handler
    // workflow", and on a [WriteAggregate] PARAMETER it yielded \`group=(NONE)\` — measured. A null group
    // id is not a no-op: Wolverine then picks a queue AT RANDOM, so one stream's commands scatter and race
    // exactly as before, while the configuration reads as though contention had been handled.
    //
    // IT ONLY PROTECTS PUBLISHED MESSAGES. Partitioning is a ROUTING rule, and \`InvokeAsync\` runs the
    // handler inline without routing — measured as a fourth arm, identical to no protection at all. So an
    // HTTP endpoint that invokes its decider to get the outcome back (which is what the rejection contract
    // requires) is NOT covered here; that path gets the 409 below instead. Automations, translations and
    // the ingest seam publish, and those are covered.
    opts.MessagePartitioning
${/* A GROUP ID IS A STRING. `StreamKey` is the STORE's id type, so on a Guid-identity store it needs
      converting — CS0029 otherwise, on five of six reference implementations. The first check of this
      emit used the one project with a composite (string) key, which compiled and hid it. */
  partitionRules.map((r) => `        .ByMessage<${r.type}>(x => x.StreamKey${STREAM_ID === "Guid" ? ".ToString()" : ""})`).join("\n")}
        .PublishToPartitionedLocalMessaging("${camel(NS)}-writes", 4, topology =>
        {
${partitionRules.map((r) => `            topology.MessagesImplementing<${r.type}>();`).join("\n")}
        });
`}
    // Durable local queues are what make the ingest seam in Landing/ durable without any durability
    // code: a message routed to a local queue is written to the Postgres envelope tables before its
    // handler runs, retried if the handler throws, and dead-lettered when it keeps throwing. That inbox
    // is a translation's todo list — the one it cannot have as a projection, because a foreign event is
    // never in our store.
    opts.Policies.UseDurableLocalQueues();
    opts.UseFluentValidation();
${automations.length === 0 ? "" : `${automations.map((s) => `    ${pascal(s.name)}Wakeup.ConfigureWolverine(opts);`).join("\n")}`}
${automations.length === 0 ? "" : `
    // An automation's trigger is a Wolverine message handler, but its class is named after the
    // automation cell on the model — ZeroFillProcessor, AdminNotifier — and Wolverine's conventional
    // discovery only finds types called *Handler or *Consumer. Registering them explicitly keeps the
    // model's vocabulary in the code instead of renaming a domain concept to suit a scanning rule.
    //
    // typeof(), not IncludeType<T>(): a Wolverine handler class is static, and a static type cannot be
    // a generic argument.
${automations.flatMap((s) => (s.automations ?? []).map(
  (a) => `    opts.Discovery.IncludeType(typeof(${pascal(a)}));`)).join("\n")}`}
});

// THE ONE LINE THAT MAKES THE TWO REJECTION PATHS THE SAME SHAPE.
//
// A rule refused at the PERIPHERY and a rule refused by a DECIDER do not produce the same body. Measured
// on the wire with a control, in probes/rejection-shape.cs:
//
//   periphery  {"title":"One or more validation errors occurred.","status":400,
//               "errors":{"Reason":["ReasonRequired"]}}
//   decider    {"title":"AlreadyCancelled","status":400,"detail":"Booking b-1 has already been cancelled."}
//
// Same status, same type, and the rule name in a DIFFERENT PLACE. A UI written to read \`title\` — which is
// what CLAUDE.md told every agent to do — shows the user "One or more validation errors occurred." and
// loses \`ReasonRequired\` entirely. KIT-FINDINGS BP1.
//
// The customiser copies the first rule name into \`title\`, so \`title\` carries it on both paths and
// \`then="error: RuleName"\` asserts one thing. \`errors\` is left ALONE and still holds every broken rule,
// so nothing is traded away: with two failures at once \`title\` holds the first in RuleFor declaration
// order and the full set stays in \`errors\`.
//
// THAT IT FIRES AT ALL IS THE MEASURED PART, and it was the real risk. Wolverine.Http's generated code
// writes a validation failure as \`Results.Problem(problemDetails).ExecuteAsync(httpContext)\`, and whether
// that reaches IProblemDetailsService is stated on no doc page. It does: the probe runs a real
// [WolverinePost] with a real IValidator attached and the customiser fires on both paths, with \`errors\`
// intact. Nothing Wolverine-specific is needed beyond this standard ASP.NET registration.
builder.Services.AddProblemDetails(opts =>
{
    opts.CustomizeProblemDetails = ctx =>
    {
        // Both shapes are tried because the middleware's choice is not contractual: it builds a
        // ValidationProblemDetails today, and an \`errors\` extension on a plain ProblemDetails would be
        // the same wire format with a different CLR type.
        var rule = ctx.ProblemDetails switch
        {
            ValidationProblemDetails { Errors.Count: > 0 } v => v.Errors.Values.First().FirstOrDefault(),
            _ when ctx.ProblemDetails.Extensions.TryGetValue("errors", out var raw)
                   && raw is IDictionary<string, string[]> { Count: > 0 } d
                => d.Values.First().FirstOrDefault(),
            _ => null,
        };

        if (!string.IsNullOrWhiteSpace(rule)) ctx.ProblemDetails.Title = rule;
    };
});

builder.Services.AddWolverineHttp();

${automations.length === 0 ? "// No automation slice is past in-design, so nothing needs waking." :
`// HOW EACH AUTOMATION IS WOKEN — one hook per slice, and the generator deliberately does NOT choose.
//
// The model constrains the contract, not the mechanism: it says the trigger decides from accumulated
// state and issues a command, and says nothing about what wakes it. Event forwarding, a Marten
// subscription, projection RaiseSideEffects and a clock-driven sweep are all valid; which is right
// depends on whether the trigger event is ours, whether ordering matters, and whether the trigger is an
// event at all rather than the passage of time.
//
// Each Register body is SCAFFOLD — hand-owned, kept by regeneration — and carries the decision table
// plus a TODO(codegen) marker that codegen reports until it is gone. Worked implementations of all four
// against one shared model: reference-implementations/automation/.
${automations.map((s) => `${pascal(s.name)}Wakeup.RegisterServices(builder);`).join("\n")}`}

if (builder.Environment.IsDevelopment())
{
    // The Vite dev server is a different origin. Development only — never a wildcard in production.
    builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
        .WithOrigins("http://localhost:5173")
        .AllowAnyHeader()
        .AllowAnyMethod()));
}

var app = builder.Build();

if (app.Environment.IsDevelopment()) app.UseCors();

// A LOST RACE IS A CONFLICT, NOT A SERVER ERROR — KIT-FINDINGS V12.
//
// The retry policy above is a MESSAGE-pipeline policy and a Wolverine.HTTP endpoint never enters that
// pipeline (V7), and partitioned messaging cannot help either: it is a ROUTING rule, and an endpoint that
// invokes its decider inline to get the outcome back is never routed. Measured as a fourth arm of
// probes/retry-budget.cs — identical to no protection at all.
//
// So on the HTTP write path a concurrent duplicate leaves as an unhandled exception, and the caller is
// told the server broke. It did not: the caller lost a race and the correct thing to do is try again.
// 409 says exactly that and nothing more. It is deliberately NOT translated into a business rule name —
// a version conflict does not mean the rule failed, and on a stream shared with another context an
// unrelated concurrent append collides too, so a rule name here would refuse a valid command with a
// reason that is untrue.
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    ExceptionHandler = async context =>
    {
        var error = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        if (error is ConcurrencyException or EventStreamUnexpectedMaxEventIdException
                  or ExistingStreamIdCollisionException)
        {
            await Results.Problem(
                title: "Conflict",
                detail: "Another change to the same stream committed first. The command was not applied — retry it.",
                statusCode: StatusCodes.Status409Conflict).ExecuteAsync(context);
        }
        else if (error is not null)
        {
            await Results.Problem(statusCode: StatusCodes.Status500InternalServerError).ExecuteAsync(context);
        }
    }
});

app.MapWolverineEndpoints(opts =>
{
    // Turns a failed FluentValidation validator into a 400 with ProblemDetails.
    opts.UseFluentValidationProblemDetailMiddleware();
});

return await app.RunJasperFxCommands(args);
`);

emit(join(APP, "appsettings.json"),
  JSON.stringify({
    ConnectionStrings: { Marten: "Host=localhost;Port=5433;Database=" + camel(ir.system).toLowerCase() + ";Username=postgres;Password=postgres" },
    Logging: { LogLevel: { Default: "Information", "Microsoft.AspNetCore": "Warning" } },
  }, null, 2) + "\n");

emit(join(APP, `${NS}.csproj`),
  `<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>${NS}</RootNamespace>
  </PropertyGroup>

  <ItemGroup>
    ${pkg("Marten")}
    ${pkg("Marten.AspNetCore")}
    ${pkg("WolverineFx.Http")}
    ${pkg("WolverineFx.Http.Marten")}
    ${pkg("WolverineFx.Http.FluentValidation")}
    ${pkg("WolverineFx.Marten")}
    ${pkg("WolverineFx.FluentValidation")}
    ${pkg("WolverineFx.RuntimeCompilation")}
  </ItemGroup>

</Project>
`);

emit(join(TESTS, `${NS}.IntegrationTests.csproj`),
  `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
    <RootNamespace>${NS}.IntegrationTests</RootNamespace>
  </PropertyGroup>

  <ItemGroup>
    ${pkg("Alba")}
    ${pkg("WolverineFx")}
    ${pkg("JasperFx")}
    ${pkg("Shouldly")}
    ${pkg("Testcontainers.PostgreSql")}
    ${pkg("xunit")}
    ${pkg("xunit.runner.visualstudio")}
    ${pkg("Microsoft.NET.Test.Sdk")}
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\\..\\src\\${NS}\\${NS}.csproj" />
  </ItemGroup>

</Project>
`);

// The XML solution format, because a classic .sln is GUID soup that no generator should emit and no
// human should diff.
emit(join(OUT, `${NS}.slnx`),
  `<Solution>
  <Project Path="src/${NS}/${NS}.csproj" />
  <Project Path="tests/${NS}.IntegrationTests/${NS}.IntegrationTests.csproj" />
</Solution>
`);

// --- the compose stack: the deployed shape, and the only artifact a UI journey can walk ---------
//
// FOUR FILES, AND UNTIL NOW EVERY ONE OF THEM WAS HAND-WRITTEN ONCE, ON ONE PROJECT. `ui-journey`'s gate
// says the run that counts is against compose — Vite proxies the API itself, so the dev server cannot see
// a wrong nginx proxy prefix, a missing ASPNETCORE_ENVIRONMENT that leaves the seed unapplied, or a
// runtime that cannot do Wolverine's codegen — and nothing in the kit wrote the file that gate needs. So
// the gate was unmeetable on a fresh project, and the previous one met it only because somebody typed the
// files out by hand. KIT-HISTORY BN4.
//
// ALL FOUR ARE emit(). Nothing in them is a domain judgement: the system name, the database name, the
// ports, the API prefixes and the screen paths are all in the IR or in the generated tree, and each of the
// four traps they exist to catch is a fact about THIS STACK rather than about a business.
//
//   the nginx prefix trap      `location /estate` is a PREFIX match, so it swallows the SCREEN route
//                              /estate-admin and hands it to an API that answers 404 — an empty page with
//                              no error. Needs `location ^~ /estate/`, and the trailing slash is the fix
//   the SPA fallback           every screen is a real path a user can link and RELOAD, so without
//                              try_files only "/" loads and every deep link 404s
//   ASPNETCORE_ENVIRONMENT     the demo seed hangs off IsDevelopment(); without it the app is healthy,
//                              every endpoint answers 200, and every screen is empty
//   Wolverine runtime codegen  the aspnet runtime image carries no Roslyn reference assemblies, so the
//                              wrappers are PRE-GENERATED into the image and TypeLoad mode is Static
//
// THE ESCAPE HATCH IS DOCKER'S OWN, which is why none of this needs a scaffold. `docker compose` merges
// docker-compose.override.yml natively and codegen never writes it, so a local port change, a published
// database or an extra service survives regeneration — the same shape of answer as package-versions.json,
// and it is documented in the emitted header rather than only here.
//
// NOT ADDED TO `scaffold`'s GATE, deliberately: a docker build is minutes, and whether the stack comes up
// is `ui-journey`'s question. scaffold emits these and reports them; nothing else gates on them.

// WHETHER THIS SYSTEM HAS A FRONT END IS A FACT ABOUT THE TREE, NOT ABOUT THE MODEL — and deriving it
// from the model is exactly the mistake a Voltway-shaped derivation makes. Every reference implementation
// DECLARES screens on its model, between one and three of them, and not one has a line of React: they are
// backend worked examples. An nginx service in front of a directory with no app in it is a compose file
// that cannot come up, so the signal is web/package.json — written by frontend-agent when it ports the
// first screen, and never touched by codegen.
const WEB = join(OUT, "web");
const hasWeb = existsSync(join(WEB, "package.json"));

// The compose project name and the database name are the same slug, and it is the one appsettings.json
// already uses — two files naming one database differently is a debugging round nobody should have.
const SLUG = camel(ir.system).toLowerCase();
const OUT_REL = (relative(PROJECT, OUT) || ".").replace(/\\/g, "/");

// THE API's PUBLISHED PORT DOES NOT MOVE WHEN A FRONT END ARRIVES. 8080 is the browser's origin by
// convention across this kit — uijourney's scaffolded config prints PW_BASE_URL=http://localhost:8080 —
// so nginx takes it whenever there is an nginx, and the API keeps 8081 whether or not anything is in
// front of it. The alternative (put the API on 8080 when it is alone) silently swaps the two the day the
// first screen is ported, and then every curl written before that day hits the wrong process.
const API_PORT = 8081;
const WEB_PORT = 8080;

const hashBanner = (what) =>
  `# <auto-generated>\n#   ${what}\n#   Generated by tools/codegen.mjs from the event model. Do not edit by hand:\n` +
  `#   re-run codegen and the change is lost.\n` +
  `#\n` +
  `#   THE ESCAPE HATCH IS DOCKER'S OWN, and it is ${OUT_REL}/docker-compose.override.yml —\n` +
  `#   which \`docker compose up\` merges natively and this generator never writes. A published database\n` +
  `#   port, a different host port and an extra service go straight in it; a changed build goes in as\n` +
  `#   \`build: {dockerfile: <your own file>}\`. Editing inside THIS file is reverted by the next codegen\n` +
  `#   run, silently, with the symptom arriving later as behaviour rather than as an error.\n` +
  `# </auto-generated>\n`;

// THE API PREFIXES ARE THE MODEL'S CONTEXTS, because that is the route convention this generator emits:
// every endpoint it scaffolds is `/{camel(context)}/{camel(slice)}`, and the hand-owned read endpoints
// beside them follow it. Every context gets a prefix, including one with no route yet — a prefix pointing
// at nothing costs a 404 on a URL nobody has, while a MISSING prefix costs the silent empty screen this
// whole file exists to prevent. That asymmetry is the whole argument.
//
// The derivation is checked rather than trusted: a route in the generated tree whose first segment is not
// one of these is reported as ROUTE NOT PROXIED at the end of the run, because a hand-owned endpoint is
// free to move off the convention and nothing else would notice.
const apiPrefixes = [...new Set((ir.models ?? []).map((m) => camel(m.context)))].sort();
const screenSlugs = (ir.shared.screens ?? []).map((s) => s.slug).sort();
// The concrete reason the trailing slash is not tidiness, named from THIS model rather than asserted.
//
// THIS USED TO EXCLUDE THE EQUALITY CASE (`s !== p`) AND THAT WAS BACKWARDS: a screen slug EQUAL to an API
// prefix is the one that actually breaks, and it was the one case the derivation could not report. Measured
// under real nginx with a control — with the `^~ /cart/` block present, a request for `/cart` comes back
// **301 to /cart/**, which then proxies to the API and 404s; remove the block and it is 200 from the SPA. So
// the prefix location captures the slash-less form after all, and the trailing slash only saves the LONGER
// slugs. The old comment named /cart-error, measured 200 and perfectly fine, while staying silent about
// /cart. KIT-HISTORY BO3.
const swallowed = apiPrefixes.flatMap((p) =>
  screenSlugs.filter((s) => s.startsWith(p)).map((s) => ({ prefix: p, screen: s, exact: s === p })));
// A screen slug that IS a prefix needs an exact-match location, because `location = /x` beats `location ^~
// /x/` for the bare URI and hands it to the SPA. Verified as the fix, not assumed.
const exactScreens = [...new Set(swallowed.filter((s) => s.exact).map((s) => s.screen))];
// A REAL route to make the proxy_pass rule concrete. An abstract "the matched prefix would be stripped"
// is forgettable; "/charging/holdBay would arrive as /holdBay" is not, and the route is the one this
// generator actually emits for that slice.
const exampleRoute = (() => {
  const p = apiPrefixes[0];
  if (!p) return null;
  const s = (ir.slices ?? []).find((x) =>
    camel(x.context) === p && x.pattern === "state-change" && (x.commands ?? []).length);
  return s ? { full: `/${p}/${camel(s.name)}`, stripped: `/${camel(s.name)}` } : null;
})();

emit(join(OUT, "docker-compose.yml"),
  `${hashBanner(hasWeb
    ? `the deployed shape of ${NS} — the thing a UI journey is supposed to walk`
    : `the deployed shape of ${NS} — its API and its database, and nothing else`)}
#   docker compose -f ${OUT_REL}/docker-compose.yml up -d --build
${hasWeb ? `#   PW_BASE_URL=http://localhost:${WEB_PORT} npx playwright test    # from ${OUT_REL}/web
` : ""}#
# WHY THIS EXISTS RATHER THAN "just run the app". ${hasWeb
  ? `Vite proxies the API prefixes itself, so the dev server
# cannot see a wrong nginx proxy_pass prefix, a missing ASPNETCORE_ENVIRONMENT that leaves the demo seed
# unapplied, or a runtime that cannot do Wolverine's codegen. All three have happened in this kit, and each
# of them renders as AN EMPTY SCREEN WITH NO ERROR — which is why a journey's guard is \`assert real data\`,
# and not \`assert no error\`.
#
# THE BROWSER SEES ONE ORIGIN. nginx serves the bundle and proxies ${apiPrefixes.length === 1 ? "the API prefix" : `all ${apiPrefixes.length} API prefixes`}, so every fetch in
# web/src is relative and there is no CORS anywhere in this file.`
  : `\`dotnet run\` reads appsettings.json and expects a
# Postgres somebody started by hand. This is the whole system in one command, and it is what proves the
# published image can do Wolverine's codegen — which a local run with an SDK on the PATH cannot.
#
# THERE IS NO WEB SERVICE AND NO NGINX, because ${OUT_REL}/web/package.json does not exist:
# this system has no front end to serve. ${screenSlugs.length
    ? `Its model declares ${screenSlugs.length} screen(s) — ${screenSlugs.join(", ")} —
# which is a statement about the model rather than about the tree; port one and regenerate to get nginx.`
    : `Its model declares no screens either, so that is settled.`}`}

name: ${SLUG}

services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ${SLUG}
    # DELIBERATELY NOT PUBLISHED TO THE HOST. The Testcontainers Postgres the integration suite spins up
    # and the dev-loop container appsettings.json points at are different databases with different
    # lifetimes, and a published port here is how they get confused for each other. Nothing outside this
    # network needs to reach it; docker-compose.override.yml is where to publish it if you disagree.
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d ${SLUG}"]
      interval: 3s
      timeout: 3s
      retries: 20
    tmpfs:
      # The demo database is disposable, and a run that inherits the last one's state is a run asserting
      # on somebody else's data. \`down\` and \`up\` is a clean world.
      - /var/lib/postgresql/data

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      # THE SEED LIVES BEHIND THIS. Program.cs does \`if (builder.Environment.IsDevelopment())
      # marten.InitializeWith(new GenesisData())\`, so without this line the app is healthy, every endpoint
      # answers 200, and ${hasWeb
        ? `every screen is empty — indistinguishable from "nothing here yet".`
        : `every read comes back empty — indistinguishable from "nothing here yet".`}
      ASPNETCORE_ENVIRONMENT: Development
      ConnectionStrings__Marten: "Host=db;Port=5432;Database=${SLUG};Username=postgres;Password=postgres"
    depends_on:
      db:
        condition: service_healthy
    expose:
      - "8080"
${hasWeb
  ? `    # Published so a failing journey can be interrogated with curl against the same process the browser
    # is talking to, rather than against a second one started by hand. It stays on ${API_PORT} whether or not
    # there is an nginx in front, so a command written today does not quietly change meaning tomorrow.`
  : `    # Published so a failing run can be interrogated with curl against the process compose started,
    # rather than against a second one started by hand. It is ${API_PORT} rather than ${WEB_PORT} because ${WEB_PORT} is the
    # browser's origin by convention here, and the API's door must not move when a front end arrives.`}
    ports:
      - "${API_PORT}:8080"
${hasWeb ? `
  web:
    build:
      context: ./web
      dockerfile: Dockerfile
    depends_on:
      - api
    ports:
      - "${WEB_PORT}:80"
` : ""}`);

emit(join(OUT, "Dockerfile"),
  `${hashBanner(`the ${NS} API. Build context is ${OUT_REL}, so the solution's own layout is preserved`)}
# WOLVERINE GENERATES CODE AT RUNTIME, AND THAT IS THE INTERESTING PART OF THIS FILE.
#
# By default (\`TypeLoadMode.Dynamic\`) Wolverine compiles its handler and endpoint wrappers with Roslyn on
# first use. WolverineFx.RuntimeCompilation is referenced by the csproj, so the compiler ships in the publish
# output — and it works in this runtime image: measured, by running exactly this stack in Dynamic mode and
# serving real requests. So runtime compilation here is not broken and this file is not a workaround for it.
#
# WHAT IT IS FOR is turning a SILENT FALLBACK into a LOUD FAILURE, plus a faster cold start. Two steps, and
# both are needed — either alone does nothing:
#
#   1. \`codegen write\` below emits the wrappers as C# under Internal/Generated, and the publish compiles
#      them into the assembly. On its own this is dead weight: Dynamic mode recompiles anyway.
#   2. WOLVERINE_CODEGEN_STATIC below makes Program.cs set \`opts.CodeGeneration.TypeLoadMode = Static\`, so
#      the host LOADS those types by name. A handler with no pre-generated code then fails HOST STARTUP with
#      an error naming the missing file, instead of quietly compiling and working only where an SDK exists.
#
# THE VARIABLE IS THIS APPLICATION'S OWN, and Program.cs is what reads it. It is not a framework switch:
# nothing in JasperFx or Wolverine reads any environment variable for this, which is why the \`ENV
# JASPERFX_CODEGEN_TYPE_LOAD_MODE=Static\` line that used to sit here did nothing whatsoever. KIT-HISTORY BO2.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY src/${NS}/${NS}.csproj src/${NS}/
RUN dotnet restore src/${NS}/${NS}.csproj

COPY src/ src/

# Emits src/${NS}/Internal/Generated/**.cs. It needs no database: JasperFx's codegen command builds the
# application's model, not its data.
RUN dotnet run --project src/${NS}/${NS}.csproj --no-launch-profile -- codegen write

RUN dotnet publish src/${NS}/${NS}.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish ./

# Read by Program.cs, which turns it into TypeLoadMode.Static. Unset — in \`dotnet run\` and in the test
# host — the app stays on Dynamic, which is correct there: neither has run \`codegen write\`, so Static
# would fail startup for a completely good reason.
ENV WOLVERINE_CODEGEN_STATIC=true
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "${NS}.dll"]
`);

if (hasWeb) {
  // COPY EVERYTHING AND EXCLUDE, RATHER THAN NAME WHAT TO INCLUDE.
  //
  // THIS USED TO BE AN EIGHT-NAME ALLOW-LIST, filtered by existsSync and described in this comment as
  // "what the web app actually has". It was not: it was what the generator's author had thought of. A
  // `vite.config.mts` (a Vite-supported extension) and a `tsconfig.base.json` were both silently dropped —
  // exactly the failure the comment claimed to prevent — and an app with none of the eight emitted a bare
  // `COPY  ./`, which is not a parseable Dockerfile at all while codegen reported success. KIT-HISTORY BO4.
  //
  // An exclude list cannot have that failure mode: a file the front end adds is copied by default, and the
  // things that must NOT go in are few, known, and named in a .dockerignore beside the Dockerfile. Note
  // .dockerignore is read from the BUILD CONTEXT root, which is web/ — so it belongs here and not at the
  // solution root, and it is what keeps node_modules (hundreds of MB) out of the daemon's context upload.
  emit(join(WEB, ".dockerignore"),
    `${hashBanner(`what must not enter the ${NS} web image's build context`)}
# node_modules is reinstalled inside the image by the Dockerfile, and sending it costs hundreds of MB of
# context upload plus any native module built for the wrong platform.
node_modules

# Build output. Stale dist/ inside the context is worse than absent: the image builds its own.
dist
.vite

# The UI-journey layer. Playwright specs, its config, its report and its shots are not part of the app's
# bundle, and journeys/ deliberately typechecks against Node types the browser build excludes.
journeys
playwright.config.ts
playwright-report
test-results

# Screenshot scratch from tools/shoot.mjs's iframe trick.
_shot*.html
`);
  // npm ci REQUIRES a lockfile and fails outright without one, which is a worse first impression than a
  // slower install. Derived, not assumed.
  const locked = existsSync(join(WEB, "package-lock.json"));

  emit(join(WEB, "Dockerfile"),
    `${hashBanner(`the ${NS} front end: node builds the bundle, nginx serves it`)}
# \`npm run build\` typechecks before it bundles, so a type error fails the IMAGE rather than shipping. That
# is deliberate, and it is the app's own check: the journey specs are typechecked separately, because
# Playwright transpiles TypeScript and never checks it.
FROM node:22-alpine AS build
WORKDIR /app

${locked ? `COPY package.json package-lock.json ./\nRUN npm ci` : `# NO package-lock.json IN web/, so this cannot be \`npm ci\` — and the image is therefore not\n# reproducible. Commit a lockfile and this becomes \`npm ci\` on the next codegen run.\nCOPY package.json ./\nRUN npm install`}

# Everything else, with .dockerignore deciding what stays out — so a config the front end adds later is in
# the image without this file having to have predicted it. The install above is a separate, earlier layer on
# purpose: it is cached until the dependencies themselves change.
COPY . ./
RUN npm run build

FROM nginx:1.27-alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
`);

  emit(join(WEB, "nginx.conf"),
    `${hashBanner(`${NS}'s one origin: the bundle, and ${apiPrefixes.length} proxied API prefix(es)`)}
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  # KEEP THE ORIGINAL HOST AND PORT ON ANY REDIRECT NGINX GENERATES ITSELF. Measured: a 301 out of this
  # server carried \`Location: http://localhost/…\` while nginx was published on :8080, because nginx builds
  # an absolute URL from its own listen port and knows nothing about the host mapping. A browser following
  # that leaves the app's origin — so every redirect below is relative.
  absolute_redirect off;

  # ══════════════════════════════════════════════════════════════════════════════════════════════════
  # THE API PREFIXES, ANCHORED WITH ^~ AND A TRAILING SLASH. THIS IS NOT TIDINESS.
  #
  # A plain \`location /x\` is a PREFIX match, so it also swallows any SCREEN route that merely STARTS
  # with x and forwards it to the API — which has no such route and answers 404. The page simply does
  # not load, and the browser shows an empty screen with no error. Nothing in tsc, the vite build or
  # design.mjs can see it; web/vite.config.ts documents the same trap on the dev proxy and says outright
  # that "the same trap is waiting in the compose nginx config". This is that config.
  #
${swallowed.length
  ? swallowed.map(({ prefix, screen, exact }) => exact
      ? `  #   LIVE, AND THE ANCHORING IS NOT ENOUGH FOR IT: the screen route /${screen} is EXACTLY the API\n` +
        `  #   prefix /${prefix}. nginx redirects the bare /${screen} to /${screen}/ 301, which then proxies to the API\n` +
        `  #   and 404s — measured. The \`location = /${screen}\` block below is what hands it back to the SPA.`
      : `  #   LIVE: \`location /${prefix}\` (no trailing slash) would swallow the screen route /${screen}.`).join("\n")
  : `  #   No screen route in this model starts with an API prefix today, so nothing is being swallowed\n` +
    `  #   right now. The anchoring stays: the next screen slug is one \`add-slice\` away, and the failure\n` +
    `  #   it produces is an empty page rather than an error.`}
  #
  # \`^~\` also stops any regex location being considered once this prefix wins, and the trailing slash is
  # what makes a longer screen route fall through to the SPA fallback below where it belongs.
  #
  # proxy_pass carries NO path component on purpose: with a bare host:port nginx forwards the original
  # URI unchanged${exampleRoute ? `, so ${exampleRoute.full} arrives as ${exampleRoute.full}` : ""}. Adding a trailing slash to proxy_pass would STRIP the matched
  # prefix and the API would see ${exampleRoute ? `${exampleRoute.stripped}` : "the remainder"} — a 404, and the same silent empty screen by a different route.
  # ══════════════════════════════════════════════════════════════════════════════════════════════════
${exactScreens.length ? `${exactScreens.map((s) => `  # \`= \` is an EXACT match and beats the \`^~ /${s}/\` prefix below for the bare URI, which is the only way
  # to serve a screen whose slug IS an API prefix. Without it nginx 301s /${s} to /${s}/ and the API 404s.
  location = /${s} {
    try_files /index.html =404;
  }`).join("\n\n")}

` : ""}${apiPrefixes.map((p) => `  location ^~ /${p}/ {
    proxy_pass http://api:8080;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }`).join("\n\n")}

  # THE SPA FALLBACK. Every screen is a real URL a user can link, bookmark and RELOAD${screenSlugs.length ? ` —\n  # ${screenSlugs.map((s) => "/" + s).join(", ")}` : ""}.
  # Without this they are 404s from nginx and only "/" works, which would make every deep link in the app
  # a broken link and every reload a lost page.
  location / {
    try_files $uri $uri/ /index.html;
  }

  # The built bundle is content-hashed, so it can be cached hard. index.html must never be, or a deploy
  # ships new assets behind a stale document — and nginx adds no cache headers of its own, so leaving
  # index.html out of this block is what keeps it fresh.
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
`);
}

// --- journeys: the one test shape that spans slices --------------------------------------------
//
// Every other test this file writes is a single slice's scenario, and appends its GIVEN straight to the
// stream. That is right for a slice, and it means no generated test has ever driven two commands in a row
// through HTTP — so a slice pair that each pass alone and cannot be COMPOSED has nowhere to be caught.
//
// A journey walks several slices end to end through the real API. It is scaffold(), never emit: the model
// names the sequence and the outcome, and only a human knows what a step's request body should be.
//
// ONE DISCIPLINE MAKES IT WORTH HAVING, and it is the whole reason the file is scaffolded with the rule
// written in it: no step may append an event. The moment a journey test reaches for Given() to set up
// step three, it has become a slice test again and stops catching the thing it exists for. That is
// reported below rather than prevented, because a generator must not edit inside a file somebody owns.
const journeys = ir.journeys ?? [];
for (const j of journeys) {
  const cls = `${pascal(j.name)}JourneyTests`;
  scaffold(join(TESTS, "Journeys", `${cls}.cs`),
    `${banner(`journey "${j.name}" — ${j.slices.length} slices walked end to end`)}
using Alba;
using Marten;
using Microsoft.Extensions.DependencyInjection;
using ${NS}.Contracts;
using Shouldly;
using Xunit;

namespace ${NS}.IntegrationTests.Journeys;

/// <summary>
/// ${(j.label ?? j.name).replace(/\s+/g, " ")}
///
/// Walks: ${j.slices.join(" -> ")}
/// Ends:  ${j.then ?? "(the model states no outcome — journey-needs-then)"}
///
/// THE ONE RULE. Every step goes through the REAL API, in order, and nothing here appends an event. No
/// Given(), no session.Events.Append, no seeding between steps. A slice's GWT is allowed to append its
/// GIVEN because history is exactly what a GIVEN means; a journey may not, because the whole point is
/// whether step two can live on what step one actually left behind.
///
/// WHAT THIS CATCHES that no slice test can: an id minted in one shape and read in another, a projection
/// that is current for its own slice and stale for the next, a rule that only bites on the SECOND command
/// in a sequence. All three pass a green per-slice suite.
///
/// TWO THINGS THAT COST A FAILURE TO LEARN THE FIRST TIME THIS WAS WRITTEN:
///
///   USE THE IDS THE API HANDS BACK, not the ones the test made up. Asserting on your own variable cannot
///   see a slice that echoes something subtly different, and "an id minted in one shape and read in
///   another" is the first failure class on the list above.
///
///   WAIT FOR THE DAEMON IF THE OUTCOME IS AN ASYNC VIEW. WhenPosting wraps each request in Wolverine's
///   ExecuteAndWaitAsync, which blocks until all CASCADING MESSAGE work is done — it knows nothing about
///   Marten's async daemon. An Inline view is assertable immediately; an Async one needs
///   <c>await Store.WaitForNonStaleProjectionDataAsync(timeout)</c> — an extension on the STATIC CLASS
///   <c>Marten.Events.TestingExtensions</c>, so the import is <c>using Marten.Events;</c> and
///   <c>using Marten.Events.TestingExtensions;</c> is CS0138.
///   The tell is a partial result rather than an empty one: the count from step two present, step three's
///   missing. A journey has the longest gap in the suite between the first write and the last assertion,
///   so this bites hardest here and is easiest to misread as a composition bug.
///
/// It is deliberately not exhaustive. One journey per story worth telling — the model names them, and a
/// suite of thirty journeys is a suite nobody will keep working.
/// </summary>
public sealed class ${cls}(AppFixture fixture) : IntegrationContext(fixture)
{
    [Fact]
    public Task ${pascal(j.name)}()
        => throw new NotImplementedException(
            "TODO(codegen): walk ${j.slices.join(" -> ")} with WhenPosting, one step per slice, then assert ${j.then ?? "the journey's outcome"}. " +
            "Use no Given() anywhere — that is what makes this a journey.");
}
`);
}

// A JOURNEY THAT APPENDS ITS OWN HISTORY HAS STOPPED BEING ONE, and it is an easy and tempting edit: step
// four fails, appending the missing event makes it pass, and the test goes on looking like a journey while
// testing one slice. Reported by name.
const cheatingJourneys = [];
for (const j of journeys) {
  const p = join(TESTS, "Journeys", `${pascal(j.name)}JourneyTests.cs`);
  if (!existsSync(p)) continue;
  // STRIP COMMENTS **AND STRING LITERALS** BEFORE MATCHING. The first version stripped only comments and
  // then reported its own freshly written scaffold, because the TODO text says "Use no Given() anywhere".
  // A check that fires on the file the generator just wrote is the cry-wolf failure this file warns about
  // twice already — and it took one run to prove it, which is the argument for running a new report before
  // believing it.
  const src = readFileSync(p, "utf8").split("\n")
    .filter((l) => !/^\s*\/\//.test(l)).join("\n")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/\bGiven\s*\(|Events\.Append\s*\(|StartStream\s*[<(]/.test(src)) cheatingJourneys.push({ p, name: j.name });
}

console.log(`${files.length} file(s) written, ${kept.length} kept (already filled in) -> ${OUT}`);
console.log(`  ${ir.shared.events.length} event records (${owned.length} ours, ${foreign.length} foreign)`);
console.log(`  ${ir.shared.aggregates.filter((a) => a.events.length).length} aggregates, ${ir.shared.views.length} views`);
console.log(`  ${peripheryBySlice.size} validator(s) for periphery rules`);
console.log(`  ${gwtCount} GWT test(s) across ${ir.slices.filter((s) => s.gwts.length).length} slice(s)`);
// An override is a deliberate departure from the kit's enforced stack, so it is REPORTED on every run
// rather than being visible only to whoever opens package-versions.json.
if (Object.keys(OVERRIDES).length) {
  console.log(`  package version override(s) from package-versions.json:`);
  for (const [name, v] of Object.entries(OVERRIDES)) console.log(`    ${name}  ${PACKAGES[name]} -> ${v}`);
}
// REPORT IT ONLY WHEN IT CAN BE ACTED ON. The first version printed NO JOURNEY TESTS unconditionally,
// including for a system with ONE slice — where a journey is not merely unwritten but impossible, because
// journey-too-short is an error. A check that fires when you cannot act on it teaches people to stop
// reading the output, which is the failure this file warns about in three other places and then committed
// itself. Two slices past in-design is the threshold: the same filter the automation wakeup report uses,
// and the point at which "these two cannot be composed" becomes a question worth asking.
const claimed = ir.slices.filter((s) => s.status !== "in-design");
if (journeys.length) {
  console.log(`  ${journeys.length} journey test(s): ${journeys.map((j) => `${j.name} (${j.slices.length} slices)`).join(", ")}`);
} else if (claimed.length >= 2) {
  console.log(`
NO JOURNEY TESTS, and ${claimed.length} slices are claimed. Every test here is a single slice's scenario that
appends its own GIVEN, so nothing drives two commands in a row through the API and "these slices cannot be
composed" has nowhere to be caught. Name the story worth walking — a journey is a domain answer, not a
derivable one:
  node tools/slice.mjs journey <model> --journey <slug> --slices <a,b,c> --then "<View(field=value)>"
Best once two of them are in-review: earlier and it fails on slices nobody has built yet.`);
}

// BP2 — THE DECIDER'S ARM ON A CONTENDED SLICE. Two lines when all is well, and a loud report when it is not.
if (architectFailure) {
  console.log(`
ARCHITECT COULD NOT BE ASKED, so every contention-dependent decision below defaulted to "not contended":
  ${architectFailure}
That is a BROKEN INSTRUMENT, not a clean result — codegen reads architect's answer for which slices are
contended rather than recomputing it (V9), so a failure here silently turns the two-file decider shape off
for the whole project. Fix the invocation before trusting this run:
  node tools/architect.mjs questions ${relative(PROJECT, target).replace(/\\/g, "/") || "diagrams"}`);
} else if (contendedSlices.size) {
  console.log(`  ${contendedSlices.size} slice(s) architect calls contended${
    twoFileWritten.length ? `; ${twoFileWritten.length} decider(s) written OFF the HTTP arm: ${
      twoFileWritten.map((t) => t.slice).join(", ")}` : ""}`);
}
if (httpArmOnContended.length) {
  console.log(`
DECIDER ON THE HTTP ARM FOR A CONTENDED SLICE — ${httpArmOnContended.length}. \`architect\` flagged a rejection
here that depends on state in the stream the command appends to, so two callers at the same instant can both
pass the rule. What refuses the loser is OnException(...).RetryTimes(3) — and that is a MESSAGE-PIPELINE
policy a Wolverine.HTTP endpoint never reaches, so the collision leaves as a bare 500 instead of the rule
name. Measured, 8 writers at one key: through the bus 204x1 + 400x7; inline on HTTP 204x1 + 7 escaped
EventStreamUnexpectedMaxEventIdException. KIT-FINDINGS V7, BP2.
NOTHING WAS WRITTEN, deliberately: the endpoint is a hand-owned scaffold and the pair is a unit, so emitting
only the handler half would leave a discovered message handler nothing invokes. Split it by hand — move the
decision into <Command>Handler.cs returning (<Command>Outcome, Events), and leave a five-line endpoint that
invokes it with bus.InvokeAsync. reference-implementations/state-change/ has both arms side by side:`);
  for (const h of httpArmOnContended) {
    console.log(`  ${h.slice.padEnd(26)} ${h.path.replace(OUT, "").replace(/^[\\/]/, "")}`);
  }
}

// READ ENDPOINTS: what was written, what was already there under another name, and — the one that matters
// — which views deliberately got NO endpoint because the generator could not tell what to read from.
if (readEndpointsWritten.length) {
  console.log(`  ${readEndpointsWritten.length} read endpoint(s) for state-view slices: ${
    readEndpointsWritten.map((r) => `${r.view} -> ${r.route}`).join(", ")}`);
}
// "already served", NOT "hand-written": after the first pass these include the scaffolds this generator
// wrote itself, and calling those hand-written is a false statement in a report — which is the one thing a
// report may not be.
if (readEndpointsFound.length) {
  console.log(`  ${readEndpointsFound.length} view(s) already served by an existing endpoint: ${
    readEndpointsFound.map((r) => `${r.view} (${r.path.replace(OUT, "").replace(/^[\\/]/, "")})`).join(", ")}`);
}
if (readEndpointsSkipped.length) {
  console.log(`
NO READ ENDPOINT GENERATED — ${readEndpointsSkipped.length}. A state-view slice's contract IS its read
model, and these views got no endpoint ON PURPOSE: the generator knows two of Marten's six recipes, and for
these it cannot tell what a caller would read from. A generated Query<T>() here would COMPILE and return an
empty list for ever, which is worse than nothing — so the gap is named instead, the way a projection with no
derivable identity= is stamped GUESSED rather than silently grouping the wrong rows.
Write it by hand in Views/, or say why there is none:`);
  for (const r of readEndpointsSkipped) console.log(`  ${r.view.padEnd(26)} ${r.why}`);
}

// TWO LABELS, ONE C# IDENTIFIER — KIT-FINDINGS Z5.
//
// `Stock Level Set` and `StockLevelSet` are two cells on the model and one type name in the output, so the
// second file written silently overwrote the first — and because `scaffold()` reports a file that already
// exists as `kept`, the run counted the casualty as healthy work. **The report actively lied**, which is
// worse than the collision: `N written, M kept` looked right, the build then failed somewhere unrelated,
// and nothing pointed at two model cells.
//
// Reported rather than renamed. Which of the two labels is wrong is a domain question — they may be two
// genuine concepts that need distinguishing on the model, or one concept drawn twice — and a generator
// that picked would be inventing a domain fact.
const identifierCollisions = (() => {
  const out = [];
  const groups = [
    ["event", ir.shared.events.map((e) => e.label)],
    ["view", ir.shared.views.map((v) => v.label)],
    ["aggregate", ir.shared.aggregates.map((a) => a.name)],
    ["command", ir.shared.aggregates.flatMap((a) => a.commands.map((c) => c.label))],
  ];
  for (const [kind, labels] of groups) {
    const byIdentifier = new Map();
    for (const label of [...new Set(labels)]) {
      const id = pascal(label);
      if (!byIdentifier.has(id)) byIdentifier.set(id, []);
      byIdentifier.get(id).push(label);
    }
    for (const [id, labels2] of byIdentifier) {
      if (labels2.length > 1) out.push({ kind, id, labels: labels2 });
    }
  }
  return out;
})();

if (identifierCollisions.length) {
  console.log(`
TWO LABELS, ONE IDENTIFIER — ${identifierCollisions.length}. These cells have different labels on the model
and produce the SAME C# type name, so one generated file overwrites the other — and the overwritten one is
then reported as \`kept\`, which makes the run look healthier than it is. Rename one on the MODEL: which of
them is wrong is a domain question, and a generator that chose would be inventing a fact. KIT-FINDINGS Z5:`);
  for (const c of identifierCollisions) {
    console.log(`  ${c.kind.padEnd(10)} ${c.labels.map((l) => `"${l}"`).join(" and ")} both become ${c.id}`);
  }
}

// CREATING SLICES — BT6. Three outcomes, and only the first is silent-by-success.
if (createStreamWritten.length) {
  console.log(`  ${createStreamWritten.length} slice(s) CREATE their stream, scaffolded with MartenOps.StartStream: ${
    createStreamWritten.map((r) => `${r.slice} (mints ${r.idField})`).join(", ")}`);
}
if (idGenerationUndecided.length) {
  console.log(`
ID GENERATION NOT DECIDED — ${idGenerationUndecided.length}. These slices MINT their own stream key, and the
generator could not derive the whole recipe. A Guid key on a Guid-identity store is fully derivable —
Guid.CreateVersion7(), the non-obsolete form of Marten's own sequential-Guid advice. Anything else needs an
id FORMAT and a collision rule, and both are domain decisions. The scaffold names the gap rather than
inventing a format, the way a view whose recipe cannot be read off the tree gets no read endpoint.
Answer it in ARCHITECTURE.md under id-generation/<slice>:`);
  for (const r of idGenerationUndecided) console.log(`  ${r.slice.padEnd(26)} ${r.cmd} mints ${r.keys} — ${r.why}`);
}
if (streamFromMintedMember.length) {
  console.log(`
STREAM RESOLVED FROM A terminal=generated MEMBER — ${streamFromMintedMember.length}. THIS IS WRONG OUTPUT
THAT PASSES EVERY CHECK. These endpoints hand [WriteAggregate] a stream key assembled from a value the model
says the HANDLER mints, so the caller never sends it, so the key is default on every request and every
record lands in ONE stream. Build clean, host starts, 204 returned, and the first test passes because one
record in one stream reads back correctly — it only bites on the second. KIT-FINDINGS BT6.
These files are hand-owned, so this generator will not touch them. Rewrite each to mint the id and call
MartenOps.StartStream — a freshly generated slice now shows the shape:`);
  for (const r of streamFromMintedMember) {
    console.log(`  ${r.slice.padEnd(26)} ${r.cmd}.StreamKey reads ${r.keys}, which is terminal="…:generated"`);
    console.log(`  ${"".padEnd(26)} ${r.path.replace(OUT, "").replace(/^[\\/]/, "")}`);
  }
}

// ARCHITECTURE DECISIONS: the choices the model deliberately leaves open, and which get made by ACCIDENT
// if nobody makes them on purpose. Reported here rather than enforced, in this file's house style — but
// reported loudly, because the default this generator picks (Inline on every read model) is one of the
// three options the books offer and Marten's own default for a multi-stream projection is a different one.
// A generated slice built on an unmade decision compiles, passes and can still be wrong.
if (claimed.length) {
  const rec = join(PROJECT, "ARCHITECTURE.md");
  // Shell out rather than duplicate the derivation: architect.mjs owns those six question families, and a
  // second copy here would drift the first time one of them changed. Failure is non-fatal — a missing
  // report must never break a generation run.
  let r = null;
  let checkFailure = null;
  try {
    // `target` IS PASSED, and its absence was a silent failure for six of the eight projects in this repo.
    // A reference implementation keeps its model in `<folder>/<model-name>/`, architect used to hard-code
    // `<project>/diagrams`, and this catch swallowed the resulting exit-1 — so ARCHITECTURE DECISIONS MISSING
    // could never fire there. The catch stays (a missing report must never break a run) but it no longer
    // hides a wiring bug.
    r = execFileSync(process.execPath,
      [fileURLToPath(new URL("architect.mjs", import.meta.url)), "check", target, ...pass],
      { encoding: "utf8", maxBuffer: 1 << 24 });
  } catch (e) {
    // NAMED, not swallowed. This is the exact site that hid the architect wiring bug for six of the eight
    // projects in this repo, and the reason it hid is that the catch was empty — so a `check` that could
    // not run and a `check` that found nothing produced identical output. The catch stays, because a
    // missing report must never break a generation run; what changes is that it says so.
    //
    // ONLY WHEN THE OTHER CALL SITE SUCCEEDED. `questions` runs earlier against the same tool and the same
    // target, so if that failed the reader already has `ARCHITECT COULD NOT BE ASKED` with the reason and a
    // second copy is noise. A failure HERE with a success THERE is strictly a bug in this call.
    if (!architectFailure) {
      checkFailure = (e.stderr || e.message || String(e)).toString().trim().split("\n")[0];
    }
  }
  if (checkFailure) {
    console.log(`
ARCHITECT CHECK COULD NOT RUN, so "every decision is answered and current" is UNVERIFIED for this run —
not confirmed. \`questions\` ran fine against the same model, so this is a bug in how codegen invokes
\`check\`, not a missing record:
  ${checkFailure}
  node tools/architect.mjs check ${relative(PROJECT, target).replace(/\\/g, "/") || "diagrams"}`);
  }
  // THE ACKNOWLEDGED CASE IS A NOTE, and architect is the one that decides it — this reads `check`'s answer
  // rather than looking for the fenced block itself, so there is one definition of "acknowledged" and not
  // two that can drift (V9's lesson, applied to a much smaller thing).
  if (r && /RECORD DELIBERATELY ELSEWHERE/.test(r)) {
    console.log(`  architecture decisions recorded outside ARCHITECTURE.md — acknowledged, see README.md`);
  } else if (!existsSync(rec)) {
    console.log(`
NO ARCHITECTURE RECORD, and ${claimed.length} slice(s) are claimed. The model leaves the concurrency and
consistency choices open on purpose — they are technical, so they are not on a cell — but "open" becomes
"whatever the generator picked" the moment a slice is built:
  node tools/architect.mjs questions`);
  } else if (r && /DECISION STILL TODO|QUESTION WITH NO SECTION|ANSWER TO A QUESTION NOBODY ASKS/.test(r)) {
    // THE COUNTS COME FROM ARCHITECT'S OWN SUMMARY LINE, not from counting lines of its prose.
    //
    // This report used to grep `check`'s stdout for `/^\s{2}\S/` containing a slash and print the first SIX.
    // It was wrong twice over, and the second way is the worse one:
    //
    //   1. A SILENT CAP. On Voltway it showed 6 where the record does not mention 51 — so a reader trusting
    //      the summary was told the record was nearly complete. CLAUDE.md's own rule is "no silent caps: if a
    //      workflow bounds coverage, log what was dropped".
    //   2. A CAP ON THE WRONG SET. That filter matches **85 lines** on Voltway, because it sweeps up both
    //      `QUESTION WITH NO SECTION` (51 — the model asks, the record is silent) and
    //      `ANSWER TO A QUESTION NOBODY ASKS` (32 — an orphaned decision, the opposite problem) and prints
    //      them under one heading claiming the record "does not answer everything the model asks". Six of
    //      eighty-five, of two different findings, under one wrong label.
    //
    // So: read the numbers architect computed. One computation, one caller — V9's lesson at small scale.
    const num = (re) => { const m = re.exec(r); return m ? Number(m[1]) : null; };
    const total = num(/(\d+) question\(s\) from the model/);
    const unanswered = num(/(\d+) not in the record/);
    const todo = num(/(\d+) still TODO/);
    const orphaned = num(/ANSWER TO A QUESTION NOBODY ASKS — (\d+)/);
    // The ids under the one heading that means "the model asks and the record is silent", and nothing else.
    const missingIds = (/QUESTION WITH NO SECTION[\s\S]*?\n((?:  \S[^\n]*\n(?:    [^\n]*\n)?)+)/.exec(r)?.[1] ?? "")
      .split("\n").map((l) => l.trim()).filter((l) => l && l.includes("/") && !l.startsWith("fix:"));
    const SHOW = 6;
    console.log(`
ARCHITECTURE DECISIONS MISSING. ARCHITECTURE.md exists and ${
      unanswered === null ? "does not answer everything the model asks" :
      `is silent on ${unanswered} of the ${total} question(s) the model asks`}${
      todo ? `; ${todo} more are still TODO` : ""}${
      orphaned ? `. Separately, ${orphaned} recorded answer(s) point at question ids that no longer exist —
a DIFFERENT finding, and \`architect check\` names each with its nearest current id` : ""}.`);
    if (missingIds.length) {
      for (const id of missingIds.slice(0, SHOW)) console.log(`  ${id}`);
      // NO SILENT CAP. Say what was dropped, in the same breath as what was shown.
      if (missingIds.length > SHOW) {
        console.log(`  … and ${missingIds.length - SHOW} more NOT shown here. This list is a sample; the count above is the finding.`);
      }
    }
    console.log(`  node tools/architect.mjs check${
      relative(PROJECT, target).replace(/\\/g, "/") && relative(PROJECT, target) !== "diagrams"
        ? " " + relative(PROJECT, target).replace(/\\/g, "/") : ""}`);
  }
}

// THE SAME PROMPT IN FRONT OF THE API, and gated on SCREENS rather than on slices — a UI journey over
// slices with no screen is not unwritten, it is impossible, which is the same reasoning that keeps the
// report above quiet below two claimed slices. It is a prompt and not a queue: `ui-journey` starts
// containers and drives a browser, so it runs only when a human asks for it.
const claimedWithScreens = claimed.filter((s) => s.screen);
if (claimedWithScreens.length >= 2) {
  const specs = join(OUT, "web", "journeys");
  const written = existsSync(specs) &&
    readdirSync(specs).some((f) => f.endsWith(".journey.spec.ts"));
  if (!written) {
    console.log(`
NO UI JOURNEY, and ${claimedWithScreens.length} claimed slices have screens (${claimedWithScreens.map((s) => s.screen).join(", ")}).
Every check on those screens looks at ONE SCREEN AT REST — the field check, design check and review sheet
all do — so nothing proves you can get from the list to the modal to the created thing. The pager bug (/ and
/?page=2 rendering identically, past 32 green tests) is what that hole looks like:
  node tools/uijourney.mjs plan
Ask the human first — a browser walk starts containers and costs minutes, and nothing gates on one.`);
  }
}
if (cheatingJourneys.length) {
  console.log(`\nJOURNEY APPENDS ITS OWN HISTORY — ${cheatingJourneys.length}. A journey that calls Given(),
appends events or starts a stream has stopped being a journey: it is a slice test with more steps, and it
no longer tells you whether step two can live on what step one left behind. Drive every step through the
API instead.`);
  for (const c of cheatingJourneys) console.log(`  ${c.name}: ${c.p.replace(OUT + "\\", "").replace(OUT + "/", "")}`);
}

// UNBOUND TYPE. The model is stack-agnostic on purpose, so a domain type is not a C# type until the
// architect step says what it is. Anything with no binding is emitted verbatim and will reach the compiler
// as CS0246 with nothing naming the cause — which is exactly how the kit's own fixture came to generate 68
// errors. Name it here, before the build.
const unboundTypes = distinctTypes([
  ...(ir.shared?.events ?? []), ...(ir.shared?.views ?? []), ...(ir.shared?.aggregates ?? []),
  ...(ir.slices ?? []).flatMap((s) => s.elements ?? []),
]).filter((r) => !CS[r.type] && !/^(string|int|long|bool|decimal|double|float|Guid|DateOnly|DateTime|DateTimeOffset|object|byte|short|char|TimeSpan|TimeOnly)$/.test(r.type));

if (unboundTypes.length) {
  console.log(`\nUNBOUND TYPE — ${unboundTypes.length}. The model is stack-agnostic, so a domain type is not a C# type`);
  console.log(`until ARCHITECTURE.md says which one it is. These have no binding and are being emitted VERBATIM,`);
  console.log(`so the compiler will reject them with no explanation of where they came from:`);
  for (const u of unboundTypes) console.log(`  ${u.type}   first used by ${u.usedAt}`);
  console.log(`  fix: node tools/architect.mjs record   (it proposes a binding for each and records the cost)`);
}

if (unregisteredViews.length) {
  console.log(`\nVIEW WITH NO REGISTRATION — ${unregisteredViews.length}. The projection class exists and NOTHING RUNS IT.`);
  console.log(`ViewRegistrations.cs is a scaffold, so a view added to the model after it was written gets no`);
  console.log(`line in Register(). There is no symptom: the build is clean, startup is clean, no table is`);
  console.log(`created, and a load just returns null. Add each by hand, next to the ones already there:`);
  for (const u of unregisteredViews) {
    console.log(`  ${u.view}   ->   opts.Projections.Add<${pascal(u.view)}Projection>(ProjectionLifecycle.Inline);`);
  }
  console.log(`  in ${unregisteredViews[0].path.replace(OUT, "").replace(/^[\\/]/, "")}`);
}

if (doneButUnclaimed.length) {
  console.log(`\nIMPLEMENTED BUT STILL UNCLAIMED — ${doneButUnclaimed.length}. Every test body is filled in and every`);
  console.log(`one of them is SKIPPED, because status= says nobody has claimed the slice. The work is done and the`);
  console.log(`skip count is over-reporting what is left. Promote the slice in the model, then delete the Skip:`);
  for (const t of doneButUnclaimed) {
    console.log(`  slice "${t.slice}" is ${t.status} — ${t.tests} test(s) written and dark`);
  }
}

if (staleSkips.length) {
  console.log(`\nTESTS STILL SKIPPED ON A CLAIMED SLICE — ${staleSkips.length}. status= is past in-design, but the`);
  console.log(`test file was scaffolded while it was NOT, and [Fact(Skip = ...)] is baked in. The file is`);
  console.log(`hand-owned now, so this cannot be repaired for you — and until it is, "the slice's tests are`);
  console.log(`live, not skipped" reads as Skipped rather than Passed. Delete the Skip argument in:`);
  for (const t of staleSkips) {
    console.log(`  ${t.path.replace(OUT, "").replace(/^[\\/]/, "")}   (slice "${t.slice}" is ${t.status})`);
  }
}

if (untested.length) {
  console.log(`\nGWT WITHOUT A TEST — ${untested.length}. These rules are in the model and in no test file,`);
  console.log(`because the test file was scaffolded before the GWT was added and is now hand-owned.`);
  console.log(`A green run does NOT cover them. Add each by hand, next to the tests already there:`);
  let last = null;
  for (const u of untested) {
    if (u.path !== last) { console.log(`  ${u.path.replace(OUT, "").replace(/^[\\/]/, "")}`); last = u.path; }
    console.log(`    - ${u.rule}`);
  }
}

if (ambiguous.length) {
  console.log(`\nGWT COVERAGE CANNOT BE TOLD APART — ${ambiguous.length}. These rules are named by more`);
  console.log(`than one GWT, so finding the NAME in the test file does not prove THIS scenario is covered.`);
  console.log(`Two GWTs sharing a rule name is legitimate — the same refusal reached by two histories — so`);
  console.log(`this is not a modelling error. It is the coverage check saying it cannot answer.`);
  console.log(`Quote the id in the test's comment (newly scaffolded tests already carry it):`);
  let last = null;
  for (const a of ambiguous) {
    if (a.path !== last) { console.log(`  ${a.path.replace(OUT, "").replace(/^[\\/]/, "")}`); last = a.path; }
    console.log(`    - ${a.id}  (one of ${a.n} GWTs named ${a.rule})`);
  }
}

if (unwoken.length) {
  console.log(`\nAUTOMATION NOT WOKEN — ${unwoken.length}. Nothing runs these slices, and their tests still pass,`);
  console.log(`because a test drives the trigger directly. Choose a mechanism — the decision table is in the`);
  console.log(`file, and worked implementations are in reference-implementations/automation/:`);
  for (const u of unwoken)
    console.log(`  ${u.slice}: ${u.path.replace(OUT, "").replace(/^[\\/]/, "")}`);
}

// "already translated", NOT "hand-written" — the same wording care as the read endpoints: after the first
// pass these include the seam this generator wrote itself and somebody then filled in.
if (ingestsFound.length) {
  console.log(`  ${ingestsFound.length} foreign event(s) already translated by an existing handler: ${
    ingestsFound.map((r) => `${r.event} (${r.path.replace(OUT, "").replace(/^[\\/]/, "")})`).join(", ")}`);
}

if (unIngested.length) {
  console.log(`\nINGEST NOT WIRED — ${unIngested.length}. These foreign events have a seam and no translation in it,`);
  console.log(`so nothing in the application turns one into anything of ours. The same shape of hole as an`);
  console.log(`automation nothing wakes: every test passes, because a test hands the notice to the handler itself.`);
  for (const u of unIngested)
    console.log(`  ${u.event}: ${u.path.replace(OUT, "").replace(/^[\\/]/, "")}`);
  console.log(`AND THE SEAM EXISTING IS NOT THE WHOLE PATH. The transport in front of the durable queue — a`);
  console.log(`webhook, a table they INSERT into, a broker, a poll — is hand-owned and generated nowhere. A feed`);
  console.log(`wired to nothing at all still leaves the suite green: only running it proves an arrival happens.`);
}

// ROUTE NOT PROXIED. The nginx prefixes above are DERIVED from the model's contexts, because that is the
// route convention this generator emits — but an endpoint is scaffold, so a hand edit is free to move a
// route somewhere else entirely, and every reference implementation's endpoints have done exactly that
// (`/emails`, `/projects/{projectId}/commit`). Behind nginx an unproxied route reaches the SPA fallback and
// the fetch gets index.html with a 200, which parses as neither JSON nor an error: an empty screen. So the
// derivation is checked against the routes actually in the tree rather than trusted.
if (hasWeb) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!["Internal", "obj", "bin"].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith(".cs")) continue;
      const txt = readFileSync(p, "utf8");
      // A regex LITERAL, never a string: in a string "\s" is the letter s and "\b" is a backspace, and
      // the miss is silent — the standing trap in CLAUDE.md, and it has been made three times here.
      for (const m of txt.matchAll(/(?:\[Wolverine(?:Get|Post|Put|Delete)\(|Route\s*=\s*)"(\/[^"{]*)/g))
        found.push({ p, route: m[1] });
    }
  };
  if (existsSync(APP)) walk(APP);
  const seen = new Set();
  const unproxied = found.filter(({ route }) => {
    const seg = route.split("/")[1] ?? "";
    if (!seg || apiPrefixes.includes(seg) || seen.has(seg)) return false;
    seen.add(seg);
    return true;
  });
  if (unproxied.length) {
    console.log(`\nROUTE NOT PROXIED — ${unproxied.length}. web/nginx.conf proxies ${apiPrefixes.map((p) => "/" + p + "/").join(", ")} — the model's`);
    console.log(`contexts, which is the convention codegen emits routes on. These routes are in the tree and start`);
    console.log(`somewhere else, so behind nginx they hit the SPA FALLBACK and the fetch gets index.html with a 200:`);
    console.log(`not JSON, not an error, just an empty screen. Move the route onto its context's prefix, or add the`);
    console.log(`prefix in ${OUT_REL}/docker-compose.override.yml's own nginx — this file is emit:`);
    for (const u of unproxied)
      console.log(`  ${u.route}   ${u.p.replace(OUT, "").replace(/^[\\/]/, "")}`);
  }
}

console.log(`\nNOTE: Testcontainers is not in reference/llms/ — that harness is the one part written`);
console.log(`      from unverifiable knowledge. Everything else cites a mirrored page.`);
