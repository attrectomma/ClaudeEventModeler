#!/usr/bin/env node
// The architect step: the questions the model IMPLIES and cannot answer.
//
//   node tools/architect.mjs questions [--json]
//   node tools/architect.mjs record
//   node tools/architect.mjs check
//
// WHY THIS EXISTS, AND WHY IT IS NOT A MODEL RULE.
//
// An event model's whole responsibility is domain knowledge and how information flows. Concurrency,
// optimistic locking, projection consistency mode and snapshots are TECHNICAL concerns, and both books say
// so outright — Understanding EventSourcing, on snapshots: "Snapshots are a pure technical tool and are
// neither modeled nor mentioned in an Event Model typically." The little book files its Live-Model vs
// Database-Projection trade-off under "Implementation Hints".
//
// So none of this becomes notation. Nothing here changes the grammar, and nothing here writes to a .drawio.
// The kit already made the opposite mistake once and recorded it as finding T0: an implementation concern
// climbed into the domain model as a business rule, validated, generated a test, and passed.
//
// What the model DOES carry is the boundary — `identity=` on a swimlane is the stream key, and both books
// say the aggregate IS the transactional consistency boundary. Once that is right, concurrency stops being a
// design question and becomes a stack question: "we apply optimistic locking not on the entire Event Store,
// but on individual event streams" (ch. 4). The gap is that nothing reads the model and ASKS.
//
// This file asks. It derives six families of question, all mechanically, and answers none of them — the
// `architect` skill does that against reference/llms/ and writes the decisions into the project. Same split
// as slice.mjs/add-slice and uijourney.mjs/ui-journey: the script owns what is derivable, the skill owns
// judgement.
//
// WHY A STEP BEFORE CODEGEN RATHER THAN PART OF IT. codegen is per-slice by design. These decisions are
// SYSTEM-scoped and have to be made before the first slice: otherwise slice 1 picks Inline, slice 4 needs
// Async, and the two conflict after both are green. Same reasoning that keeps `journey` out of codegen.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { projectRoot, projectName } from "./project.mjs";
import { distinctTypes, renderBindings } from "./type-bindings.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const has = (n) => args.includes(`--${n}`);

if (!cmd || !["questions", "record", "check", "tests"].includes(cmd)) {
  console.error("usage:\n" +
    "  node tools/architect.mjs questions [--json]   what the model implies and cannot answer\n" +
    "  node tools/architect.mjs record               scaffold <project>/ARCHITECTURE.md, one section per question\n" +
    "  node tools/architect.mjs tests                scaffold a RACE test per contended invariant\n" +
    "  node tools/architect.mjs check                unanswered questions, and answers that have gone stale\n\n" +
    "  It never edits a .drawio. Concurrency is not a modelling concern and gets no notation.");
  process.exit(2);
}

const PROJ = projectRoot(args);
const rel = (p) => relative(PROJ, p).replace(/\\/g, "/");
const RECORD = join(PROJ, "ARCHITECTURE.md");

// generated/ IS NAMED AFTER THE SYSTEM, NOT THE PROJECT FOLDER, and the two differ in practice — project
// CPOC01, system RecipeBox. The system name is a domain fact on the model cell's system=, exactly as
// codegen.mjs reads it. Set when the models are compiled, because that is the only place it is known.
let SYSTEM = projectName(args);

// CODEGEN'S EXACT pascal(), copied rather than approximated. A scaffolded race test names types that
// codegen generated — the aggregate, the event — so a different casing rule here produces a file that
// references a type nobody emitted, and the failure is a compile error in somebody else's file.
const pascal = (s) => s.replace(/(^|[^a-zA-Z0-9])([a-z])/g, (_, a, b) => b.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");

// The same emit/scaffold split codegen.mjs uses: anything mechanically determined is OVERWRITTEN, anything
// carrying judgement is KEPT once it exists. A race test is judgement from its second line on.
const written = [], keptFiles = [];
function emit(p, body) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body, "utf8"); written.push(p); }
function scaffoldFile(p, body) {
  if (existsSync(p)) { keptFiles.push(p); return; }
  mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body, "utf8"); written.push(p);
}

// --- the model, read by the one parser that owns it ------------------------------------------------

