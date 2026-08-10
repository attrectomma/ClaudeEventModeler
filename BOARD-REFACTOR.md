# The board refactor — following the books, and what it costs

> **START HERE. This file is the whole brief — there is no separate handoff.**
>
> Read in this order: **`CLAUDE.md`** (loads automatically — the grammar, palette, layout grid, cell-data
> schema), then **this file**, then **`reference/BOOK-INDEX.md`** before asserting what a book says.
> `KIT-FINDINGS.md` carries 22 open findings with a `kit` / `modelling` / `environment` cause on each; **V19
> closes by construction** when step 6 lands, and V20 is the one to re-read before touching journeys.
>
> **State at handoff (commit `7f680ce`):** everything green and committed. Voltway — 23 slices, **190 tests,
> 0 skipped, build 0/0**, both models validating at 0 errors / 0 warnings and stamped `mode="demo"`, two
> backend chapters-formerly-journeys passing, all 7 screens ported and dark. Five reference implementations
> and the cart fixture all at 0 errors.
>
> **Not started, and deliberately out of scope for this refactor:** `ui-journey` has never been run;
> `register-driver`'s race test still needs the V11 retrofit; no estate view carries a site *name*.

**Decided 2026-08-10.** The books are the source of truth for the method (see CLAUDE.md, *"When the kit and
the BOOKS disagree"*). This file scopes the refactor that decision requires, honestly, before any of it is
built. It is a plan, not a record of work done.

---

## 1. What the books actually say, with citations

| # | Source | What it says | What the kit does today |
| --- | --- | --- | --- |
| 1 | `UES` ch. 18 (5813) | *"It is perfectly fine to have more than one model on a board. In fact, this is the rule rather than the exception for me."* | **one `.drawio` per model.** `context=` must match the filename |
| 2 | `UES` ch. 18 (5824) | *"I use a pink sticky note placed on the left side of each model to properly name it."* | ✅ the model cell — but it duplicates the filename rather than being the only identity |
| 3 | `UES` ch. 18 (5781) | **Chapters and sub-chapters** — blue arrows in two layers **above** the model, grouping slices. *"a chapter defines kind of a context for a given slice"*. Learned from Dymitruk | **deliberately not built**; CLAUDE.md says *"prefer splitting"* |
| 4 | `UES` ch. 18 (5862) | *"If there are alternative flows for a certain slice, I place a **marker below the slice with a link to a different model on the board**."* | nothing. Alternative flows are a separate file with no link |
| 5 | `UES` ch. 5 (2550) | *"From the perspective of the cart-system, this is an **integration event** and serves as a contract with external systems."* — and it is *"a different event category than the Domain Events we use internally"* | `public="true"` **re-uses a domain event** across the boundary |
| 6 | eventmodeling.org | *"Each specification must be tied to **exactly one command or view**."* | `em="journey"` — a specification spanning several slices. **A kit invention** |
| 7 | `LEB` ch. 9 (516) | *"In my models Slices are typically surrounded by a **black border**. Slices that just mimic information flow aren't."* | nothing; `codegen` would try to generate a foreign slice |

## 2. The one departure that causes the others

**A board holds many models. The kit made one file per model.** Almost every cross-model limitation follows
from that single choice:

- **V19** — a journey cannot span two models, because two files are two coordinate spaces and there is no
  bar to draw. On a board this is not a feature request, it is a rectangle.
- **Alternative flows** cannot carry the book's link marker, because there is nothing to link *to* within
  the file.
- **Chapters** could exist today but would stop at the file edge.
- ~~`_context-map.drawio` exists **only** because the models are in separate files. On a board, the context
  map is the board.~~ **OVER-STATED, corrected at step 4.** A board shows both models; it does **not** show
  what crosses between them. An import is a yellow external carrying `from=`, with **no line to its
  producer** — and a cross-region edge is now an *error*. So the map remains the only artifact showing the
  import graph at a glance. It becomes genuinely redundant only when step 6's `contract=` makes the boundary
  explicit and drawable.

**So the refactor is one change with a long tail, not seven changes.**

## 3. Scope — what has to move

### 3a. The board itself (the large piece)

A model becomes a **region** of one canvas, identified solely by its model cell. Every y the kit derives —
lane tops, swimlane bands, routing corridors, the GWT band — becomes **relative to the model's origin**
rather than to the page.

| File | What changes |
| --- | --- |
| ~~`tools/model.mjs`~~ | ✅ **DONE, step 2.** And the estimate here was **wrong in a way worth keeping**: it said *"every geometry derivation offset by region origin"*. Measured — `model.mjs` has **zero absolute coordinate constants**; all ~20 geometry uses are containment (`mid >= lane.y && mid <= lane.y+lane.h`), relative comparison (`to.x >= from.x`) or extent (`max(x+w)`). **No geometry maths changed at all** — the change was purely partitioning cells into regions and running the existing pipeline per region. CLAUDE.md's layout section already said this (*"`model.mjs` derives everything from geometry and never hard-codes a y"*); §3a contradicted it and the measurement resolved it in CLAUDE.md's favour. **§4b's "the `runOne`/`systemRules` split IS the refactor" was exactly right.** |
| `tools/slice.mjs` | every placement, insert-shift and routing allocation is absolute-x/y today |
| `tools/crop.mjs` | already an x-window; needs a y-window or a region selector |
| `tools/drawio.mjs render` | one PNG per board is unreadable at two models; needs per-region export |
| `tools/model.mjs map` | `_context-map.drawio` may cease to exist |
| `tools/codegen.mjs` | **likely the least affected** — it already compiles every model into one IR and one test project |
| `tools/project.mjs` | `init` scaffolds `diagrams/<context>.drawio` |

### 3b. Additive, and cheap once the board exists

- **chapters** — `em="chapter"`, a `slices=` list, drawn above the model in two layers
- **the alternative-flow link marker** — a cell under a slice pointing at another model region
- **the black border** — a slice attribute saying *"not ours to build"*, which closes BOOK-INDEX gap 11 and
  stops `codegen` generating a foreign slice

### 3c. The two notation decisions — BOTH DECIDED 2026-08-10

#### DECIDED: `em="journey"` is retired and merged into `chapter`

eventmodeling.org: *"Each specification must be tied to exactly one command or view."* A journey is not a
specification in the books' sense, and `chapter` is the books' notation for grouping slices (`UES` ch. 18,
blue arrows in two layers above the model, learned from Dymitruk). **A journey is a chapter with a `then=`.**

So `em="chapter"` carries `slices=` (ordered) and an optional `then=`. A chapter with no `then=` is pure
structure — the book's original use. A chapter *with* one is what the kit called a journey and gets a
generated end-to-end test. **This removes an invented concept by adopting a book one**, which is the new
standing rule working as intended.

Consequence: `ui-journey` reads the same cell, as it always did. `journey-*` rules rename to `chapter-*`.

#### DECIDED: `public="true"` is retired, replaced by a real integration event

`UES` ch. 5: an integration event is *"a different event category than the Domain Events we use
internally"*. `UES` ch. 15 gives the exact recipe and it needs **no new pattern** — a read model, an
**automation** processor, a `Publish X` command, and the external event *"stored in another swimlane"*.
`UES` ch. 8 supplies the naming rule: ubiquitous language is **per context**, so the same word legitimately
means different things either side of the boundary.

**Logical boundaries are not physical boundaries, and Voltway is a modular monolith** — two contexts, one
deployable, one store. That is explicitly fine (`UES` ch. 8: *"You can have many different contexts within
one system"*). What is **not** fine is one context reading the other's internal events, because that is the
coupling of `UES` ch. 2 — *"one of the worst forms of coupling you can get… every change requires the
service to adapt"* — and it is a **logical** coupling that does not care how many processes you deploy.

Measured on this very kit: adding `withdrawnBy` to estate's `Bay Withdrawn` forced an edit to charging's
import **for a field charging does not use**. That is the leak, reproduced.

| | | |
| --- | --- | --- |
| **`contract="true"`** | on an event | the **published integration event** of its context. Its own swimlane. Produced by an `automation` slice — no new pattern |
| **`from=` must name a contract event** | on an external | importing a *domain* event becomes the error `import-of-domain-event`. **This single rule is what makes the boundary enforceable** |
| the consuming side | — | `pattern="translation"`, which already exists and is already built |
| ~~`public="true"`~~ | retired | it means *"another model may read my private notes"* |

**Two consequences that are the point rather than side effects:**

- **`event-shape-disagrees` inverts.** Today it enforces that a shared *domain* event keeps one shape
  everywhere — i.e. it **enforces the coupling**. It becomes a check on the **contract** event, which is
  what a contract check should always have been.
- **`codegen` gains per-context namespaces.** `Voltway.Estate.Contracts.BayUnavailable` for the published
  contract; `Voltway.Charging.BayWithdrawn` for charging's own translated event. Same word, different
  namespace, different meaning — `UES` ch. 8 — and it is what makes a later extraction a configuration
  change rather than a rewrite.

**The implementation half, which is the STACK's domain and not the books':** the publishing side must go
through **Wolverine's Marten-backed durable outbox**, not a direct projection of the other context's
stream. The book's minimum (store it in another swimlane, let the consumer project it) satisfies the
*model* but leaves the consumer reading the producer's store, so extraction still means changing consumer
code. Sending it — a durable local queue today, a broker later — means **only configuration changes on
extraction**. The kit already emits `UseDurableLocalQueues()` and already scaffolds an ingest handler
(`Landing/Ingest<Event>Handler.cs`), so the machinery exists.

**The cost, accepted with eyes open:** roughly **two extra slices per direction per boundary** (publishing
automation + consuming translation), and every cross-context read becomes a message hop rather than a
projection. Voltway has estate→charging (bay lifecycle) and charging→estate (energy), so ~4 slices.

### 3d. Migration — the hidden cost

**Six model sets must move and keep validating**, and one of them is the regression suite:

| | |
| --- | --- |
| `DemoAllPatterns` | 2 models, 23 slices, 2 journeys |
| `reference-implementations/` | state-change, state-view, automation, translation, reservation, cross-aggregate-invariant |
| `tools/fixtures/cart/` | **the regression suite.** `cart-replay.mjs` builds it in nine successive appends and must be byte-identical on re-run — that script is written against the current geometry and would be rewritten |

## 4. Sequencing

**All notation decisions are made (§3c). This is now an implementation plan.** Each step ends green, so the
refactor can be stopped between any two.

1. ~~Decide 3c~~ — **done 2026-08-10.**
2. ~~`model.mjs` reads a board~~ — ✅ **DONE.** **A region is a horizontal band between consecutive model
   cells**, the first unbounded above and the last unbounded below; a cell joins the region containing its
   **midpoint** — the same test `laneOf()`, the swimlane bands and the actor bands already use, one level
   up. Two properties carry the whole design: **the partition is total** (no gutters, so no cell can fall
   through and become invisible to every rule — measured, 259 elements in, 259 out), and **the one-model
   case is the identity function** (one anchor, or none, yields one region spanning `(-∞, +∞)`, which is
   every cell, which is what a whole file meant before). That is *why* the other six sets survive by
   construction rather than by testing.
   `tools/fixtures/cart/` could **not** be migrated in place: `cart-replay.mjs:146` `rmSync`s that folder and
   rebuilds it on every run, so a hand edit would be silently reverted — the exact failure shape the step
   guards against. The board fixture is `tools/fixtures/board/` instead: cart + drafting, combined by pure
   y-translation with namespaced ids, zero domain invention, both halves already-validated models.
3. ~~`slice.mjs` writes regions~~ — ✅ **DONE.** **Targeting is inferred, never flagged**: every command
   already names a fact that identifies its region (`--at`, `--aggregate`, `--actor`, `--slices`,
   `--from`/`--to`, `--band`), so a `--model` would be a second place that fact lives. `swimlane` and
   `actorlane` are the honest exception — a new band names a stream on no cell yet — so those two ask.
   Commands that span two regions **refuse** rather than pick the first.
   **The geometry is asymmetric, and that is the whole story of the step:** vertical growth **crosses**
   regions (a region growing downward must carry every region below it — and because `shiftY` is *rigid*,
   the distance between consecutive anchors never changes, so no cell can be reassigned — arithmetic, not a
   test result); horizontal growth **never** does (regions share the whole x range, so `shiftX`/`widen` are
   region-scoped and a board is as wide as its widest region).
   **A pre-existing bug surfaced here and is now KIT-FINDINGS V23** — two parsers over one file, the writer's
   being strict enough to *delete* what it cannot match. `assertNothingDropped` turns that into a refusal.
   **Fix V23 before step 4**, because step 4 reformats every `.drawio` in the repo.

3b. **Extract one parser** — `model.mjs`'s tolerant parser becomes the only one; `slice.mjs` uses it. This is
   V23's cure and it is a prerequisite for step 4, not a nicety.
4. ~~Migrate~~ — ✅ **DONE.** `cart-replay.mjs` now **generates** a two-region board (cart + the book's own
   `submit-cart-error` alternative flow, `UES` ch. 18 — *"if a customer fails to submit a cart three times
   due to technical issues, the cart process is aborted"*, so nothing was invented). Region 2 is created
   **before round 1**, so all nine rounds run against a board and region targeting is exercised by the whole
   replay rather than a postscript. Voltway's two files became `diagrams/voltway.drawio`, two regions —
   **117 findings before, 117 after, identical both directions**, and `generated/` **byte-identical**, which
   tests rather than asserts the assumption that `codegen` reads the IR and does not care.
   **The five reference implementations were deliberately left as one-model files**, and the reasoning is
   the point: each is a worked example of *one pattern in one context*, so a second region would mean
   inventing a second context; and a one-model file **already is** a one-region board, so there is nothing
   to migrate and nothing being skipped.
   `slice.mjs model` was added because nothing in the kit could **create** a region — step 2 taught the
   reader to see many models and step 3 taught the writers to work in one, but a board could still only be
   made outside the kit.
5. ~~Additive notation~~ — ✅ **DONE.** `em="chapter"` (`UES` ch. 18) is **one cell with two uses split on a
   single attribute**: no `then=` is pure structure, the book's own use; a `then=` makes it what the kit
   called a journey and it gets the generated end-to-end test. Chapters occupy the strip **between the model
   cell and the UI lane** — "directly above the Event Model" cannot mean above the pink sticky, and must not,
   because a bar above the model cell would fall into the *previous* region (step 2's partition). `--layer
   1|2` is supported; **no nesting rule was invented**, because the book states none.
   **The retirement is enforced, not assumed**: `em="journey"` was being silently absorbed as an ordinary
   element, so it is now the error `chapter-was-journey`, following the `slice-unknown-pattern` precedent
   from the `state-change` rename — and it caught a journey cell in `campaigns` that would otherwise have
   been missed.
   **Where the rename deliberately stops:** the IR field stays `journeys` and the generated test file stays
   `<Name>JourneyTests.cs`, because both are `scaffold` — renaming would orphan the filled ones and write
   empty ones beside them. So the model says *chapter*, the code says *journey*, and `codegen` and
   `uijourney.mjs` needed **no change at all**: `generated/` diff is 0 files.
   `alt="<context>"` on the slice cell is the link marker (`UES` ch. 18) — an *attribute* rather than a cell,
   because the book's marker carries exactly two facts and geometry already supplies the third. The link is
   **checked**, because a link resolving to nothing reads as *"the error case is modelled over there"* when
   it is not.
   `external="true"` is the black border (`LEB` ch. 9), **with the book's polarity deliberately inverted**:
   Dilger borders what *is* ours, but encoding that as `ours="true"` would make every existing slice need an
   attribute to keep its current meaning, and a missing one would silently reclassify a slice as foreign —
   the failure direction that matters, since `codegen` would stop generating it. Silence still means ours.
   It sets `generates: false` and so actually stops `codegen` doing what ch. 9 warns against (BOOK-INDEX
   gap 11, now closed).
6. **The integration-event change.** Items 1–2 ✅ **DONE**: `contract="true"` with its own swimlane
   (`contract-in-domain-band`), and `import-of-domain-event` as the rule that makes the boundary
   enforceable. **The un-migrated case gets its own warning** — `context-publishes-no-contract`, naming the
   producer and its consumers — because until a producer publishes a contract there is nothing to point a
   consumer *at*, so the error would have no referent. Voltway sits at **0 errors, 2 warnings**, and those
   two warnings **are** the step-6e worklist: self-migrating and never silent. `public="true"` is deprecated
   but still resolves an import, because retiring it in the same step that introduces `contract=` would
   break every model before a replacement exists.

   **THE REMAINING ORDER WAS WRONG IN §3c AND IS CORRECTED HERE.** It listed the namespace change and the
   `event-shape-disagrees` inversion as peers of the re-modelling. They are not: 3 depends on 4, and **5
   dissolves both**.

   | | |
   | --- | --- |
   | **6e — re-model Voltway's boundaries** | ✅ **DONE**, on branch **`wip/6e-remodel`** — **0 errors, 0 warnings, 27 slices**, all three boundary rules silent, and the only imports are the **3 contract events** plus the 2 genuinely foreign Kempworth ones. **190 → 202 tests, and none of the 190 regressed**; the 12 new ones are unimplemented scaffolds, which is the documented output. **The check that mattered passed**: `HoldBayState` was offered 13 event types and is now offered 7 — `BayCommissioned`, `BayWithdrawn`, `BayReturnedToService`, `FaultReported`, `JobCompleted` and `ServiceScheduled` all stopped crossing, and `reason`, `withdrawnBy`, `withdrawnAt` and `sessionId` do not cross at all. **6 slices against ~4**, every one a publisher or a translator: two contract events estate→charging need two `Publish X` commands, hence two publishing slices and two matching translations. Net +4, because the two upstream feeds were dropped — and the *surface* shrank, 5 domain events crossing becoming 3 contracts. **Still hand-owned before merge:** six now-dead `Apply` overloads in `HoldBayState.cs` and siblings (scaffolds, so `codegen` kept them), and 12 deciders for the `codegen` skill to fill. |
   | ~~6e — earlier attempt~~ | **STARTED, then stopped and reverted — deliberately.** All 6 slices are built and wired on branch **`wip/6e-remodel`** in the project repo, with `.6e-wip/README.md` recording the decisions. `slice/hold-bay` is green and untouched at 23 slices / 190 tests. **What remains is measured, not estimated: 64 GWTs across 20 of the 23 slices name an event that has now crossed the boundary**, each needing its `given=`/`then=` rewritten onto the consumer's label, plus the remaining view-source rewiring. That is the `UES` ch. 14 / ch. 16 ripple and it is the *correct* consequence of the boundary being real |
   | 6c — invert `event-shape-disagrees` | **probably unnecessary afterwards.** The rule fires when one label has two field lists; with no shared labels it never fires. At most it narrows to contract events |
   | 6d — per-context namespaces | **cosmetic once 6e lands**, not a collision fix. Still worth doing for the extraction story. Cost is 46–96 hand-owned scaffolds depending on whether *all* events move or only cross-context ones — **pin that scope before starting** |

   **6e does not depend on 6c.** A consumer importing a *contract* event exercises the existing
   `event-shape-disagrees` correctly: one producer, one shape. The rule works unchanged.

   Measured to establish all of the above: 5 cross-context labels (7 total, minus the 2 genuinely foreign
   Kempworth events), and 96 of 109 hand-owned scaffolds referencing `Voltway.Contracts`.
7. **V19 closes by construction** — the cross-context chapter is a rectangle on a board. Draw it, walk it,
   make it pass. **NOT STARTED.** The refactor unblocked it; nobody has drawn it. Only two chapters exist,
   both single-context.

---

## 6. Owed after the merge — named, not discovered

6e is **merged and green** (202 tests, 0 failed; model 0/0 at 27 slices; `design.mjs check` 0/0). These are
the things it did **not** do, each of which someone will otherwise find the hard way:

| | |
| --- | --- |
| **The read side was never migrated** | `AvailableBays` still folds `BayCommissioned`/`BayWithdrawn`, `BayUsage` still folds `ChargingStopped`, `ChargePointDirectory` and `SitePrices` still fold estate's events. **The model says otherwise.** Same leak the contract exists to close, one layer over — and the reason 3 of `HoldBayState`'s folds could not be re-pointed in isolation |
| **The three publishing automations are unwoken** | `AUTOMATION NOT WOKEN`. Two are straightforward; `BayContractData` needs a `CustomGrouping` because it is keyed by `bayId` but needs fields from `Site Opened`, which carries only `siteId`. The generator left `Identity<SiteOpened>` commented with the reason rather than guessing |
| **`ARCHITECTURE.md` has no section for any of the six** | `architect.mjs check` reports 51 unrecorded questions, 15 against these slices. The other 36 predate 6e |
| **Three bands, one physical stream** | `Bay`, `EstateContract` and `ChargingContract` all declare `identity="bayId"`. Filed as **V27** — the "own swimlane" is a drawing, not a separation, and contract writes contend with domain writes on one version sequence |

**Also forced by the board and now landed:** `architect.mjs`, `uijourney.mjs` and `design.mjs` all compiled
per *file*, which broke the moment a file became a board — step 2's guard firing loudly, as designed.
`compile --per-model` returns an array of per-region IRs, one entry for a one-model file. A separate flag
rather than relaxing `compile`, because the two answers have different shapes.

**Order note:** step 6 is deliberately after the board rather than before it, even though it is the more
important correctness change. Reason: it *adds slices to two models*, and doing that while the geometry is
being rewritten means debugging both at once.

## 4b. Where the work actually is — line numbers, so a fresh session does not grep blind

Accurate at commit `7f680ce`; treat as a starting point, not gospel.

| | |
| --- | --- |
| `model.mjs:66` `firstDiagram(xml)` | **the single most load-bearing function for step 2.** Throws *"no `<diagram>` element found"*; today it returns **one** diagram and everything downstream assumes one model in it |
| `model.mjs:77` `geometryOf(chunk)` | every absolute x/y read in the validator |
| `model.mjs:352` `buildIr(file)` | file → IR. Takes a **file**, and that signature is the refactor in miniature: it becomes region → IR |
| `model.mjs:2248` | the page emitter — `pageWidth`/`pageHeight` computed from content bounds |
| `model.mjs:2345` `runOne(f)` | **the per-model pass.** On a board this becomes per-*region* |
| `model.mjs:2399` `systemRules(models)` | **the cross-model pass.** On a board these become *within-file* rules |
| `slice.mjs:37–53` | every geometry constant in one block: `COL_PITCH 320`, `EL_W 180`, `EL_H 60`, `SCREEN_W/H 200/240`, `SLICE_W 220`, `LANE_X 40`, `BAND_*`, `GWT_*`, `ACTOR_*` |

**The `runOne` / `systemRules` split IS the refactor.** Today: one file = one model = one `runOne`, and
`systemRules` compares across files. On a board: one file = many regions = many `runOne`s, and `systemRules`
compares regions *inside* one file. Nothing else about the rules needs to change — **32 rules across 12
families** (17 of them `completeness`), and none of them care how many models share a page, only which
model they are scoped to.

**A gotcha that will bite within the first hour:** `slice.mjs` **reserialises the whole file** on write, and
its serializer puts `id=` **last** on an `<object>` — where hand-authored cells have it first. So an `Edit`
anchor captured before a `slice.mjs` run will silently stop matching after it. Observed once, this session,
on `estate.drawio`. Re-read the cell after any tool write before anchoring an edit on it.

## 5. Verification, and the one thing that must not be taken on trust

Every step: `node tools/model.mjs validate` at **0 errors, 0 warnings** across Voltway, all five reference
implementations and the cart fixture — and `node tools/fixtures/cart-replay.mjs` byte-identical on re-run.

**The trap this kit has hit repeatedly and will hit again here:** a check that goes *quiet* is
indistinguishable from a check that passes. Five findings this run were of that shape (V5, V9, V13, V17,
V18). A geometry rewrite is the ideal conditions for it — rules that silently stop matching because a
coordinate moved. So for each rule family, **prove it still fires** by breaking one model on purpose, not
merely that it stops complaining.

## 5. What this is not

- **Not a reason to stop using the kit meanwhile.** Voltway is green at 190 tests and its models validate;
  nothing here breaks it until step 4 touches it.
- **Not licence to re-litigate the stack.** The books govern the method. Marten/Wolverine/Alba behaviour is
  still settled by `reference/llms/`.
- **Not a rewrite.** `codegen.mjs` — the largest tool — is barely touched, because the IR already unifies
  every model in the project into one system.
