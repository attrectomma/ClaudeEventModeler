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

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
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
  "Testcontainers.PostgreSql": "4.*",
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

const write = (p, body) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body.replace(/\n{3,}/g, "\n\n"), "utf8"); };
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

// The fixed values a GIVEN needs to name things. Derived, because hard-coding them leaked one retired
// domain's vocabulary — EmployeeId, ProjectId, Month, WorkingDay — into every project the generator has
// ever produced, where those names mean nothing.
//
// Every name in a swimlane's identity= is a stream key, so it is exactly what a test must be able to
// refer to. Types come from the events that carry the field.
// WHETHER ONE ROW IS ONE STREAM. Factored out because the lifecycle below and the projection base class
// further down must agree: a view registered Async while declared SingleStreamProjection is a different
// bug from the two disagreeing, and one copy of this rule is the only way to be sure they cannot.
const isMultiStream = (v) => {
  const streams = [...new Set(v.from.map((l) => ir.shared.events.find((e) => e.label === l)?.aggregate).filter(Boolean))];
  const streamKey = streams.length === 1
    ? (ir.shared.aggregates.find((a) => a.name === streams[0])?.identity ?? [])
    : [];
  const declared = v.identity?.length ? v.identity : null;
  const rowIsStream = streams.length === 1 && (
    declared === null ||
    (streamKey.length === declared.length && streamKey.every((k) => declared.includes(k))));
  return !rowIsStream;
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
    if (t === "Guid") return `    public static readonly Guid ${N} = Guid.Parse("${hex(i + 1)}");`;
    if (t === "DateOnly") return `    public static readonly DateOnly ${N} = new(2026, 1, ${(i % 28) + 1});`;
    if (t === "DateTimeOffset") return `    public static readonly DateTimeOffset ${N} = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);`;
    if (t === "int" || t === "long") return `    public const ${t} ${N} = ${i + 1};`;
    if (t === "decimal") return `    public const decimal ${N} = ${i + 1}m;`;
    if (t === "bool") return `    public const bool ${N} = true;`;
    return `    public const string ${N} = "${k}-1";`;
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
const checkGwtCoverage = (p, gwts) => {
  if (!existsSync(p)) return;
  const src = readFileSync(p, "utf8");
  for (const g of gwts) if (!src.includes(g.rule)) untested.push({ path: p, rule: g.rule });
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
    const owner = ir.slices.find((x) => x.generates && x.commands.length
      && ir.shared.aggregates.find((g) => g.commands.some((c) => c.label === x.commands[0]))?.name === a.name);
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
${fields.some((f) => f.nullable) ? `// A nullable field means a '?' annotation, and the BANNER above makes this file auto-generated in the
// compiler's eyes — so CS8669 says an explicit directive is required even though the csproj already sets
// <Nullable>enable</Nullable>. Emitted only when a field actually needs it, because an unconditional
// directive on 40 files that do not is noise.
#nullable enable

` : ""}namespace ${NS}.Slices.${pascal(s.context)};

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
for (const s of ir.slices) {
  if (!s.generates || !s.commands.length) continue;
  const cmd = s.commands[0];
  const agg = ir.shared.aggregates.find((a) => a.commands.some((c) => c.label === cmd));
  const fields = agg?.commands.find((c) => c.label === cmd)?.fields ?? [];
  const carriesKey = (agg?.identity ?? []).length && agg.identity.every((k) => fields.some((f) => f.name === k));
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

  scaffold(join(APP, "Slices", pascal(s.context), pascal(s.name), `${pascal(cmd)}${http ? "Endpoint" : "Handler"}.cs`),
    `${banner(`${s.name} — the decider. Scaffolded once, then hand-owned.`)}
#nullable enable

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
/// ${isClaimed(s) ? "LIVE: this slice is claimed, so every test here must pass." : "SKIPPED: promote the slice past in-design to turn these on."}
/// ${s.owners.length > 1 ? `This slice needs ${s.owners.join(" and ")}, so these are the contract between them.` : `Owned by ${s.owner ?? "nobody in particular"}.`}
/// </summary>
public sealed class ${pascal(s.name)}Tests(AppFixture fixture) : IntegrationContext(fixture)
{
${s.gwts.map((g, i) => {
      const thens = (g.then ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const err = thens.find((t) => /^error:/i.test(t));
      // No when= means this is a GT, not a GWT — a read model reads events that already exist, so there
      // is no command to be the WHEN. Printing "WHEN (nothing)" invited the reader to think one was
      // missing; omitting the line says what the book says.
      return `    // ${(g.rule || g.label || g.id).replace(/\s+/g, " ")}
    //   GIVEN ${g.given || "(nothing)"}${g.when ? `\n    //   WHEN  ${g.when}` : ""}
    //   THEN  ${g.then || "(nothing)"}${g.when ? "" : gtHint(s)}${isPeriphery(g) && g.when ? "\n    //   No GIVEN, so this is a periphery rule: expect 400 from the validator." : ""}
    ${factAttr(s)}
    public Task ${testName(g, i)}()
        => throw new NotImplementedException(
            "TODO(codegen): ${err ? `expect a 400/ProblemDetails for ${ruleName(g)}` : `expect ${thens.join(", ") || "the modelled outcome"}`}. " +
            "Stream key: ${key.replace(/"/g, "'")}. Fixed values for every stream key are on SeedData: ${
      [...new Set(ir.shared.aggregates.flatMap((a) => a.identity ?? []))].map((k) => `SeedData.${pascal(k)}`).join(", ") || "none — no band declares identity="
    }.");`;
    }).join("\n\n")}
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
    if (!ingestsByEvent.has(label)) ingestsByEvent.set(label, []);
    ingestsByEvent.get(label).push(s);
  }
}

