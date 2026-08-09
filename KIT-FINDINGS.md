# Kit findings — what is still open

**This file is the to-do list. It is meant to stay short.** Everything already fixed is in
[KIT-HISTORY.md](KIT-HISTORY.md) — the lab notebook, one section per run, kept because in this kit the
*reasoning* is the artifact and most findings are of the form *"this compiled, passed, and was wrong."*

Nothing here is scheduled. The kit is used by picking one of these up.

**Finding IDs are stable and never reused.** Code and skills cite them as *"KIT-FINDINGS AD11"* from about
twenty places; an ID lives in whichever of the two files matches its status, so the citation resolves with:

```
grep -n "AD11" KIT-FINDINGS.md KIT-HISTORY.md
```

An ID that moves from here to the archive has been fixed — that is the only direction it ever travels.

| | |
| --- | --- |
| **BROKEN** | produces wrong output today |
| **GAP** | a capability that does not exist |
| **NOISE** | a false positive, or cosmetic |
| **OPEN** | a question nobody has answered |

---

## 1. Wrong output, silently — fix these first

These pass every check the kit has. That is what makes them the top of the list.

### Z5 — two labels that PascalCase to one identifier: one is silently dropped, and reported as `kept` · **BROKEN**

`Stock Level Set` and `StockLevelSet` become the same C# identifier. The second file overwrites the first
and the run reports it as `kept (already filled in)`, so the count looks healthy. **The report actively
lies here**, which is worse than the collision. → [detail](KIT-HISTORY.md)

### AD9 — `validate` passes 0/0 on a `.drawio` draw.io cannot open · **BROKEN**

The parser is more tolerant than the editor. A model can be green in the kit and unopenable by the human
who has to look at it — and *"always close the loop by looking at the diagram"* is the one rule that then
cannot be followed. → [detail](KIT-HISTORY.md)

### AD4 — `reflow` grows lanes and never shrinks them · **BROKEN**

Geometry only ratchets. Remove a swimlane and the lane keeps its height for ever, so every derived y is
wrong in a way nothing reports. → [detail](KIT-HISTORY.md)

### AD5 — the View → Screen routing strip is placed under the UI LANE, not under the last ACTOR band · **BROKEN**

With actor lanes drawn, the strip lands inside the lanes instead of below them, so feeds cut through
screens. Latent until a model has two actors. → [detail](KIT-HISTORY.md)

### BM3 — the kit had 156 tests and not one of them was a unit test · **GAP** · *partly closed*

Not a testing preference — a **consequence**. A decider holding `IDocumentSession` cannot be tested any
other way, which is precisely the cost `LEB` ch. 15 warns about (*"you'll need a mocking framework"*), paid
in Testcontainers instead of mocks. With the deciders converted (**BM1**) the tier became possible:
`reservation/` has 12 and `automation/` 4, running in **~150 ms with Docker stopped**.

**Still open for the other four folders**, and for the shape worth copying: a unit test can assert things no
integration test can reach — `an_already_decided_grant_does_not_call_the_work_again` checks that the
executor was not invoked a second time, which leaves no trace in the event store and is the thing that
cannot be undone.

### BM4 — three namespaces no doc page states, all found the same way · **NOISE** · *recorded, not fixable*

The AD15 class, three more in one session. `IEventStream<T>` is in **`JasperFx.Events`**, not
`Marten.Events`. `OnException<T>()` is an extension on `IWithFailurePolicies` in
**`Wolverine.ErrorHandling`** — the docs show both `opts.OnException<T>()` and
`opts.Policies.OnException<T>()` and **neither compiles** without that using. `StubEventStream<T>` exposes
`EventsAppended` and `Key`, while the docs' own unit-test example uses `.Events` and `.Id` — and `Id` is
documented as *"Guid.Empty when the stream is keyed by string"*, so it silently addresses nothing on a
string-identity store.

Standing rule unchanged and earning its keep: **read the mirror, grep the package `.xml`, then compile.**

### BL3 — a codegen run that CRASHES leaves partial scaffolds, and the next run reports them as `kept` · **BROKEN**

Measured: `codegen.mjs` died partway through view generation (BL1), and the re-run after the fix printed
`29 file(s) written, 4 kept (already filled in)`. Nobody had filled anything in — those four were the
crashed run's own half-written scaffolds, and `kept` means *regeneration will never touch them again*. The
count looks healthy, which is the same failure shape as **Z5**: the report actively lies.