function models() {
  const dir = join(PROJ, "diagrams");
  if (!existsSync(dir)) { console.error(`${rel(dir)} does not exist.`); process.exit(1); }
  const files = readdirSync(dir).filter((f) => f.endsWith(".drawio") && !f.startsWith("_"));
  if (!files.length) { console.error(`no models in ${rel(dir)}. Nothing to reason about yet.`); process.exit(1); }
  const mp = new URL("model.mjs", import.meta.url).pathname.replace(/^\//, "");
  return files.map((f) => {
    const r = spawnSync(process.execPath, [mp, "compile", join(dir, f)], { encoding: "utf8", maxBuffer: 1 << 26 });
    if (r.status !== 0) { console.error(`compile failed for ${f}:\n${r.stderr}`); process.exit(1); }
    return { file: f, ir: JSON.parse(r.stdout) };
  });
}

// Set SYSTEM from the model cell, and cache the compiled models so derive() and tests do not each shell out.
let _models = null;
function compiled() {
  if (_models) return _models;
  _models = models();
  // pascal() IT, because codegen writes generated/<pascal(system)> and namespaces the assembly the same.
  // A model cell saying system="campaigns" put these tests in generated/campaigns — OUTSIDE the csproj, so
  // they would never have compiled or run, silently.
  SYSTEM = pascal(_models.map((m) => m.ir.model?.system).find(Boolean) ?? SYSTEM);
  return _models;
}

// A period-shaped key is how a business closes the books, and the book prefers it to a snapshot outright:
// "better to limit the length of a stream naturally by understanding the business processes" — banks after a
// day, the stock market after a trading day. A HEURISTIC and labelled as one: it reads a name and a type.
const TEMPORAL = /(date|day|week|month|quarter|year|period|term|season)$/i;
const isTemporal = (f) => TEMPORAL.test(f.name) || /^Date(Only|Time)|^DateTimeOffset$/.test(f.type ?? "");

// A SWIMLANE's identity= is already an array in the per-model IR; an ELEMENT's is still the raw attribute
// string. Iterating the string instead of splitting it asks about the letters of the key — the first run of
// this file produced `view-identity/CampaignDashboard/a` for a view keyed on `campaignId`.
const keyOf = (el) => (el.identity ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// --- derive ---------------------------------------------------------------------------------------

function derive() {
  const qs = [];
  for (const { file, ir } of compiled()) {
    const byId = new Map(ir.elements.map((e) => [e.id, e]));
    // A label map for resolving a GWT's given= steps. Last-wins is fine and deliberate: a repeated event
    // label is the same event type, and all we read off it here is its aggregate.
    const byLabel = new Map();
    for (const e of ir.elements) if (!byLabel.has(e.label)) byLabel.set(e.label, e);
    const el = (id) => byId.get(id);
    const ctx = ir.model?.context ?? file.replace(/\.drawio$/, "");

    const laneOfAggregate = new Map();
    for (const l of ir.swimlanes) for (const s of l.streams) laneOfAggregate.set(s, l);

    const commandSlices = ir.slices.filter((s) => s.commands.length);
    const writersOf = (agg) => commandSlices.filter((s) =>
      s.events.map(el).some((e) => e?.kind === "event" && e.aggregate === agg));

    // ---- W1: the boundary map — ONE question per model, not one per stream ------------------------
    //
    // The stream key is the most consequential and least reversible decision in the model, so it has to be
    // stated. But asking it per stream produced boilerplate: the first run of this file emitted a
    // near-identical section for every band, and two of the six questions on a nine-slice model were
    // "is one campaign the right scope for one campaign". A check that fires where you cannot act on it
    // teaches people to stop reading the output, which this kit has now learned three separate times.
    //
    // So: one map of every boundary, with the writers and the rules each key does and does not cover.
    // That is a thing an architect reads once and answers once. The SPECIFIC problems — a rule that needs
    // another stream, a band with no key at all — stay per-occurrence below, where they are actionable.
    const owning = ir.swimlanes.filter((l) =>
      ir.elements.some((e) => e.kind === "event" && l.streams.includes(e.aggregate)));
    if (owning.length) {
      const rows = owning.map((l) => {
        const writers = [...new Set(l.streams.flatMap((a) => writersOf(a).map((s) => s.name)))];
        const temporal = l.identity.some((n) => isTemporal({ name: n }));
        return `      ${l.streams.join("+")} keyed by (${l.identity.join(", ") || "NOTHING DECLARED"})` +
               ` — written by ${writers.length} slice(s)${writers.length ? ": " + writers.join(", ") : ""}` +
               `${temporal ? "; the key carries a period, so it closes its own books" : ""}`;
      });
      qs.push({
        id: `stream-boundaries/${ctx}`,
        family: "stream-boundaries", area: "write", context: ctx,
        subject: `${owning.length} stream(s) we append to, in ${ctx}`,
        says: `the boundary map as drawn:\n${rows.join("\n")}`,
        asks: "Is each key the consistency boundary its invariants need, and does any of these streams grow without end? Both books: the aggregate IS the transactional consistency boundary.",
        options: [
          "keep them — every invariant sits inside one key, so optimistic concurrency on the stream version enforces it",
          "widen a key so a contested thing lives in ONE stream — the rule becomes a true in-transaction invariant, at the cost of putting that key on every event of the stream and on the commands",
          "accept that a wider-than-key rule is a best-effort check against a projection, and say who agreed",
          "close the books on a long-lived stream by putting a business period in its key — the book prefers this to snapshots outright, and calls snapshots the exception rather than the rule",
        ],
        mirror: "marten/events/appending and optimistic concurrency; the kit uses FetchForWriting<T>(streamKey) because [Aggregate] cannot resolve a composite key. For growth: marten snapshots, but read the book's preference for a business period first",
        weight: 3,
      });
    }
    // A band that owns events and declares no key at all is a specific, actionable defect rather than a
    // judgement — model.mjs already errors on it, so this only ever fires on a model being built.
    for (const l of owning.filter((x) => !x.identity.length)) {
      qs.push({
        id: `no-stream-key/${ctx}/${l.streams.join("+")}`,
        family: "no-stream-key", area: "write", context: ctx,
        subject: l.streams.join(", "),
        says: "this band holds events we append and declares no identity=",
        asks: "What keys one stream of this? Until that is answered there is no consistency boundary at all, and nothing to apply optimistic concurrency to.",
        options: ["declare identity= on the band — model.mjs already reports this as band-needs-identity"],
        mirror: "CLAUDE.md, the identity= section: what keys ONE stream, and why it is a domain question",
        weight: 3,
      });
    }

    // ---- W2: a rule that needs a stream its command does not write --------------------------------
    //
    // THE SHARPEST DERIVATION HERE, and it is exactly the shape of a double-booking rule. If a scenario's
    // GIVEN names events from a stream the command does not append to, then enforcing it means READING
    // another stream — and between that read and the append there is a window in which the other stream
    // can change. No amount of optimistic concurrency on OUR stream closes it, because the version that
    // moved is somebody else's.
    for (const s of commandSlices) {
      const writes = [...new Set(s.events.map(el).filter((e) => e?.kind === "event").map((e) => e.aggregate))];
      // NOT `cmd` — that name is the CLI verb at module scope, and shadowing it here silently put "questions"
      // into a scaffolded test as the command to invoke.
      const sliceCommand = s.commands.map(el).filter(Boolean)[0];
      const emitted = s.events.map(el).filter((e) => e?.kind === "event").map((e) => e.label);
      for (const g of s.gwts) {
        // A FOREIGN EVENT IS NOT A STREAM WE READ, and counting it here was a false positive of exactly the
        // kind T0 warns about. We never append to a foreign band, so the notice is never in our store: it
        // arrives as a message in the transport's durable inbox, and there is no read-then-append window of
        // the sort this question describes. Measured: on the translation reference model this fired four
        // times out of seven questions, every one misframed. The real question there is the arrival and the
        // dedupe, which is `replay-safety`'s and CLAUDE.md's landing table.
        //
        // Unless `ingested="true"` — then we deliberately do append it, so it IS in our store and readable,
        // and the window is real again.
        const givenAggs = [...new Set((g.givenSteps ?? [])
          .map((x) => byLabel.get(x.label))
          .filter((e) => e && (e.kind === "event" || (e.kind === "external" && e.ingested)))
          .map((e) => e.aggregate).filter(Boolean))];
        let foreign = givenAggs.filter((a) => !writes.includes(a));
        let sameAggOtherStream = null;
        const rejects = /^error\s*:/i.test(g.then ?? "");

        // SAME AGGREGATE IS NOT SAME STREAM, once the key is composite.
        //
        // `foreign` above compares AGGREGATE NAMES, which was sound while every stream key was a single
        // field equal to the aggregate's identity — aggregate and stream instance were then the same
        // thing. With `identity="deskId, date"` one aggregate spans a stream per desk per day, so a rule
        // reading OTHER streams of the SAME aggregate was reported as "the same stream the command
        // appends to". It is not, and the misclassification is dangerous rather than untidy: it asks for
        // a race test that PASSES (racing one desk-day really does refuse the loser) while the rule it
        // was meant to protect — "a member may hold at most 3 upcoming bookings", which reads three other
        // desk-day streams — stays broken and untested. KIT-FINDINGS Z1.
        //
        // The model already carries the answer: a GWT's example data names the key on both sides. Where
        // every identity field is given on the WHEN and on a GIVEN step, compare them. Differ => the
        // GIVEN lives in another stream, so this is cross-stream. Absent example data we cannot tell, and
        // the old aggregate-name behaviour stands.
        if (!foreign.length && rejects && givenAggs.length) {
          const key = laneOfAggregate.get(givenAggs[0])?.identity ?? [];
          const keyOfStep = (st) => key.every((f) => st?.example?.[f] !== undefined)
            ? key.map((f) => st.example[f]).join(" ") : null;
          const whenKey = keyOfStep((g.whenSteps ?? [])[0]);
          const givenKeys = (g.givenSteps ?? []).map(keyOfStep).filter(Boolean);
          if (key.length > 1 && whenKey && givenKeys.length && !givenKeys.includes(whenKey)) {
            foreign = givenAggs;   // same aggregate, provably a different stream => cross-stream
            sameAggOtherStream = `(${key.join(", ")}) = (${givenKeys[0]}) vs (${whenKey})`;
          }
        }

        // ---- W4: A CONTENDED INVARIANT — the rule is inside our own stream, so a race decides it -----
        //
        // The complement of cross-stream-rule below. If a REJECTION depends on state accumulated in the
        // very stream the command appends to, then the stream key is what enforces it and optimistic
        // concurrency is what makes it true under load. That is exactly the class of rule two concurrent
        // writers can both pass if the boundary is wrong — and PROVEN so: keyed per booking instead of per
        // desk-day, ten writers produced ten bookings of one desk-day (KIT-FINDINGS CC).
        //
        // Filtered to `aggregate` enforcement and a NON-EMPTY given. A periphery rule is settled by the
        // request alone, and a rejection with no given= has no accumulated state to race over — including
        // both would have asked for a race test on "a campaign with no name is refused", which is noise.
        if (!foreign.length && rejects && g.enforce !== "periphery" && givenAggs.length) {
          const lane = laneOfAggregate.get(givenAggs[0]);
          qs.push({
            id: `contended-invariant/${ctx}/${s.name}/${g.id}`,
            family: "contended-invariant", area: "write", context: ctx,
            subject: `${s.name}: ${g.rule || g.id}`,
            says: `a rejection that depends on state in ${givenAggs.join(", ")} — the same stream the command appends to, keyed by (${lane?.identity.join(", ") ?? "?"})`,
            asks: "Two callers doing this at the same instant: is exactly one refused? Only a test that races them can answer, and no generated GWT does — every one of them is sequential.",
            options: [
              "the stream key already contains the contested thing, so optimistic concurrency refuses the loser — WRITE THE RACE TEST that proves it",
              "the key does NOT contain it, so this rule is a best-effort check two writers can both pass. Either widen the key or say out loud that the rule is advisory",
              "serialise deliberately with FetchForExclusiveWriting — a Postgres row lock, correct when the outcome depends only on the state read",
            ],
            mirror: "marten scenarios/command_handler_workflow (FetchForWriting, FetchForExclusiveWriting); and probes/concurrency-invariant.cs, which measures both refusal mechanisms",
            weight: 3,
            race: { slice: s.name, gwt: g.id, rule: g.rule ?? g.id,
                    command: sliceCommand?.label ?? null, emits: emitted,
                    given: (g.givenSteps ?? []).map((x) => x.label),
                    aggregate: givenAggs[0], identity: lane?.identity ?? [],
                    // status= decides whether the scaffold is LIVE or skipped, exactly as it does for a
                    // GWT test in codegen.mjs. Without it every contended invariant in the model produced
                    // two live NotImplementedException tests the moment `architect tests` ran — so four
                    // unclaimed slices turned the suite red and the one FINISHED slice became invisible,
                    // which is the precise failure `status=` exists to prevent.
                    status: s.status ?? "in-design" },
          });
        }

        if (!foreign.length) continue;
        qs.push({
          id: `cross-stream-rule/${ctx}/${s.name}/${g.id}`,
          family: "cross-stream-rule", area: "write", context: ctx,
          subject: `${s.name}: ${g.rule || g.id}`,
          says: sameAggOtherStream
            ? `the command appends to one ${writes.join(", ")} stream but this scenario's GIVEN lives in ANOTHER stream of the same aggregate — ${sameAggOtherStream}${rejects ? ", and it is a REJECTION" : ""}`
            : `the command appends to ${writes.join(", ")} but this scenario's GIVEN lives in ${foreign.join(", ")}${rejects ? ", and it is a REJECTION" : ""}`,
          asks: "Enforcing this means reading another stream. What happens if that stream changes between the read and the append?",
          options: [
            "accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed",
            "make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read",
            "compensate — let it through and emit a correcting event when the conflict is detected later",
            "serialise on the far stream's version too, which couples the two and can deadlock",
          ],
          mirror: "reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session — see CLAUDE.md",
          weight: rejects ? 2 : 1,
        });
      }
    }

    // ---- R1: how stale may this view be? ----------------------------------------------------------
    for (const v of ir.elements.filter((e) => e.kind === "readmodel")) {
      const feeds = v.upstream.map(el).filter((e) => e && ["event", "external"].includes(e.kind));
      const streamTypes = [...new Set(feeds.map((e) => e.aggregate).filter(Boolean))];
      // Marten has NO default lifecycle — the argument is required — and its multi-stream page says
      // "register the lookup projection inline and the multi-stream projection async". codegen now does
      // exactly that, so >1 stream type means this view IS Async and a reader must wait rather than assert.
      const multi = streamTypes.length > 1;

      // READ-YOUR-OWN-WRITE: a screen that both displays this view AND issues a command whose event feeds
      // it. The user presses the button and expects to see their own change. If the view is Async, a
      // refetch straight after the POST renders stale data and reads as a UI bug.
      const readers = ir.elements.filter((e) => e.kind === "screen" && e.upstream.includes(v.id));
      const rywScreens = readers.filter((scr) => scr.downstream.map(el).some((c) => {
        if (c?.kind !== "command") return false;
        const owner = ir.slices.find((s) => s.commands.includes(c.id));
        return owner?.events.map(el).some((e) => e?.kind === "event" && feeds.some((f) => f.label === e.label));
      })).map((scr) => scr.screen ?? scr.label);

      // NOT `continue` — the identity question below is independent of staleness, and putting this guard
      // above it silently skipped the highest-value check in the file. Measured: SenderMonthly is
      // single-stream with no screen, so it was skipped entirely, and its `month` key is the one real
      // documented bug in this reference model (a row keyed 2026-08 from an event stamped 2026-01-15).
      if (multi || rywScreens.length) qs.push({
        id: `stale-read/${ctx}/${v.label}`,
        family: "stale-read", area: "read", context: ctx,
        subject: v.label,
        says: [
          multi ? `fed by ${streamTypes.length} stream types (${streamTypes.join(", ")}), which codegen registers ASYNC, per Marten's own guidance`
                : `fed by one stream type (${streamTypes.join(", ")})`,
          rywScreens.length ? `and ${rywScreens.join(", ")} both displays it and issues a command that feeds it — the user reads their own write` : null,
        ].filter(Boolean).join("; "),
        asks: "How stale may this be, and who agreed to that? The book says to settle this with the subject-matter experts, because it causes bugs that are nearly impossible to reproduce.",
        options: [
          "accept it — Async, and document the window. The book: \"if a problem is not a problem, we should not try to fix it with technology just because we can\"",
          "make it immediately consistent — Inline, in the same transaction. Costs the book names: the write side is no longer independently scalable, a projection error can abort the business transaction, and every added projection slows the write",
          "a (partial) live model over the projection — FetchLatest for the last events, filling the staleness gap in the query. In-memory, so lost on restart",
        ],
        mirror: "marten/events/projections/ — registration, ProjectionLifecycle, and Marten's own warning about Inline on multi-stream. Tests on an Async view need WaitForNonStaleProjectionDataAsync (Marten.Events.TestingExtensions)",
        weight: rywScreens.length ? 2 : 1,
      });

      // ---- R2: an identity field no feeding event supplies ----------------------------------------
      //
      // ANTI-PATTERNS #15. Marten makes keying on the ENVELOPE easy — Identity<IEvent<T>> reaches
      // e.Timestamp — and IEvent.Timestamp is stamped when the event is APPENDED. So the view answers
      // "appended in month M" while every reader assumes "happened in month M". Measured on a real model:
      // seed data carrying queuedAt = 2026-01-15 produced a row keyed 2026-08.
      const supplied = new Set(feeds.flatMap((e) => e.fields.map((f) => f.name)));
      for (const k of keyOf(v)) {
        if (supplied.has(k)) continue;
        const fanOut = feeds.flatMap((e) => e.fields.filter((f) => f.collection &&
          (f.name === `${k}s` || f.name.toLowerCase() === `${k.toLowerCase()}s` || f.name.toLowerCase().startsWith(k.toLowerCase()))))
          .map((f) => f.name);
        qs.push({
          id: `view-identity/${ctx}/${v.label}/${k}`,
          family: "view-identity", area: "read", context: ctx,
          subject: `${v.label}.${k}`,
          says: `one row is keyed by "${k}", and no event feeding this view carries a field of that name` +
                (fanOut.length ? `. A collection field ${fanOut.join(", ")} exists, so this is probably a fan-out` : ""),
          asks: "Where does this key value come from? If the answer is event metadata, the view is keyed on APPEND time.",
          options: [
            fanOut.length ? `fan out ${fanOut[0]} into one row per member — Identities<T> or FanOut<T,TChild>, no metadata involved` : "derive it from a payload field the events do carry",
            "compute it from a payload timestamp the events carry — correct, and the answer almost every time a period is involved",
            "read it off the envelope with Identity<IEvent<T>> — ONLY if the question genuinely is about the write, because Timestamp ignores the payload and moves under backfill, import, late correction and replay",
          ],
          mirror: "marten/events/projections/multi-stream-projections — Identity<T>, Identities<T>, FanOut, and the IEvent<T> envelope form",
          weight: 2,
        });
      }
    }

    // ---- A1: is running it twice safe? ------------------------------------------------------------
    //
    // The book: an event handler that triggers an action "might be triggered again during an event replay.
    // This is often undesirable... This is not a problem in general if the changes are idempotent." The kit
    // already says a sweep must be safe to run twice; nothing asks whether it IS.
    for (const s of ir.slices.filter((x) => ["automation", "translation"].includes(x.pattern))) {
      qs.push({
        id: `replay-safety/${ctx}/${s.name}`,
        family: "replay-safety", area: "automation", context: ctx,
        subject: s.name,
        says: `pattern=${s.pattern}, so something wakes it without a human${s.pattern === "translation" ? " and the trigger event arrives from outside" : ""}`,
        asks: "Is running this twice safe? A replay, a redelivery and a restarted sweep all do it.",
        options: [
          "idempotent by construction — the todo View no longer selects the row once its own event ticks it off",
          "dedupe on a value carried by OUR OWN event (a notice id), which is the one place a foreign id legitimately crosses",
          "guard the trigger so it never re-fires on replay, and accept that a genuine re-run then needs a hand",
        ],
        mirror: "wolverine/durability (inbox, dead letters) and marten/events/projections/rebuilding; the kit's automation folder measures four wakeup mechanisms",
      });
    }

    // ---- S1: what IS a domain type, in C#? ---------------------------------------------------------
    //
    // THE MODEL IS STACK-AGNOSTIC AND MUST STAY THAT WAY. `fields="aggregateId:UUID"` is the business
    // saying "a universally unique id"; it is not a claim about .NET, and model.mjs holds no list of C#
    // types on purpose. So SOMETHING has to translate, and that something cannot be codegen guessing —
    // it used to pass every unknown type through verbatim, which produced 68 compile errors from the
    // kit's own fixture with nothing naming the cause (KIT-FINDINGS W9).
    //
    // It is a decision with a cost, so it belongs here: `Double` or `decimal` for money is a rounding
    // question somebody has to own, not a typo.
    const rows = distinctTypes(ir.elements);
    if (rows.length) {
      const unbound = rows.filter((r) => !r.proposed);
      qs.push({
        id: `type-binding/${ctx}`,
        family: "type-binding", area: "stack", context: ctx,
        weight: unbound.length ? 2 : 1,
        subject: `${rows.length} distinct domain type(s) in ${ctx}`,
        says: rows.map((r) => `${r.type} (${r.usedAt})`).join(", "),
        asks: unbound.length
          ? `What is each of these in C#? ${unbound.length} has no unambiguous proposal: ${unbound.map((r) => r.type).join(", ")}.`
          : "What is each of these in C#? Every one has an unambiguous proposal, so confirm the table and say what it costs.",
        options: [
          "accept the proposed table — every binding is the obvious one, and the record is where a reviewer can disagree",
          "override a fractional type: the proposal is decimal for ALL of them, because money is the common case here and binary floating point is wrong for money. A field that is genuinely a measurement should say double and say why",
          "override a time type: DateTimeOffset carries an offset and DateTime does not, and a stream keyed on a business period cares which",
          "rename in the MODEL instead, if the domain word is simply wrong — that is a domain fact and goes back to add-slice, not here",
        ],
        mirror: "no library page decides this. reference/llms/marten/documents/json for how a type is persisted, and marten/events/appending for what a stream key may be",
        decision: renderBindings(rows),
      });
    }
  }
  // Heaviest first: a wrong answer to a weighted question is one that passes every test.
  return qs.sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
}

// --- questions ------------------------------------------------------------------------------------

const AREA = { write: "THE WRITE SIDE — invariants, boundaries and races",
               read: "THE READ SIDE — how stale may it be, and what is one row",
               automation: "AUTOMATIONS — is running it twice safe",
               stack: "THE STACK BINDING — what a domain type IS in C#" };

if (cmd === "questions") {
  const qs = derive();
  if (has("json")) { console.log(JSON.stringify({ questions: qs }, null, 2)); process.exit(0); }

  console.log(`architect — ${qs.length} question(s) the model implies and cannot answer\n`);
  if (!qs.length) {
    console.log("  None. Every stream key covers its own rules, no view is fed by more than one stream type,");
    console.log("  no screen reads its own write, every view key is in a payload, and there is no automation.");
    console.log("  That is a real answer for a small model — not a sign the check did nothing.");
    process.exit(0);
  }
  for (const area of ["write", "read", "automation", "stack"]) {
    const mine = qs.filter((q) => q.area === area);
    if (!mine.length) continue;
    console.log(`${"=".repeat(100)}\n${AREA[area]}\n`);
    for (const q of mine) {
      console.log(`  ${q.id}`);
      console.log(`    subject:  ${q.subject}`);
      console.log(`    model:    ${q.says}`);
      console.log(`    QUESTION: ${q.asks}`);
      for (const o of q.options) console.log(`       - ${o}`);
      console.log(`    mirror:   ${q.mirror}\n`);
    }
  }
  console.log(`Answer them against reference/llms/ — never from remembered API — then:`);
  console.log(`  node tools/architect.mjs record     # a section per question, for the decision and its cost`);
  console.log(`\nNothing here is a defect and nothing here edits the model. Concurrency is not a modelling`);
  console.log(`concern; these are the choices the model leaves open, and an unmade choice is made by accident.`);
  process.exit(0);
}

// --- record ---------------------------------------------------------------------------------------
//
// Scaffolded, never overwritten, and keyed by the question's stable id — which is what lets `check` tell an
// unanswered question from an answer that has gone stale. Every write-once file in this kit needs its own
// staleness check; that lesson cost the kit two BROKEN findings before it was learned.

if (cmd === "record") {
  const qs = derive();
  const existing = existsSync(RECORD) ? readFileSync(RECORD, "utf8") : null;
  const held = new Set([...(existing ?? "").matchAll(/^###\s+`([^`]+)`/gm)].map((m) => m[1]));
  const fresh = qs.filter((q) => !held.has(q.id));

  const section = (q) => `### \`${q.id}\`

**Subject:** ${q.subject}
**What the model says:** ${q.says}
**The question:** ${q.asks}

Options, with what each costs:

${q.options.map((o) => `- ${o}`).join("\n")}

**Read first:** ${q.mirror}

**Decision:**${q.decision ? `

${q.decision}` : " TODO(architect)"}

**Because:** TODO(architect)
**It costs:** TODO(architect)
`;

  if (!existing) {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(RECORD, `# Architecture decisions

**What this file is.** The choices the event model deliberately leaves open, and the reasoning behind each
one. Generated as questions by \`node tools/architect.mjs record\` and answered by a human or the
\`architect\` skill against the library docs in the kit's \`reference/llms/\`.

**Why it is not on the model.** An event model's responsibility is domain knowledge and how information
flows. Concurrency, optimistic locking, projection consistency mode and snapshots are technical concerns —
*"Snapshots are a pure technical tool and are neither modeled nor mentioned in an Event Model typically"*
(Understanding EventSourcing). Putting them on a cell would be an implementation choice masquerading as a
business rule, which this kit has done once and regretted.

**Why it is not a manifest either.** Nothing here is a domain fact — every one of these is a decision about
*how* to build what the model already says. The no-manifest rule protects domain facts, which belong on
cells.

**Nothing checks whether an answer is right.** No rule, no compiler, no test: the model validates, the code
compiles, the suite is green, and the choice can still be wrong. That is exactly why the reasoning is written
down rather than merely made — this file is the only artifact that will carry it.

\`node tools/architect.mjs check\` reports questions with no answer, answers still marked TODO, and answers
whose question the model no longer asks.

`, "utf8");
    console.log(`  created  ${rel(RECORD)}`);
  }

  if (!fresh.length) {
    console.log(`\n${qs.length} question(s), all already in ${rel(RECORD)}. Nothing added.`);
    process.exit(0);
  }
  const body = ["", ...["write", "read", "automation", "stack"].flatMap((area) => {
    const mine = fresh.filter((q) => q.area === area);
    return mine.length ? [`## ${AREA[area]}`, "", ...mine.map(section)] : [];
  })].join("\n");
  writeFileSync(RECORD, (existsSync(RECORD) ? readFileSync(RECORD, "utf8") : "") + body, "utf8");
  console.log(`  ${fresh.length} question(s) added to ${rel(RECORD)}, each with a TODO(architect) decision`);
  console.log(`  ${held.size} already there`);
  console.log(`\nAnswer each one against reference/llms/, then: node tools/architect.mjs check`);
  process.exit(0);
}

// --- tests: a RACE test per contended invariant ----------------------------------------------------
//
// THE ONE TEST SHAPE THE MODEL CANNOT ASK FOR. Every generated GWT is sequential — one WHEN, by design and
// by rule — so "two callers at the same instant" has no home there, and it must not get one: the business
// rule is "one member per desk per day", and the race is how that rule is ENFORCED. Putting it on a cell is
// finding T0 again.
//
// So it belongs here. The architect already derives WHERE contention is possible, mechanically, from the
// model; this turns each of those into a runnable test. Which is the division the human named: the
// architect's job is to find the points and say "write a race test for this one".
//
// Everything in the harness was measured first, in probes/concurrency-invariant.cs, and three things in it
// are counter-intuitive enough that they are the whole reason the harness exists rather than a doc comment:
//   * Task.WhenAll IS NOT A RACE. Released together, each caller then does its own read and the database
//     serialises them — the first version of that probe reported "1 winner, 0 conflicts, 9 refused by the
//     rule" and looked like a pass. Read first, THEN fire the starting gun.
//   * TWO refusal mechanisms with two exception types: creating the stream is refused by the stream table's
//     primary key, appending to one that exists by the version check.
//   * The documented exception is not the one thrown. command_handler_workflow.md says ConcurrencyException;
//     Marten 8.37.4 throws EventStreamUnexpectedMaxEventIdException.

if (cmd === "tests") {
  compiled();   // sets SYSTEM from the model cell
  const races = derive().filter((q) => q.race);
  const TESTS = join(PROJ, "generated", SYSTEM, "tests", `${SYSTEM}.IntegrationTests`, "Concurrency");

  if (!races.length) {
    console.log(`No contended invariant in the model, so there is nothing to race.`);
    console.log(`A contended invariant is a REJECTION that depends on state in the same stream its command`);
    console.log(`appends to — that is the class of rule two concurrent writers can both pass. A model whose`);
    console.log(`rejections are all periphery rules ("no name", "not in the past") genuinely has none.`);
    process.exit(0);
  }
  if (!existsSync(join(PROJ, "generated", SYSTEM))) {
    console.error(`${rel(join(PROJ, "generated", SYSTEM))} does not exist — run codegen first, so these tests have a project to live in.`);
    process.exit(1);
  }

  emit(join(TESTS, "ConcurrencyHarness.cs"), harness());
  for (const q of races) scaffoldFile(join(TESTS, `${pascal(q.race.slice)}ConcurrencyTests.cs`), raceTest(q));

  for (const p of written) console.log(`  written  ${rel(p)}`);
  for (const p of keptFiles) console.log(`  kept     ${rel(p)}`);
  console.log(`\n${written.length} written, ${keptFiles.length} kept (already filled in)`);
  console.log(`\n${races.length} contended invariant(s):`);
  for (const q of races) console.log(`  ${q.race.rule}\n     ${q.race.command} on ${q.race.aggregate}, keyed by (${q.race.identity.join(", ") || "?"})`);
  console.log(`\nEach scaffold asserts the invariant TWICE and neither is optional:`);
  console.log(`  1. deterministically, two sessions — reliable, and proves the STREAM KEY enforces the rule`);
  console.log(`  2. through HTTP, N callers — proves the ENDPOINT turns a lost race into a sane response`);
  console.log(`\nThen prove the tests bite: temporarily key the stream per-operation instead of per-contested-thing`);
  console.log(`and test 1 must FAIL. Measured in probes/concurrency-invariant.cs as 10 winners for one desk-day.`);
  process.exit(0);
}

function harness() {
  return `// <auto-generated> by tools/architect.mjs — regenerated every run, so do not edit.
//
// RACING TWO WRITERS AT ONE INVARIANT. Every other test in this project is sequential; this is the only
// place "at the same instant" is asserted, and it exists because no GWT can express it.
//
// WHY Task.WhenAll ALONE IS NOT A RACE, measured rather than reasoned. Ten callers released together each
// then did their own read, the database serialised them, and nine were refused by the BUSINESS RULE having
// read the state after the winner committed — "1 winner, 0 conflicts" looked like a pass while the
// concurrency guard was never exercised. So: every caller reads and decides FIRST, and only then does the
// starting gun fire. Deterministic and genuinely parallel at once.
#nullable enable

using JasperFx.Events;
using Marten;

namespace ${SYSTEM}.IntegrationTests.Concurrency;

/// <summary>How a writer that lost a race was refused. Marten has TWO mechanisms, not one.</summary>
public enum RaceOutcome
{
    /// <summary>Committed. Exactly one writer may end here.</summary>
    Won,
    /// <summary>Refused creating the stream — the stream table's primary key. The FIRST write to a key.</summary>
    StreamCollision,
    /// <summary>Refused appending to a stream that exists — the optimistic version check.</summary>
    VersionConflict,
    /// <summary>Refused by the business rule itself, having read state the winner had already committed.</summary>
    RefusedByRule,
    /// <summary>Anything else. Always a finding.</summary>
    Unexpected,
}

public sealed record RaceResult(RaceOutcome Outcome, string? Detail = null);

public static class ConcurrencyHarness
{
    /// <summary>
    /// Classify what a losing writer threw.
    ///
    /// BOTH NAMES MATTER AND THE DOCS NAME NEITHER FOR THE APPEND CASE. Marten's own
    /// command_handler_workflow page says a stream that moved under FetchForWriting fails with
    /// <c>ConcurrencyException</c>; on the pinned Marten it throws
    /// <c>EventStreamUnexpectedMaxEventIdException</c>. Accept either — asserting only the documented one
    /// fails against the real runtime.
    /// </summary>
    public static RaceResult Classify(Exception ex) => ex.GetType().Name switch
    {
        "ExistingStreamIdCollisionException" => new(RaceOutcome.StreamCollision),
        "ConcurrencyException" or "EventStreamUnexpectedMaxEventIdException" => new(RaceOutcome.VersionConflict),
        var other => new(RaceOutcome.Unexpected, other + ": " + ex.Message),
    };

    /// <summary>
    /// Race <paramref name="writers"/> callers at one stream, with every read completed before any write.
    ///
    /// <paramref name="decideAndStage"/> reads the stream and stages its append WITHOUT saving — return
    /// false to mean "the business rule refused me". <paramref name="commit"/> then saves. Splitting them
    /// is the whole point: it is what makes the contention real instead of accidental.
    /// </summary>
    public static async Task<RaceResult[]> RaceAsync(
        int writers,
        Func<int, IDocumentSession, Task<bool>> decideAndStage,
        IDocumentStore store)
    {
        var gate = new TaskCompletionSource();
        var readsDone = new List<Task>();
        var runs = new List<Task<RaceResult>>();

        for (var i = 0; i < writers; i++)
        {
            var index = i;
            var read = new TaskCompletionSource();
            readsDone.Add(read.Task);
            runs.Add(Task.Run(async () =>
            {
                var session = store.LightweightSession();
                try
                {
                    var staged = await decideAndStage(index, session);
                    read.SetResult();
                    await gate.Task;
                    if (!staged) return new RaceResult(RaceOutcome.RefusedByRule);
                    await session.SaveChangesAsync();
                    return new RaceResult(RaceOutcome.Won);
                }
                catch (Exception ex) { read.TrySetResult(); return Classify(ex); }
                finally { await session.DisposeAsync(); }
            }));
        }

        await Task.WhenAll(readsDone);   // every writer has now decided from the same state
        gate.SetResult();                // the starting gun
        return await Task.WhenAll(runs);
    }

    public static int Count(this RaceResult[] rs, RaceOutcome o) => rs.Count(r => r.Outcome == o);
    public static string Describe(this RaceResult[] rs) =>
        string.Join(", ", rs.GroupBy(r => r.Outcome).OrderBy(g => g.Key)
            .Select(g => $"{g.Key}={g.Count()}")) +
        (rs.Any(r => r.Outcome == RaceOutcome.Unexpected)
            ? "  UNEXPECTED: " + string.Join(" | ", rs.Where(r => r.Outcome == RaceOutcome.Unexpected).Select(r => r.Detail))
            : "");
}
`;
}

function raceTest(q) {
  const r = q.race;
  const cls = `${pascal(r.slice)}ConcurrencyTests`;
  // Same rule and same wording as codegen.mjs's factAttr, deliberately: a race test on an unclaimed slice
  // has no endpoint to race and no decider to refuse anybody, so a live one is a guaranteed red for work
  // nobody has started. Claim the slice and the Skip has to come off by hand — which is the same bargain
  // codegen already makes, and carries the same trap (see TESTS STILL SKIPPED ON A CLAIMED SLICE).
  const claimed = ["ready", "in-progress", "in-review", "closed"].includes(r.status ?? "in-design");
  const fact = claimed
    ? "[Fact]"
    : `[Fact(Skip = ${JSON.stringify(`slice ${r.slice} is ${r.status ?? "in-design"} — nobody has claimed this invariant yet`)})]`;
  return `// <auto-generated-scaffold> by tools/architect.mjs — yours from here on, and regeneration keeps it.
//
// THE CONTENDED INVARIANT: ${r.rule}
//
//   slice        ${r.slice}
//   command      ${r.command ?? "(none named)"}
//   appends      ${r.emits.join(", ") || "(none)"}
//   stream       ${r.aggregate}, keyed by (${r.identity.join(", ") || "NOT DECLARED — fix that first"})
//   given        ${r.given.join(", ") || "(none)"}
//
// WHY THIS FILE EXISTS AND NO GWT DOES. This rule depends on state accumulated in the very stream its
// command appends to, which makes it the class of rule TWO CONCURRENT CALLERS CAN BOTH PASS if the stream
// key does not contain the contested thing. Every generated GWT is sequential — one WHEN, by rule — so
// none of them can see it. The model is right not to describe this: the business rule is the invariant,
// the race is how it is enforced.
//
// The decision and its reasoning are in ARCHITECTURE.md under:
//   ${q.id}
#nullable enable

using Shouldly;
using Xunit;
using static ${SYSTEM}.IntegrationTests.Concurrency.ConcurrencyHarness;

namespace ${SYSTEM}.IntegrationTests.Concurrency;

public sealed class ${cls}(AppFixture fixture) : IntegrationContext(fixture)
{
    /// <summary>
    /// THE PRIMARY ASSERTION, and it is deterministic — no timing, so it cannot flake. Every writer reads
    /// and decides before any writer commits, which is what makes the contention real. If the stream key
    /// contains the contested thing, exactly one commits and the rest are refused by Marten.
    /// </summary>
    ${fact}
    public async Task ExactlyOneWriterWins()
    {
        // TODO(architect): stage the same operation from ${r.identity.length ? "one stream key" : "the contested stream"} in each writer.
        //   var key = $"...";        // the ONE stream key all writers contend on: (${r.identity.join(", ") || "?"})
        //   var results = await RaceAsync(10, async (i, session) =>
        //   {
        //       var stream = await session.Events.FetchForWriting<${pascal(r.aggregate)}>(key);
        //       if (/* the rule already refuses this */) return false;
        //       stream.AppendOne(new ${r.emits[0] ?? "TheEvent"}(/* ... */));
        //       return true;
        //   }, Store);
        //
        //   results.Count(RaceOutcome.Won).ShouldBe(1, results.Describe());
        //   results.Count(RaceOutcome.Unexpected).ShouldBe(0, results.Describe());
        //
        // BOTH REFUSAL MECHANISMS ARE LEGITIMATE and which one you get depends on whether the stream
        // already existed: StreamCollision on a first write to the key, VersionConflict on an append to
        // one that exists. Assert on Won, not on the loser's flavour, unless you mean to pin the flavour.
        throw new NotImplementedException(
            "TODO(architect): race ${r.command ?? "the command"} at ${r.aggregate} and assert exactly one winner.");
    }

    /// <summary>
    /// THE SECOND ASSERTION: the same contention through the real endpoint, which is what proves a lost
    /// race becomes a sane RESPONSE rather than a 500.
    ///
    /// Note it asserts AT MOST one success, not exactly one. Racing HTTP requests cannot guarantee they
    /// overlap — each request does its own read inside the endpoint, so the database may serialise them
    /// and every loser is then refused by the business rule instead. Both outcomes are correct; "at most
    /// one" is true either way and never flakes. The deterministic test above is what pins the invariant.
    /// </summary>
    ${fact}
    public async Task ConcurrentRequestsNeverBothSucceed()
    {
        // TODO(architect): fire N identical POSTs with Task.WhenAll and assert:
        //   * at most one 2xx
        //   * every other response is the rule's ProblemDetails, with Title == "${r.rule}" or the
        //     rejection this rule is named after — NOT a 500. A lost race that reaches the client as an
        //     unhandled exception is the finding this test exists for.
        throw new NotImplementedException(
            "TODO(architect): race the endpoint and assert at most one success, and no 5xx.");
    }
}
`;
}

// --- check ----------------------------------------------------------------------------------------

if (cmd === "check") {
  const qs = derive();
  if (!existsSync(RECORD)) {
    console.log(`NO ARCHITECTURE RECORD, and the model asks ${qs.length} question(s).`);
    console.log(`Every one of them is a choice that gets made by accident if nobody makes it on purpose:`);
    for (const q of qs.slice(0, 8)) console.log(`  ${q.id}`);
    if (qs.length > 8) console.log(`  … and ${qs.length - 8} more`);
    console.log(`\n  node tools/architect.mjs questions   # read them`);
    console.log(`  node tools/architect.mjs record      # then write the decisions down`);
    process.exit(0);
  }
  const src = readFileSync(RECORD, "utf8");
  // Split into sections so a TODO can be attributed to the question it belongs to.
  const sections = new Map();
  const parts = src.split(/^###\s+`([^`]+)`/gm);
  for (let i = 1; i < parts.length; i += 2) sections.set(parts[i], parts[i + 1] ?? "");

  const ids = new Set(qs.map((q) => q.id));
  const unanswered = qs.filter((q) => !sections.has(q.id));
  const undecided = qs.filter((q) => sections.has(q.id) && /TODO\(architect\)/.test(sections.get(q.id)));
  const stale = [...sections.keys()].filter((k) => !ids.has(k));
  const decided = qs.length - unanswered.length - undecided.length;

  console.log(`architect check — ${rel(RECORD)}`);
  console.log(`  ${qs.length} question(s) from the model; ${decided} decided, ${undecided.length} still TODO, ${unanswered.length} not in the record`);

  if (unanswered.length) {
    console.log(`\nQUESTION WITH NO SECTION — ${unanswered.length}. The model asks it and the record does not mention it,`);
    console.log(`which is what happens when the model grows after the record was written:`);
    for (const q of unanswered) console.log(`  ${q.id}\n    ${q.asks}`);
    console.log(`  fix: node tools/architect.mjs record   (it appends, and keeps every answer already there)`);
  }
  if (undecided.length) {
    console.log(`\nDECISION STILL TODO — ${undecided.length}:`);
    for (const q of undecided) console.log(`  ${q.id}`);
  }
  // A CONTENDED INVARIANT WITH NO RACE TEST IS THE ONE GAP NOTHING ELSE CAN SEE. Every generated GWT is
  // sequential, so a green suite says nothing about whether two callers at the same instant are both let
  // through — and that is the failure this whole family exists for.
  const TESTDIR = join(PROJ, "generated", SYSTEM, "tests", `${SYSTEM}.IntegrationTests`, "Concurrency");
  const missingRaces = qs.filter((q) => q.race &&
    !existsSync(join(TESTDIR, `${pascal(q.race.slice)}ConcurrencyTests.cs`)));
  if (missingRaces.length) {
    console.log(`\nRACE TEST NOT WRITTEN — ${missingRaces.length}. These rules depend on state in the stream their own`);
    console.log(`command appends to, so two callers at the same instant can both pass them if the key is wrong.`);
    console.log(`Every generated GWT is sequential and cannot see it:`);
    for (const q of missingRaces) console.log(`  ${q.race.rule}\n     ${q.race.command} on ${q.race.aggregate} (${q.race.identity.join(", ") || "NO KEY"})`);
    console.log(`  node tools/architect.mjs tests`);
  }

  if (stale.length) {
    console.log(`\nANSWER TO A QUESTION NOBODY ASKS — ${stale.length}. The model changed and this decision may now`);
    console.log(`describe something that no longer exists. Re-read it rather than deleting it blind — the reasoning`);
    console.log(`may still apply under a new id:`);
    for (const k of stale) console.log(`  ${k}`);
  }
  if (!unanswered.length && !undecided.length && !stale.length && !missingRaces.length) {
    console.log(`\nEvery question the model asks has a decision, and no decision is orphaned.`);
    console.log(`That does NOT mean the answers are right — nothing can check that. It means they were made.`);
  }
  process.exit(0);
}