const unIngested = [];
const checkIngestWired = (p, event) => {
  if (!existsSync(p)) return;                       // not scaffolded yet; this run will write it
  if (readFileSync(p, "utf8").includes("TODO(codegen): translate"))
    unIngested.push({ path: p, event });
};

for (const [label, slices] of ingestsByEvent) {
  const e = foreignLabels.get(label);
  const cls = `Ingest${pascal(label)}Handler`;
  const p = join(APP, "Landing", `${cls}.cs`);
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
/// persisted on arrival, retried if this throws, and dead-lettered if it keeps throwing. That is the
/// durable record of what they told us, and it is why nothing here has to write durability code.
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

emit(join(APP, "Program.cs"),
  `${banner("application bootstrapping")}
using JasperFx;
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
using Wolverine.Marten;
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
    opts.OnException<ConcurrencyException>().RetryTimes(3);
    opts.OnException<EventStreamUnexpectedMaxEventIdException>().RetryTimes(3);
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
  try {
    r = execFileSync(process.execPath,
      [fileURLToPath(new URL("architect.mjs", import.meta.url)), "check", ...pass],
      { encoding: "utf8", maxBuffer: 1 << 24 });
  } catch { /* no project, no models, or no record — the branches below cover it */ }
  if (!existsSync(rec)) {
    console.log(`
NO ARCHITECTURE RECORD, and ${claimed.length} slice(s) are claimed. The model leaves the concurrency and
consistency choices open on purpose — they are technical, so they are not on a cell — but "open" becomes
"whatever the generator picked" the moment a slice is built:
  node tools/architect.mjs questions`);
  } else if (r && /DECISION STILL TODO|QUESTION WITH NO SECTION/.test(r)) {
    console.log(`
ARCHITECTURE DECISIONS MISSING. ARCHITECTURE.md exists but does not answer everything the model asks:
${r.split("\n").filter((l) => /^\s{2}\S/.test(l) && l.includes("/")).slice(0, 6).map((l) => "  " + l.trim()).join("\n")}
  node tools/architect.mjs check`);
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

if (unwoken.length) {
  console.log(`\nAUTOMATION NOT WOKEN — ${unwoken.length}. Nothing runs these slices, and their tests still pass,`);
  console.log(`because a test drives the trigger directly. Choose a mechanism — the decision table is in the`);
  console.log(`file, and worked implementations are in reference-implementations/automation/:`);
  for (const u of unwoken)
    console.log(`  ${u.slice}: ${u.path.replace(OUT, "").replace(/^[\\/]/, "")}`);
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

console.log(`\nNOTE: Testcontainers is not in reference/llms/ — that harness is the one part written`);
console.log(`      from unverifiable knowledge. Everything else cites a mirrored page.`);