`rm -rf generated build` and re-run is the workaround, and it is only obvious if you already suspect it. A
scaffold written by a run that did not finish is not a scaffold anybody owns; either write scaffolds last,
or write them to a staging name and rename on success.

### AD7 — `route` refuses a same-column View → Screen because of `SCREEN_X_NUDGE` · **BROKEN**

The one edge ch. 16 of the book requires — a View feeding the screen in its own column — is the one the
router will not draw. → [detail](KIT-HISTORY.md)

---

## 2. Missing capability

### A11 — `codegen` scaffolds no decider · ***FIXED 2026-08-09*** → [detail](KIT-HISTORY.md)

It now scaffolds one per command slice — an HTTP endpoint for `state-change`, a message handler for
`automation`/`translation` — in the A-Frame shape, with the middleware attributes, the stream-key member to
resolve and one TODO per rule the model states. **The absent scaffold was not just a gap, it was the
mechanism of BM1**: with nothing to copy, every hand-written decider reached for `IDocumentSession` and
`FetchForWriting`, and the kit's own docs said the alternative was unavailable.

### AD19b — the GWT scaffold's stream-key hint is wrong for a non-stream boundary · **GAP**

A slice whose `architect` decision picked a guard row, reservation row, advisory lock or DCB has a
boundary that a raw `Given` **cannot see** — measured, and it silently made two tests pass for the wrong
reason. The scaffold still says only *"Stream key: `X.StreamKey(...)`"*. It should say which boundary the
slice decides on. Blocked on `codegen` not reading `ARCHITECTURE.md`, which is a larger change.

### AD20a — no multi-step process, and no failure direction · **GAP**

`reference-implementations/automation/` measures four ways to *wake* a trigger. It does not demonstrate a
**chain** of todo lists across slices, and — the one with teeth — **the failure direction**: a command that
fails, leaves its row open, is retried on the next sweep, and dead-letters after N. That is the whole
compensating-transaction story, it is what makes the todo-list pattern a saga replacement, and nothing in
the kit tests it. *"The task stays open and is retried"* is precisely the property a green suite does not
check.

### BK1 — an automation's todo View can silently lose work · ***DEMONSTRATED 2026-08-09*** · **still BROKEN in the generator**

`UES` **ch. 32** names the failure: *"entries get lost if the processor was running before the model got
updated"*. **It is no longer a claim.** `reference-implementations/reservation/` reproduces it
deterministically — `ExecutionModeTests.CONTROL_an_async_todo_view_silently_loses_the_work`: the wakeup
arrives inside the request that appended the trigger event, the async daemon cannot have caught up, the
trigger reads an empty todo list, and the reservation is never executed and never compensated. A 200
response, a clean log, a green suite, and a unit of a limited resource held for ever.

**The defence is to register a todo View `Inline`**, which puts the row in the append's own transaction.
Costs exactly what the book says Inline costs: the write side stops being independently scalable, and a
projection exception aborts the business transaction. Both accepted there, with the reasoning at the line.

What remains open is **BL2 below** — the generator still picks Async for these. And the chapter's own
answer, the *partially synchronous projection* (a bounded in-memory queue filled by a synchronous handler),
is still built nowhere; it is the third read-side option CLAUDE.md names.
→ [BOOK-INDEX.md](reference/BOOK-INDEX.md) gap 1

### BL2 — `codegen` registers a TODO View like any other multi-stream view, which ships the hazard above as a default · **BROKEN**

A todo View is not a view somebody reads. Marten's *"register the lookup projection inline and the
multi-stream projection async"* is guidance about the latter; an automation's **liveness** depends on the
former, and BK1 is what Async costs it. `codegen` cannot tell them apart today and picks Async for both.

It has the information: a View consumed by an `em="automation"` cell on the same slice is a todo View, and
the IR already carries that edge. Either register those Inline, or emit the report — `TODO VIEW REGISTERED
ASYNC` — by the same logic as every other report the generator owes. Worked defence and the deterministic
reproduction: `reference-implementations/reservation/`.

### BK2 — the Reservation Pattern, both halves · ***BUILT 2026-08-09*** → [detail](KIT-HISTORY.md)

### BK3 — the kit emits no metadata: no correlation ID, no causation ID · **GAP**

`UES` **ch. 39**. *"Event Sourcing is about preserving all data, and that includes metadata"*, and
*"we'll deal with metadata later"* is named as the trap. `codegen` generates no metadata strategy at all.

### BK4 — GDPR has no notation, and part of it is model content · **GAP**

`UES` **ch. 41**. Crypto shredding and forgettable payloads are implementation; **data minimalism is
modelling** — keep events fine-grained so personal data lands in one event instead of a fat one, because
a replay is what purges projections and the model is what tells you which ones to replay. No PII notation
exists.

### BK5 — event order is only guaranteed WITHIN a stream, and the kit never says so · **GAP**

`UES` **ch. 30**: *"If more than one stream is used as a source for the projection table... the order of
events typically is only guaranteed within one stream, not over several streams."* The kit generates
multi-stream projections routinely and states this nowhere.

### BK6 — the right-to-left validation walk is not implemented · **GAP**

`UES` **ch. 7** gives *two* validation tricks. The kit has the left-to-right narrative one. The second:
uncover events **from the right**, one at a time, checking each has everything it needs from its
predecessors. That checks **sequence sufficiency**; name-based completeness cannot.

### BK7 — a slice that is not ours to implement has no marker · **GAP**

`LEB` **ch. 9**: *"Slices that just mimic information flow"* get no border — an explicit visual marker for
a slice drawn as context, belonging to another system. The kit has `pattern=` and `status=` and nothing
for this, so **`codegen` would try to generate it**.

### BK8 — Lookup Tables, which answer T5 · **GAP**

`UES` **ch. 37**. The ID → name problem, modelled explicitly or implicitly, with the rule *keep them local
to a slice and accept the duplication*. Closes the "foreign key that is not our key" gap conceptually.

### BK9 — "fenced polling" is the answer the UI findings point at · **GAP**

`UES` **ch. 42**. Return the aggregate sequence from the command, persist the projection's version beside
it, poll only until they match. The kit's `ui-journey` rule *"if an assertion only passed on retry, that is
a finding"* is correct and has never said what to do about it. This is what.

### AD3 — "closing the books" is model content and the kit has no notation · **GAP**

Both books prefer bounding a stream by a business period over snapshotting — *"better to limit the length
of a stream naturally by understanding the business processes."* Which stream closes, and on what event,
is a domain fact with nowhere to live.

### T5 — a foreign key that is not our key has no notation · **GAP**

A correspondence between their identifier and ours can be stated nowhere; `mappings=` is a rename and
cannot cross types. Currently survives only as example data on a GWT.

### A10 — `Program.cs` is `emit`, so two runtime settings cannot be reached · **GAP**

Same class of bug as the read-model registrations, which were fixed by giving them a scaffold. If a
decision has no scaffold to live in, the generator is making it.

### A6 — a rule cannot choose its HTTP status · **GAP**

`Rejections.Problem` hard-codes 400. **Reconciled with Y1** (2026-08-09): a status code is *not* model
content and must never get notation — so this is a `codegen`/`architect` concern about how a decider
reports, not a missing attribute. Recorded so the two findings stop appearing to contradict each other.

---

## 3. Noise and cosmetics

### T4b — `VIEW WITH NO REGISTRATION` cannot tell "forgot" from "deliberately not a projection" · **NOISE**

A live-aggregation view is correctly unregistered and reported anyway.

### AD6 — `mapping-crosses-types` fires on every rename between a screen and a command · **NOISE**

A screen's `string` input legitimately becomes a typed command field.

### Z3 — a screen and a read model sharing a label resolve to whichever comes first · **NOISE**

### AD20b — the back-channel is not drawn differently · **NOISE**

Dilger draws the tick-off edge (`Event → todo View`) **dashed**, *"to indicate that this is not part of the
Flow but just updating the data of the Read Model."* The kit's grammar already permits that edge — it is
the single `Event → View` exception — but does not distinguish it. A real reader aid on a busy automation.

### BL4 — `architect.mjs` and the reference-implementation layout disagree about where things live · **NOISE**

`architect` reads `<project>/diagrams/` and writes race tests into `<project>/generated/<System>/tests/…`.
A reference implementation keeps its model in a named folder (`allocation/allocation.drawio`) and its code
in `generated/{src,tests}` — so **both halves need a scratch project and a copy back**, which is
undiscoverable and was rediscovered this run. `codegen.mjs` already takes the model path explicitly;
`architect` could take the same argument. Recipe, until it does:
`reference-implementations/reservation/README.md`, *Running it*.

### BL5 — the view scaffold's doc comment hard-codes "registered INLINE in Program.cs" · **NOISE**

Every generated view says *"Multi-stream projection, registered INLINE in Program.cs"* whatever lifecycle
`ViewRegistrations` actually emits — so three views in `reservation/` claimed Inline while being registered
Async. Two errors in one sentence: the lifecycle is not read from the registration, and **the registration
has not been in `Program.cs` since it moved to the `ViewRegistrations` scaffold**. Cosmetic, and it is the
comment a reader trusts when deciding whether a test must wait.

### BL6 — `cross-stream-rule` cannot tell a CONTEXT given from a DECIDING given · **NOISE**

On `reservation/` it fires on **8 of 15 GWTs** and exactly one (`gwt-reserve-3`) is genuinely contended.
The rest either read a value nothing ever rewrites (`capacity`, written once by the create slice) or name a
prior event for *context* while the fact that actually refuses the command sits in the stream the command
appends to. Each still costs a decision, a reason and a cost in `ARCHITECTURE.md`, which is how the one
that matters gets skimmed. A cheap improvement: rank a question below the others when every GIVEN outside
the appended-to stream comes from a stream with a single writing slice.

### BL7 — `terminal=` has no kind for a value the WORK answers · **OPEN**

`Grant Refused.reason` is the executor's verdict — not `actor`, not `clock`, not `const`, and not really
`generated` either, which is what it had to be declared as. A `result` kind would fit. One model wanting
one is not a case for adding it; recorded so it is a decision rather than an omission.
`reference-implementations/reservation/`.

### Z7 / T6 / W4 / W5 / B5 — smaller things, recorded not fixed

→ [detail](KIT-HISTORY.md)

---

## 4. Open questions

### AD2 — is DCB needed, or does multi-stream aggregation suffice? · ***ANSWERED 2026-08-08***

**Neither, exactly: four mechanisms all work.** A guard row, a reservation row behind a unique index, an
advisory lock and DCB each hold a cross-stream invariant; a multi-stream aggregation **does not**, and the
control test proves the race reproduces deterministically without a guard. Three of the four need no
Marten 9. Kept here rather than moved to history because it is the question the `architect` step now
answers per project. Full comparison: `reference-implementations/cross-aggregate-invariant/`.

### The standing "to confirm with the human" list

→ [KIT-HISTORY.md, section D](KIT-HISTORY.md). Reviewed 2026-08-09; nothing in it blocks work.

---

## 5. Standing rules — measured, and they stay true

These are not bugs. They are the conclusions that survived, and each one is enforced somewhere.

| | Where it bites |
| --- | --- |
| **Where the kit and the critter-stack docs disagree, the docs win — and the kit is CHANGED** | audit *defaults and behaviour*, not API names: a wrong method name fails to compile, a wrong default ships |
| **A green build is not evidence** | all three Marten 9 breaks compiled at 0/0 and died at host startup. The gate is that the host *starts* |
| **The docs mirror is always current, so a kit a major behind disagrees with its own reference** | a version bump is maintenance of the docs contract, not just the packages |
| **Never assert an invariant on a read model** | the race that breaks the invariant corrupts the view too, in the flattering direction |
| **A race test with no control proves nothing** | "the guard worked" and "the race never reproduced" are the same green |
| **`Store()` cannot conflict** | it supplies the version the entity already has. `UpdateRevision(doc, doc.Version + 1)` |
| **Grep the package `.xml` before suspecting the version** | a wrong namespace can imitate a wrong version, never the reverse |
| **The generator does not reach backwards** | a fix reaches new files only; scaffolds are kept. Add a *report*, not a rewrite |
| **Determinism holds across runs and model tiers** | three independent runs produced byte-identical `emit` output |
| **Concurrency, security, transport and status codes are NOT model content** | both books; asking for notation is answered, not built |
| **A saga is an implementation of an automation slice** | the todo-list View is the notation; neither author forbids a saga underneath |
