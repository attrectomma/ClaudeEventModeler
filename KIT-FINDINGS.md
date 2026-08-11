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

## Severity says how bad. CAUSE says whose problem it is, and they are different questions

Most of this kit's runs are **demo-mode** models — the domain answers roleplayed rather than given by a
domain expert (`event-model`'s `mode=`, stamped `mode="demo"` on the model cell, printed by `validate`). That
makes modelling mistakes routine, and **a modelling mistake is not a kit defect**: a bad model cannot be
rescued by `architect` or `codegen`, and a human expert in the loop would have prevented most of them at the
moment the question was asked.

So every finding carries a cause as well as a severity:

| | |
| --- | --- |
| **`kit`** | the tool, the check, the generator or the grammar is wrong. **These are the file's real content** |
| **`modelling`** | the model was wrong or silent, and the kit behaved correctly. **Belongs in the project, not here** — see the section below |
| **`environment`** | the machine, the shell, a stray process. Real, costly, and nobody's design fault |

**A finding stays `kit` even when a modelling mistake is what exposed it.** That distinction is the whole
point and it is easy to get backwards. `V10` was found because a todo View was missing a supply edge — a
plain modelling error a real expert would have caught in seconds — but the *finding* is that the completeness
check cannot tell a supply edge from a tick-off edge, and **that rule was absent whether or not anybody drew
the edge**. The bad model was the **detector**, not the defect.

**Measured across the Voltway run: 0 of 18 findings are `modelling`.** That is not the kit being flattered —
it is the useful result. Roleplayed models produce plenty of domain errors, and those errors were
overwhelmingly *caught* (by the completeness check, by an implementing agent needing a value, by a mutation
that survived). What they did was walk the kit into corners a correct model never reaches, which is precisely
why a demo run is worth doing. Four findings — **V10, V13, V17, V18** — exist only because the model *changed
under a check*, and that is the kit's weakest axis.

### Modelling debt from the Voltway run — recorded here so it is NOT counted as kit findings

None of these are defects in this kit. Each is a question a human domain expert would have answered during
phase 5 or 9, and each cost an implementation round instead. They live in
`C:\Repos\Attrecto\DemoAllPatterns` and would move with the project.

| What was missing | How it surfaced | Cost |
| --- | --- | --- |
| `Bay Withdrawn` said **who** withdrew a bay | a fold had to *infer* it; wrong for a hand-withdrawal during an open fault | a model change, 19 call sites, 2 agent runs — and the same wrong guess reappeared in the UI |
| `SessionsToPrice` had no `Charging Started` feed | the implementing agent needed `driverId` and nothing supplied it | one edge; exposed **V10** |
| `hold-bay` had no *unknown bay* rule | two GWTs held an uncommissioned bay | 4 files, 1 iteration |
| `lapse-holds` had no rule for a hold since taken by another driver | all four existing rules used one driver | 1 GWT, 1 test |
| no GT put `Job Completed` in a GIVEN | **two mutants survived the whole suite** | 2 GTs, 2 hand tests |
| `LiveSessions` reused-bay behaviour | a mutant survived 58 charging tests | 1 GT, 1 hand test |
| the four fault categories are nowhere enumerated | derived from GWT example values | a derivation nobody signed off |
| no view carries a **site name** | every screen renders an elided GUID | still open |
| `endReason` declared non-nullable on rows that have no end | a session in progress has no honest value | 1 field change |
| the 12-month servicing half | in the brief, in no GWT | **unimplemented**; needs 4 undeclared facts |
| **nothing raises a technician's JOB when a bay is withdrawn for faults** | the first journey ever walked through `complete-job` — it could not reach step 4 | **the worst one.** An auto-withdrawn bay has no job to close, faults never cleared, and no way back onto the network. Green across 174 slice tests. Exposed **V20** |

**The pattern in that table is one thing: rules that only bite on the SECOND instance.** One driver, one
fault, one session, one withdrawal — every gap above is a scenario the model exercised exactly once. That is
worth knowing for production mode too, because a human expert asked *"and what if there are two?"* answers it
immediately, and nobody asks it unprompted.

---

## 1. Wrong output, silently — fix these first

These pass every check the kit has. That is what makes them the top of the list.

### V10 — the completeness check cannot tell a SUPPLY edge from a TICK-OFF edge, so a todo View can be "sourced" by its own output · **BROKEN**

**A todo View passed the completeness check while being fed, for two of its fields, by the automation's own
completion event.** `SessionsToPrice` declares `driverId` and `pricePerKwh`. Its drawn feeds were
`Charging Stopped` — which carries **neither** — and `Session Priced`, which carries both and *is the event
the automation appends when it finishes the row*. The check is name-based, both names resolved, zero errors.

**A row fed only by its own completion could never be built in the first place.** The automation cannot issue
its command without `driverId`, so it can never emit `Session Priced`, so the field is never supplied — a
circular source the check reads as a satisfied one. Found by the implementing agent, which needed the value
and discovered nothing supplies it; confirmed on the model, where `Charging Started` (carrying both) had no
edge at all. Fixed in Voltway by drawing the missing edge.

**The notation to fix it with is already on the canvas.** Dilger draws the tick-off edge dashed — *"to
indicate that this is not part of the Flow but just updating the data of the Read Model"* — and CLAUDE.md
records that convention as understood but **not adopted**. Voltway's `Session Priced → SessionsToPrice` edge
is *already drawn dashed grey*, by eye, carrying no meaning. Adopting it as notation turns a cosmetic reader
aid into the check: **an edge marked as a tick-off supplies nothing**, and a field whose only source is one
is unsourced.

That upgrades the earlier judgement. The kit had filed the dashed line under "cosmetic, and a real reader aid
on a busy automation slice"; it is the missing half of the completeness check on every automation and
translation slice in the kit, which is the pattern family where the source of a field is hardest to see.

**Suspect every automation and translation slice already built**, not just this one — the check has never been
able to see the difference, so nothing that passed proves anything here.

### V23 — ~~two parsers read one file, and the stricter one DELETES what it cannot match~~ · `kit` · ***FIXED — moved to [KIT-HISTORY.md](KIT-HISTORY.md)***

**It was three parsers, not two** — `wireframe.mjs` carried the same 8-space `BLOCK_RE` and the same
delete-on-write defect. Cured at the root: `tools/drawio-xml.mjs` is now the only parser and all three read
through it. Full entry, including what the shared parser had to be that neither original was, is in the
archive.

<!-- ARCHIVED BELOW — kept only until the next tidy-up; the authoritative copy is in KIT-HISTORY.md.

`model.mjs` and `slice.mjs` both read `.drawio`, with **different parsers**, and only one of them writes.

- `model.mjs` parses indentation-agnostically. It reads almost anything draw.io emits.
- `slice.mjs`'s `BLOCK_RE` anchors on **8-space indentation**, and **every write rewrites the whole `<root>`
  from the blocks it matched.** So a cell it does not match is not merely unparsed — **it is deleted**, with
  no error and no diff anybody reads.

**Measured, and the divergence is the finding.** De-indent one `<object>` by four spaces in a two-region
board and then, on the *same file*:

```
model.mjs validate  ->  0 error(s), 6 warning(s), 25 note(s)   2 models / 13 slices / 58 elements
slice.mjs promote   ->  refused: 2 cell(s) are not in the 8-space layout this tool rewrites
```

**One tool says the file is perfect; the other says it cannot safely be touched.** Before the guard existed,
the second tool silently dropped both model cells — on a `promote`, which edits an *attribute* and touches no
geometry — collapsing a two-model board to one region. Nothing caught it: `validate` read the result and was
happy, because the cells it needed were the ones still present.

**`assertNothingDropped` (added in step 3) converts the silent data loss into a refusal**, and the refusal
leaves the file byte-identical — verified. That is the right immediate fix and it is **not** the cure: the
underlying defect is that one artifact has two readers with different tolerances, so a file can be
simultaneously valid and untouchable. Anything that reformats a `.drawio` — draw.io's own serializer on a
human Ctrl+S, a linter, a merge — can produce that state.

**Why this is the most dangerous shape in the file.** It is the *inverse* of the "check goes quiet" family
(V5, V9, V13, V17, V18): there, a check stops reporting a real problem. Here, a check **reports success on a
file the other half of the kit will destroy**. Both are silence in the place where a warning belongs; this one
also loses work.

The cure is one parser. `model.mjs`'s is already the tolerant, well-tested one, and `slice.mjs` already
depends on `model.mjs` for validation — extracting the parse and having both sides share it is the fix, and
it should happen **before step 4 migrates six model sets**, because step 4 is exactly a large-scale
reformatting of every `.drawio` in the repo.

-->

### V24 — `_context-map.drawio` is generated, regenerated by nothing, and excluded from the one check that would notice · `kit` · **BROKEN**

`model.mjs map` writes it. **Nothing ever runs `map` again.** It is not regenerated by `validate`, by
`compile`, by `codegen`, or by any skill's gate — and because it is a *generated* artifact its filename
begins with `_`, which is exactly the prefix `validate` uses to **skip** it. So the one tool that could
notice it has diverged is the one told not to look.

**Measured at step 4 of the board refactor:** regenerating it produced exactly one change — estate
`12 slices → 13`, `6 → 7 public events`. That drift predates the refactor; commit `e7d07a3` added the
`schedule-repair` slice and the map has been wrong ever since, through a full frontend build, two journeys
and 190 passing tests. **Nothing anywhere reported it**, and it is the artifact a newcomer opens first to
understand how the contexts relate.

**This is the "quiet on the second pass" family again** (V5, V9, V13, V17, V18) with a twist worth naming:
those checks go quiet because a rule stops matching. This one is quiet **by construction** — the exclusion
that keeps a generated file out of the validation set also removes the only thing that could tell you it is
stale.

The cheap fix is a staleness check rather than auto-regeneration: `validate` already builds everything the
map is derived from, so comparing the map's recorded counts against the live IR is nearly free, and
regenerating on every validate would churn a committed file. **Do not close it by deleting the map** —
step 4 established it is *not* redundant (a board shows both models but not what crosses between them), so
it earns its keep until `contract=` lands.

### V28 — `EnrichEventsAsync` is NOT invoked on an `Inline` projection: it compiles, boots, and silently does nothing · `kit`/stack · **BROKEN**

Marten's `EnrichEventsAsync` is the documented hook for a projection that must look something up before it
folds — the way a bay-keyed view reaches a fact carried only by a site-keyed event. Registered **`Inline`**
it is **never called**. No exception, no warning, clean startup.

Measured on Voltway's `BayContractData`, registered `Inline` under CLAUDE.md's own *"a todo View an
automation's liveness depends on must be `Inline`"* exception. The row appeared with `SiteName` at its
default, the publisher then **correctly declined to publish an incomplete contract**, and **the bay never
crossed the boundary**. Every per-slice test stayed green; only the cross-context journey caught it.

**This is the V2 / AD11 shape and now the third instance**, which makes it a pattern rather than a
coincidence: *a documented Marten member that is silently skipped in one lifecycle*. V2 was
`Task<T> Apply(TEvent, IQuerySession, T)` skipped on a multi-stream projection. AD11 was the
source-generated dispatcher with no runtime fallback. All three compile, all three boot, all three do
nothing.

**And it collides head-on with a kit rule.** CLAUDE.md requires a todo View an automation depends on to be
`Inline`, for a reason that is measured and correct — an `Async` todo list can be read empty while the
checkpoint moves past. But a todo View that *also* needs enrichment cannot be `Inline`, because enrichment
does not run there. **The two requirements are incompatible and nothing says so.**

Voltway's resolution — `Async`, safe *because* the wakeup is a clock rather than a subscription, so there is
no checkpoint to outrun — is correct here and does **not** generalise: the same view woken by an
`ISubscription` would reintroduce exactly the hazard the Inline rule exists to prevent. So the real rule is
three-way, and CLAUDE.md states only two of the legs:

| todo View needs enrichment? | woken by | lifecycle |
| --- | --- | --- |
| no | anything | **`Inline`** — the existing rule |
| yes | a **clock** | **`Async`** is safe: a sweep recomputes from the view every tick, so there is nothing to outrun |
| yes | a **subscription** | **no safe answer today.** Enrich on the producer side before publishing, or drop the enrichment |

### V27 — `contract-in-domain-band` enforces the DRAWING, not the separation: a contract band with the same `identity=` is the same physical stream · `kit` · **BROKEN**

`UES` ch. 15 says the contract event is *"stored in another swimlane"*, and `contract-in-domain-band` was
built to enforce it. It checks that a contract event sits in a band of its own. **It does not check that the
band has a distinct stream key** — and a band is a drawing, while `identity=` is what decides the stream.

Measured on Voltway immediately after 6e: `Bay`, `EstateContract` and `ChargingContract` **all declare
`identity="bayId"`**. Three bands, one physical Marten stream. The rule passed throughout.

**So the thing the rule exists to guarantee is absent while the rule reports success** — the "check that looks
like proof" family again (V1, V8, V11, V23), and the most expensive variant, because the reassurance is
strongest exactly where separation matters most.

**The consequence is concurrency, not tidiness.** Contract and domain writes share one version sequence, so
they contend. And that interacts with **V12**: the emitted retry budget is four attempts and each round lets
one writer commit, so **adding contract publishes to the domain stream reduces the effective concurrency
budget for ordinary domain writes**. Nothing reports it; the sequential GWTs cannot see it, and the race
tests target the domain rule.

The fix is a **model** change — a prefixed or composite key so a contract band's streams are distinct
(`contract-bay-<id>`, or `(kind, bayId)`) — plus the missing half of the rule: **a contract band's
`identity=` must not collide with a domain band's.** That second part is what stops the same mistake being
made again in the next project, and it is derivable today from the IR.

### V25 — `slice.mjs`'s attribute writer can APPEND a duplicate attribute, and the old value wins · `kit` · **BROKEN**

Setting an attribute that already exists can produce **two copies of it on one cell** rather than replacing
the first. `attrsOf` then lets the **last** occurrence win — so the *original* value keeps winning and the
write is a **silent no-op**.

Measured during step 6e: a rename pass appended a second `label=` to 15 cells. All 15 **looked** renamed in
the diff and none of them were; the `TODO:` placeholder kept winning. Validation reported the *symptom*
(`unsourced-attribute`, because a placeholder supplies no fields) and never the cause, so the trail led
into the model rather than into the writer.

**This is a hazard for anything that edits a `.drawio` attribute, not just that one script** — including
`slice.mjs`'s own `promote`, `demote` and `identity`, and any future migration pass. The failure mode is the
worst available: the file changes, the diff looks right, and the value does not move.

The fix is replace-or-append rather than append, plus a post-write assertion that no cell carries a
duplicate attribute — the same shape as `assertNothingDropped` (V23), which exists because this class of
silent write-failure has now bitten twice.

### V26 — `--pattern translation` places the imported external in the WRITTEN band, so the writer creates the condition its own rule warns about · `kit` · **NOISE→BROKEN**

`slice.mjs add --pattern translation` puts the foreign event in whatever band already exists — which, with
one band, is a band **we write to**. `external-in-written-band` then correctly warns that another system's
event is landing in a stream of ours.

So the tool **manufactures the warning it ships with**, and every translation slice needs a hand move into a
foreign band immediately after creation. CLAUDE.md already half-acknowledges this — *"`slice.mjs add
--pattern translation` puts the external event in whatever band already exists — with one band, yours"* — and
files it under why the rule is a warning rather than an error. That is backwards: the rule is right, and the
**writer** is what should change.

It matters more now than when it was written. Step 6 makes translation slices routine rather than rare: every
consuming context gets one per contract event, so what used to be an occasional hand-fix becomes a step in a
repeated recipe. A `--band` argument, or creating a foreign band when none exists, removes it.

### V21 — two GWTs sharing a rule name generate TWO METHODS WITH THE SAME NAME, and the scaffold does not compile · `kit` · **BROKEN**

`codegen` names each generated test method after the GWT's **rule**. Two GWTs sharing a rule name is legitimate
— the same refusal reached by two histories — and **the kit already depends on that in two places**: rejection
constants are deduped by rule name (the CS0102 fix), and `GWT COVERAGE CANNOT BE TOLD APART` exists *precisely
because* the situation arises. The method namer never got the memo.

Measured: `schedule-repair`'s `gwt-sr-1` and `gwt-sr-4` are two scenarios of `RepairJobIsRaised` — a bay the
system withdrew, and a bay a manager withdrew that still has faults. Both scaffolded as
`public Task RepairJobIsRaised()` → **CS0111**.

**This is worse than the other same-name findings because it breaks `scaffold`'s own gate.** That gate is
`dotnet build` at 0 errors, and it is the check that exists because two defects once shipped through exactly
this hole (W6, W9). A first-generation project whose model has two same-named GWTs on one slice **cannot pass
it at all** — the fix is a hand edit before the project has ever built once.

The fix is the same information the coverage report already uses: fall back to the **cell id** when a rule name
is not unique within the slice — `RepairJobIsRaised_GwtSr4`, or the scenario name a human would pick anyway.
Note the two reports then agree: renaming by scenario is what `GWT COVERAGE CANNOT BE TOLD APART` asks for.

### V22 — `RACE TEST NOT WRITTEN` is reported per GWT and satisfied per FILE, so one race test silences another GWT · `kit` · **BROKEN**

`raceFileName()` is `<Slice>ConcurrencyTests.cs` — one file per slice — while the report is raised per
contended GWT. So writing the race test that **one** GWT genuinely needs marks **every** contended GWT in that
slice as answered.

Measured: `schedule-repair` has two, and they need opposite treatment. `gwt-sr-2` (`RepairAlreadyRaised`) is
genuinely contended and got a real test. `gwt-sr-3` (`BayNeedsNoRepair`) is **not** — two callers both read
*not needed* and are both correctly refused, with no winner to elect — and `ARCHITECTURE.md` records the
deliberate decision not to write one. The implementer could not honour that instruction: writing the first
test silenced the second report automatically.

**So the record and the tool now disagree, and the tool is the one that goes quiet.** The refusal survives only
as prose in a comment at the head of the file. Two things follow: the check cannot distinguish *"answered"*
from *"answered for a different GWT in the same file"*, and there is nowhere to record *"deliberately no race
test here"* — the same missing acknowledgement that `joins="none"` and the `VIEW WITH NO REGISTRATION` comment
exist to provide elsewhere.

This is **V8 compounding**: V8 says the contention classifier flags GWTs that are not contended; V22 says that
once it does, you cannot even record the disagreement.

### V20 — nothing checks that a GWT's GIVEN is REACHABLE, so a slice can be fully specified and green against a past the system cannot produce · `kit` · **GAP**

**A GWT appends its own history, and that is correct** — a GIVEN *is* history. The consequence nobody had
named: **the history it appends is never checked against what the system can actually produce.** So a slice
can be modelled, generated, implemented, mutation-tested and green while its entire premise is impossible.

**Measured on Voltway, by the first journey ever written through that slice.** `gwt-cj-2`'s GIVEN is:

```
Service Scheduled(bayId=$Bay3, jobId=$Job1, reason=fault, energySinceLastServiceKwh=0)
```

— a job raised **by a fault, at zero energy**. No slice in the system produces that event: the only producer
of `Service Scheduled` is `service-due`, whose todo View is fed by `Charging Stopped + Service Scheduled +
Job Completed` (a fault can never make a row work) and whose decider refuses anything under 5 MWh with
`ServiceNotDue` — which is `gwt-sd-2`, *another GWT in the same model*. **Two GWTs in one system contradict
each other and both are green.**

The real-world consequence is not cosmetic: an auto-withdrawn bay has **no job to close, faults that are never
cleared, and no way back onto the network.** A technician can drive to it and have nothing to complete. 174
per-slice tests, several mutation rounds and a full `validate` at 0/0 all missed it, because every one of them
starts from a hand-appended GIVEN.

**Why the journey layer found it and nothing else could.** A journey is the only artifact forbidden from
appending, so it is the only place the question *"can the system reach this state?"* is asked at all. That
makes journeys much more than an integration nicety — **they are the reachability check**, and today they are
optional, manually invoked, and gate nothing.

**A cheap version exists and would have caught this one at model time.** Not full reachability analysis:

| | |
| --- | --- |
| an event in a GIVEN that **no slice emits** | already derivable — the IR knows every `emits` |
| a GIVEN whose example values would be **refused by the producing slice's own GWTs** | derivable where both carry example data, which is exactly the case here (`energySinceLastServiceKwh=0` against `ServiceNotDue` at `< 5000`) |
| anything needing real ordering or state | **not** attempted — that is the journey's job |

The first row alone is worth having and is nearly free. The second is the one that bites, and it is only
possible because `derived-without-example` pushed example data onto GWTs in the first place.

**Related but distinct from V19**: V19 says a journey cannot cross a model boundary; this says a journey is
the *only* thing asking the reachability question at all. Together they mean the kit's one reachability check
is both optional and unavailable at the seam where it matters most.

### V19 — ~~a journey cannot cross a model boundary~~ · `kit` · ***FIXED — moved to [KIT-HISTORY.md](KIT-HISTORY.md)***

**Closed 2026-08-11 by the board refactor, which existed for it.** A cross-context chapter now validates,
scaffolds and passes: `estate-to-driver` walks `open-site → commission-bay → publish-bay-offered` (estate)
then `translate-bay-offered → bay-availability → hold-bay` (charging), and **fails when the boundary is
broken**. Full entry in the archive.

<!-- ARCHIVED BELOW — the authoritative copy is in KIT-HISTORY.md.

The `journey` skill says it plainly: *"A journey belongs to the **system**, not to a slice, which is why
neither `codegen` nor a slice's own agent owns it."* The implementation binds it to a **model**. `slice.mjs
journey` resolves `--slices` against one file, and `model.mjs` agrees — `journey-unknown-slice` reads *"is not
a slice in **this model**"*, because `byName` is built per model inside the per-model pass.

At one model those two statements coincide, which is why five runs never noticed. At two they do not.

**Measured on Voltway.** The story worth walking most is *the estate opens a site and commissions a bay, and a
driver on the other side of the system finds it and holds it* — `open-site → commission-bay` (estate) then
`bay-availability → hold-bay` (charging). It is refused outright:

```
slice: --slices names "open-site", which has no slice cell.
```

**This is precisely where the journey layer earns its keep, and precisely where it is unavailable.** The three
failure classes the skill lists — an id minted in one shape and read in another, a projection current for its
own slice and stale for the next, a rule that only bites on the second command — are all *more* likely across
a context boundary than inside one, because the two sides were modelled separately, generated separately and
implemented by different agents. Voltway's contexts share one host and one event store, so the walk is
genuinely possible at runtime; nothing can express it.

**What it is NOT.** It is not the `Only an event crosses a model boundary` rule biting correctly. That rule is
about *coupling* — a consumer must not reach into a producer's read models or commands — and a journey reaches
into neither. It POSTs to each context's own public API in turn, exactly as a user would, and asserts a read
model of the context it finishes in. Nothing about it violates the boundary; the walk is the proof that the
boundary works.

**The awkward part is geometry, and it is the reason this is a GAP and not a bug.** A journey draws a bar
spanning the columns it walks, and two models are two coordinate spaces — there is no bar to draw. Three ways
out, in increasing honesty:

| | |
| --- | --- |
| draw it on the **finishing** model, allow foreign slice names, span only the local columns | cheapest; the bar then under-reports its own extent |
| put system-scoped journeys on `_context-map.drawio` | that file is **generated** and `validate` skips a leading `_`, so it would need to stop being generated |
| a `journeys.drawio` — one model-less file per system, holding only journey cells | consistent with *no manifest* only if journeys are genuinely system facts, which the skill already claims they are |

Until then a two-model system gets per-context journeys and **no composition test at the seam** — which
should be said out loud rather than left to look like coverage.

-->

### V18 — `design.mjs check` pools the design and the port, so the two can disagree and it stays quiet · **BROKEN**

The three-way check is documented as `displays=`/`inputs=` ↔ wireframe `binds=` ↔ **HTML `data-em`** — and the
third leg reads *both* `designs/<slug>.html` **and** the ported `.tsx`, then treats a binding found in
**either** as satisfied. So the two artifacts it exists to keep in step are pooled rather than compared.

Measured: `withdrawnBy` was added to `BayHealth` and to `bay-health`'s `displays=`, then implemented in
`BayHealth.tsx` only. `design.mjs check` went from **1 warning to 0** — the `.tsx` satisfied the binding on
the design's behalf — while **the reviewed design and the shipped screen now showed different rows**. Going
*greener* is the tell: the check improved as the artifacts diverged.

**This is the whole point of that folder.** `designs/<slug>.html` is the artifact a human signed off, and
`review.mjs sheet` puts it beside the built software so somebody can answer *"does this match what we
agreed"*. If the design silently stops being what the app shows, the sheet is comparing the app to a stale
picture and the check that should have said so is the one reporting zero.

**The fix is to check the legs separately**, and each has a different severity, which is why pooling them was
tempting and wrong:

| | |
| --- | --- |
| the model declares it, the **design** does not draw it | the design is behind — **warn**, it is what `design-field-missing` already means |
| the model declares it, the **port** does not render it | the port is behind — **warn** |
| **design and port disagree** with each other | neither is behind the model; the agreed artifact is now fiction — this is the case that has no finding at all |

Note `design-has-port` already knows both files exist — it prints one INFO per screen saying so. The
information needed for the comparison is present; nothing does the comparison.

### V17 — `wireframe.mjs scaffold` is all-or-nothing, so a `displays=` field added later can never be drawn by the tool · **BROKEN**

`node tools/wireframe.mjs scaffold <file>` answers *"wireframes already present — leaving it alone."* once any
screen has one. So the moment a screen gains an attribute — which is the normal way a model grows — the field
must be hand-placed, and hand-placing is **precisely the job the tool exists to do**: CLAUDE.md says it is a
tool rather than a hand edit *"because it touches every y and every routing point in the file"*.

Measured: adding `withdrawnBy` to `BayHealth` raised three `field-not-drawn` warnings, and the tool declined
all three. Placing them by hand meant reading the stack rhythm of three screen columns (22px, 18px and 20px
spacing, because the scaffolder packs N cells into a fixed screen height) and appending inside each — which
is exactly the arithmetic nobody should be doing by hand.

The fix is per-screen, per-field idempotence: draw the cells that are **missing**, leave the ones that exist
where the human put them. The refusal is protecting hand-arranged wireframes, which is right — it just
protects them by doing nothing at all.

> ### THE PATTERN BEHIND V17, V13, V9 AND V5 — THE KIT IS STRONG ON THE FIRST PASS AND WEAK WHEN THE MODEL GROWS
>
> Four findings this run are the same shape, and it is worth stating as one:
>
> | | first pass | after the model grows |
> | --- | --- | --- |
> | `wireframe.mjs scaffold` | draws every field | **refuses entirely** (V17) |
> | `GWT WITHOUT A TEST` | names every uncovered rule | **goes silent** on a new scenario for an existing rule name (V13) |
> | `ARCHITECTURE.md` premises | true when written | **stale, and indistinguishable from un-revisited** (V9, and two corrections this run) |
> | `status=` / baked `Skip` | correct at scaffold time | **frozen**, reporting Skipped where the gate needs Passed (V5) |
>
> The generator is **idempotent**; the *reports and helpers around it* are not. And a growing model is the
> normal case — ch. 14 and ch. 16 of *Understanding EventSourcing* are both about appending to an existing
> model, and `add-slice` exists for it. **Every check should be asked one question: what does it do on the
> second pass?** A check that only fails to help is tolerable; a check that goes *quiet* is not, because
> silence is indistinguishable from success.

### V16 — screens are ported one at a time into ONE Vite bundle, so an unscoped class silently restyles a screen nobody was working on · **BROKEN**

`frontend-agent` ports **one screen per run**, each with its own `.css` — and Vite concatenates every one of
them into a single document. So a class name that is obviously screen-local while you are writing it becomes
global the moment a second screen exists.

Measured: `BayFinder.css` declared `.bay { display: grid; padding: var(--s4) }`, entirely reasonable for a
list of bay cards. Two screens later, `<td class="bay">` in the operations console **and** in bay-health
picked it up and those cells dropped out of their table's layout. Neither screen's author wrote a line of the
CSS that broke it, and the screen that *owns* the rule renders identically either way — so the damage is
always in somebody else's file.

**Nothing catches it.** `tsc` is clean, `vite build` succeeds, `design.mjs check` passes at 0/0 — it is a
*field*-contract check and knows nothing about layout. The only artifact that shows it is a screenshot, which
is why *render it and look* is a gate rather than advice.

**The rule the kit should state and does not:** every screen stylesheet is scoped to a screen-root class, and
the design's own class names stay on the elements so `data-em` and the review sheet still line up. Cheap to
do up front, and it gets more expensive with every screen added — the first port has nothing to collide with,
which is exactly when the habit has to be set.

Belongs in `.claude/agents/frontend-agent.md` as an instruction, not just here.

### V15 — the React port keeps its OWN COPY of `tokens.css`, and nothing checks the two agree · **BROKEN**

`designs/tokens.css` is *"the ONLY place colour, type and spacing are defined"* — and then the frontend port
copies it to `generated/<System>/web/src/tokens.css`, so there are two. Measured: switching the design to a
dark palette changed every one of the 7 design pages and **none** of the running app, because the app reads
the copy.

**`design.mjs check` cannot see it.** That check is about the *field contract* — `displays=`/`inputs=` ↔
wireframe `binds=` ↔ HTML `data-em` — and it passed at **0 errors, 0 warnings** with the design dark and the
implementation light. Nothing in the kit compares the token files at all.

**The kit already has the right shape for this and did not apply it here.** `project.mjs palette` exists
precisely because three copies of the draw.io colour settings drifted, and its whole job is *"do the copies
still agree?"*. Design tokens are the same problem one layer up. The fix is either the same check
(`design.mjs tokens`, or fold it into `design.mjs check`) or removing the second copy — Vite can read a file
outside `web/` via an alias, and both folders live in the project, so a single source is genuinely available.

**Why it will bite quietly rather than loudly:** the one artifact that *would* have shown it is
`review.mjs sheet`, which puts the agreed design beside the built software at the same width. That is a human
looking at two pictures, not a check — so it is caught only if somebody runs the review and notices the
theme, and it is invisible to `tsc`, to the test suite and to every generated report.

### V13 — `GWT WITHOUT A TEST` matches by RULE NAME, so a new scenario for an existing rule is invisible · **BROKEN**

Two GWTs legitimately share a rule name — the same refusal reached by two different histories — and the kit
already depends on that elsewhere: deduping the generated rejection constants **by rule name** was the fix
for a CS0102 collision. But the coverage report matches the model's rules against the kept test file **by
that same name**, so once one scenario for a rule has a test, **every later scenario for it reports as
covered**.

Measured: `gwt-cj-5` was added to Voltway — a genuinely new scenario, and the one the whole `withdrawnBy`
change exists to make expressible — under the existing rule name `ManuallyWithdrawnBayStaysOut`. `codegen`
reported nothing. The scenario has no test and the report says the slice is fully covered.

**This is the same class as the report it sits next to and worse in one way:** `TESTS STILL SKIPPED ON A
CLAIMED SLICE` at least fires on a state the model can see. Here the model *grew* and the report went quiet.
The fix is to match on the GWT's **cell id** as well as its rule name — the id is already stable and unique
by construction, and it is what every other report in the kit names when it points at a cell.

Until it is fixed: **after adding a GWT to an implemented slice, check whether its rule name is already
used** before trusting a silent run.

### V14 — a stray `Voltway.exe` makes MSBuild fail at the COPY step, hiding every real compile error behind it · **ENVIRONMENTAL, worth knowing**

An agent that runs the app to prove an automation fires must stop it. One did not, and the leftover host held
`bin/Debug/net10.0/<System>.exe`. Every subsequent build then failed with `MSB3021`/`MSB3027` — *"the process
cannot access the file… locked by: Voltway (4664)"* — **after compiling the app project and before compiling
the tests**. So a genuine 20-error ripple in the test project reported as **2 errors**, both about copying a
file, and the summary line said `2 Error(s)` where the truth was 22.

The tell is `MSB3021` / `MSB3027` / `MSB3026` rather than a `CS` code. `Get-Process -Name <System>` then
`Stop-Process -Force`, and rebuild before believing any error count. Related to the standing rule that a build
in a shared tree is not a measurement — this is the single-agent version of it.

### V12 — the emitted retry budget is a system-wide ceiling on concurrent writers, and nobody has decided it · **BROKEN**

`Program.cs` emits `opts.OnException<...>().RetryTimes(3)` — **four attempts in total**. On a contended stream
each round lets exactly **one** writer commit, so the budget is not a margin, it is a hard limit on how many
callers may append to one stream at the same instant. Probed against a real suite:

```
writers=2 landed=2   writers=3 landed=3   writers=4 landed=4
writers=5 landed=4   writers=6 landed=4   writers=8 landed=6
```

**Above four simultaneous appends to one stream, work is silently lost as a 500.** Deterministic, not flaky.

**The damage is worst where the slice has no contended rule at all**, which is the opposite of where anyone
would look. `report-fault` has no rejection that depends on accumulated state — `architect.mjs` correctly
scaffolded no race file for it — but its stream is the Bay stream, **shared with the charging context**, so a
fault report races a hold, a charge start, a pricing and auto-withdraw. What a lost race costs there is not a
duplicate: it is *a real fault report the duty manager believes they filed*, on a bay that auto-withdraw takes
out of service at two open faults.

So the number is not a Wolverine tuning detail. It is a **system-scoped consistency decision** — how many
concurrent writers a stream must tolerate before a caller is told to try again — and it belongs in
`ARCHITECTURE.md` beside the rest of them. `architect.mjs` does not derive the question, and
`contended-invariant` currently says only *"the stream key contains the contested thing"*, which is true and
insufficient: it establishes that the loser is refused **correctly**, not that the loser is refused a
**survivable** number of times.

`Program.cs` is `emit`, so this cannot be fixed by hand in a project — it is the generator's, and the fix is
a cooldown (`RetryWithCooldown`) rather than a larger integer, since the failure mode is a thundering herd on
one row.

### V11 — the scaffolded race test RE-STAGES the mechanism instead of calling it, so it is blind to every mutation inside it · **BROKEN**

`architect.mjs tests` scaffolds a deterministic race test that opens two sessions and stages the append
**itself** — `session.Events.StartStream(claim, …)` — rather than invoking the slice's own guard. So it
proves *"`StartStream` collides"*, which is a fact about Marten, and proves **nothing about the code that
ships**.

Measured on `commission-bay`: mutant M5 replaced the claim's `StartStream` with `Append`, turning the guard
into no guard, and the scaffolded `ExactlyOneWriterWins` **stayed green**, as did all six sequential GWTs.
The only thing left standing between that and a broken invariant was an HTTP race, which the database may
serialise anyway.

**And it reaches backwards into a slice already called done.** `register-driver` has the same shape —
verified, not inferred: its race test stages `session.Events.StartStream(claim, …)` directly and never calls
`RegisterDriverMechanism`. Both of its uniqueness guards are therefore unpinned by the test written to pin
them.

The fix has been demonstrated: the implementing agent added `ExactlyOneMechanismCallerWins`, which drives
`CommissionBayMechanism.CommissionAsync` and uses the mechanism's own `afterRead` seam as the barrier, and
it fails against M5. **The scaffold should call the slice's guard through a seam, not reproduce it** — which
means the generator needs the mechanism to expose one, and that is the part not yet designed.

**PARTLY MITIGATED, and the mitigation names where the fault actually was: the INSTRUCTION.** The scaffold
said *"the same race with the guard in place"* and handed over a
`RaceAsync(n, (i, session) => { read, check, stage })` example — which reads as *copy what the mechanism
does into the callback*, and two slices did exactly that. `architect.mjs` now tells the implementer to call
the slice's own path, to **add a seam** to the mechanism if there is nowhere to put the barrier, and gives
the check that the test is real: *break the guard on purpose and watch this test go red*. **That removes the
invitation, not the possibility** — the generator still cannot write the call, because it does not know the
mechanism's name or shape. **`register-driver`'s existing race test is still the broken shape and is still
owed a retrofit.**

This is the same family as **V1** (a race test that passes for a non-reason) and **V8** (a race scaffold
generated from a non-contended GWT). Three findings now say the concurrency scaffolding produces tests that
look like proof and are not, which makes it the weakest generated artifact in the kit.

### Z5 — two labels that PascalCase to one identifier: one is silently dropped, and reported as `kept` · **BROKEN**

`Stock Level Set` and `StockLevelSet` become the same C# identifier. The second file overwrites the first
and the run reports it as `kept (already filled in)`, so the count looks healthy. **The report actively
lies here**, which is worse than the collision. → [detail](KIT-HISTORY.md)

### V9 — `architect` and `codegen` disagree about what "multi-stream" MEANS, so four Async views were never questioned · **BROKEN**

Two tools, two definitions, and the gap between them is silent:

| | decides multi-stream by |
| --- | --- |
| `codegen.mjs` (`isMultiStream`) | one feeding stream **and** `identity=` equal to that stream's key → single. **Otherwise multi** |
| `architect.mjs` (`const multi`) | `streamTypes.length > 1` — the count of feeding aggregate types |

A view fed by **one** stream but keyed by something **other than that stream's key** is multi-stream to the
generator and single-stream to the architect. `codegen` registers it **Async**; `architect` never raises
`stale-read` for it; nobody ever decides whether that staleness is acceptable.

**Measured on Voltway — four views, every one of them Async and unquestioned:**

```
CardDirectory          architect: single   codegen: ASYNC   never asked
ChargePointDirectory   architect: single   codegen: ASYNC   never asked
OpenSessions           architect: single   codegen: ASYNC   never asked
SessionsToPrice        architect: single   codegen: ASYNC   never asked
```

**Two of those are the correspondence lookups a translation resolves every foreign notice through**, so the
unasked question is *"can a charge arrive before the bay that produced it has projected?"* — which is
exactly the question the record should have forced. The implementing agents hit it anyway and answered it
in code; the record is silent.

**Wanted:** one definition, shared. `isMultiStream` already exists in `codegen.mjs` and is the correct one —
it is what actually decides the registration. `architect.mjs` should import it rather than re-derive a
weaker test. The general lesson is the kit's own: **two copies of a rule are two rules.**

### T1b — the ingest seam promised a retry that does not exist by default · **BROKEN** · ***comment FIXED, policy still not emitted***

The T1 fix — a foreign event arriving as a message on a durable local queue — shipped with a scaffold
comment saying the envelope is *"persisted on arrival, **retried if this throws**, and dead-lettered if it
keeps throwing."* **The middle clause is false as generated.** Wolverine moves a message to the dead letter
queue when it *"exhausts all its configured retry/requeue slots"*, and a project with no policy configured
has none — so the **first** throw dead-letters.

**Found by implementing `translate-charge-start`**, whose translator refuses a notice it cannot resolve on
the assumption that the queue will retry it. `ARCHITECTURE.md` had inherited the same false claim —
*"the durable queue retries it, so nothing is lost"* — and the slice had to add
`RetryWithCooldown` in its `<Slice>Wakeup.ConfigureWolverine` to make the record true.

**Why this matters more than a wrong comment:** for an at-least-once feed that never re-sends, a transient
database blip loses a notice permanently, and the suite stays green because a test hands the notice to the
handler directly and never exercises a failure. It is the same shape as T4.

**`RetryWithCooldown` specifically**, not any other policy: the docs state only *"Retry"* and *"Retry With
Cooldown"* are applied automatically to an inline `InvokeAsync`. Anything else works in production and does
nothing in the suite — the worst possible split.

**Wanted:** `codegen.mjs` should EMIT a retry policy for ingest rather than describing one. The comment now
tells the truth and points at the fix, which is the smaller half.

### V7 — the concurrency retry does NOT apply to an HTTP endpoint, and every generated one says it does · **BROKEN**

**`Program.cs` carries `opts.OnException<ConcurrencyException>().RetryTimes(3)`, and every generated
state-change endpoint carries a comment saying the collision "reaches the retry policy in Program.cs".
That is a MESSAGE-pipeline policy. A Wolverine.HTTP endpoint never enters that pipeline.**

So on a concurrent duplicate, a generated HTTP state-change slice throws
`EventStreamUnexpectedMaxEventIdException` straight out to the caller — **a 500, not the ordinary
business refusal the kit claims.** Every HTTP state-change slice this kit has ever generated has this.

**Verified BEHAVIOURALLY, and the first evidence offered for it was worthless.** The claim was originally
supported by *"the generated HTTP endpoint has no try/catch"*. **That proves nothing** — dumping all 27
generated files with `codegen write` shows **zero catch blocks anywhere, message handlers included**.
Wolverine's retry lives in the message *executor* around the generated code, not inside it, so its absence
from a generated method is expected in both cases. Recorded because it is exactly the kind of
plausible-looking evidence that survives review.

The decisive test is behavioural: a probe endpoint in the **default scaffolded shape** (decider IS the
endpoint, `[WriteAggregate]` as middleware), raced by two callers released together against one hold.

```
JasperFx.Events.EventStreamUnexpectedMaxEventIdException
  at Marten...DocumentSessionBase.SaveChangesAsync
  at Internal.Generated.WolverineHandlers.POST_charging_probeInlineCancel.Handle(HttpContext)
  at Microsoft.AspNetCore.Routing.EndpointRoutingMiddleware...
```

**The exception leaves the endpoint and reaches the client.** No retry engaged. (The `Polly` frame further
down is Marten's own batch resiliency, not Wolverine's policy.)

The docs corroborate rather than prove: `wolverine/guide/handlers/error-handling.md` says *"When using
`IMessageBus.InvokeAsync()` to execute a message inline, only the 'Retry' and 'Retry With Cooldown' error
policies are applied **automatically**"*, and neither `guide/http/policies.md` nor
`guide/http/exception-handling.md` documents any retry — only an `OnException` convention that **swallows**.

**Why KIT-FINDINGS BM6 did not catch it:** that finding verified the retry on `automation/`, where commands
arrive by `InvokeAsync`. The HTTP path was never the tested one.

**Why `hold-bay` looked fine:** it owns its transaction for the advisory lock and retries *inside its own
mechanism*, so it never depended on the policy. The first slice to use the plain aggregate handler workflow
over HTTP is the first that could expose this.

**The fix used in `cancel-hold`** is a 5-line endpoint that invokes the decider through the bus, putting it
back on the message path where the retry is real. Same route, same body, same status codes — the wire is
unchanged.

**And the cheaper fix is wrong, with a test to prove it.** Translating the collision to a rule name via
Wolverine.HTTP's `OnException` convention is tempting and produces a lie: **a version conflict does not mean
the business rule failed.** Voltway's Bay stream is shared with the estate context, so a fault report or a
service job appending concurrently also collides — and the translation would refuse a perfectly live hold
with `NoLiveHold`. `AnUnrelatedConcurrentAppendDoesNotRefuseTheCancel` is red under a translation and green
under a retry, because a retry **re-reads** instead of guessing.

**Wanted:** `codegen.mjs` should emit the mediator hop for HTTP state-change slices, or stop claiming the
retry applies. Right now the comment is the most confidently wrong sentence the generator produces.

### V8 — the concurrency scaffold is generated from the wrong GWT · **BROKEN**

`architect.mjs tests` picks a slice's contended GWT and writes its rule name into the scaffold's header and
its suggested assertion. On `cancel-hold` it picked **`NotTheHolder`**, which is **not contended at all** —
Ben is refused whether or not Ada is cancelling at the same instant. The genuinely simultaneous case is the
holder cancelling twice, and its refusal is `NoLiveHold`.

The scaffold's suggested assertion (`Title == "NotTheHolder"`) would therefore have been **wrong**, and a
test written to it passes while pinning nothing. Contention is a property of *whether two callers can both
reach the rule*, not of the rule being a rejection — and the tool currently uses the second.

### V6 — adding a same-stream precondition HIDES a cross-stream rule from the classifier · **BROKEN**

`architect.mjs` classifies each GWT into one question family. A rejection whose GIVEN names another
stream is `cross-stream-rule`; one whose GIVEN is on the command's own stream is
`contended-invariant`. **A GWT with both gets classified as the second, and the cross-stream question
stops being asked.**

**Measured on Voltway.** `gwt-hb-3` — *one live hold per driver, network-wide* — began as
`given="Bay Held(bayId=$Bay7, driverId=$Ada)" when="HoldBay(bayId=$Bay3, driverId=$Ada)"` and was
correctly raised as `cross-stream-rule`. It is the sharpest question in the system and its answer is an
advisory lock, the most expensive mechanism built here. Implementation then found a missing rule
(*a bay that was never commissioned cannot be held*), so the GIVEN gained
`Bay Commissioned(bayId=$Bay3)` — a precondition on the command's **own** stream. On the next run the
tool reported the cross-stream answer as `ANSWER TO A QUESTION NOBODY ASKS`.

**The rule did not change. The driver still holds `$Bay7` while commanding on `$Bay3`.** Only the
classification did.

**Why it matters more than a bookkeeping slip:** had the model been written with that precondition from
the start — which is the natural way to write it — the cross-stream question would **never have been
asked**, the advisory lock would never have been chosen, and the invariant would have shipped as a
best-effort check two concurrent writers both pass. The failure is silent and lands on the single
hardest decision in the system.

**Wanted:** classify a GWT into **every** family it belongs to rather than the first that matches, and
let one rule carry two questions. The orphan report is the only reason this was caught at all, so it is
doing its job — but it fires *after* the answer exists, and a model written this way from the start
produces no orphan and no question.

**A SECOND, WORSE INSTANCE — and here nothing reported anything.** `register-driver`'s
`EmailAlreadyRegistered` and `CardAlreadyRegistered` are unique-across-**all** Driver streams. The tool
filed both as `contended-invariant` from the very first run, so they inherited the boilerplate answer
*"the stream key already contains the contested thing, so optimistic concurrency refuses the loser."*

**That is false, and following it ships a slice with no guard at all that passes every GWT** — `driverId`
is `terminal="driverId:generated"`, so every call mints a new stream and the fold is empty by
construction; two callers collide on nothing. Only a race test catches it, and the race test is
scaffolded from the same misclassification.

**The information was on the cell.** The GWT's own label reads *"No two drivers may share an email.
Spans streams: each driver is their own."* The classifier compares example key values and never reads it.
Two cheap improvements, either of which would have caught this: compare the aggregate **instance** where
the example data gives one, and treat a `terminal="…:generated"` key as *"a new stream every time,
therefore the fold cannot see other instances"* — which is precisely the condition that makes a
same-aggregate rule cross-stream.

### V5 — `status=` cannot be both "which tests run" and "how far along is this" · **BROKEN**

`status=` is read at **scaffold time** to decide whether a GWT's test is born with `[Fact(Skip=…)]`, and
test files are `scaffold` — so the skip is **kept for ever**. `codegen.mjs` generates the whole system in
one pass. Those three facts together leave no good option:

| | Tests | `status=` as a progress signal |
| --- | --- | --- |
| promote every slice to `ready` before the first scaffold | all live, 0 skipped | **destroyed** — every slice reads `ready` whether or not a line exists |
| leave them `in-design` and promote per slice | every later slice's tests baked `Skip`, each needing a hand edit that `TESTS STILL SKIPPED ON A CLAIMED SLICE` can only report, not repair | meaningful |

**Measured on Voltway.** Promoting all 22 before scaffolding gave 75 live tests and 0 skipped — and then
`status=` said `ready` for 19 slices with nothing written and `in-progress`/`in-review` for the one that
was built. A human reading the model for progress gets no signal at all, which is exactly what happened:
the user asked why "19 slices remain" did not match the statuses, and the answer was that the number came
from counting implemented code rather than from the field that exists to carry it.

**The field is being asked to do two jobs that want opposite defaults**, and the test-suite job wins
because its failure mode is silent. Options, none free:

- **`Skip` from the model at RUN time, not scaffold time** — a `[SkippableFact]` or a trait filter reading
  the compiled IR, so promoting a slice changes the run without touching a kept file. Removes the conflict
  entirely and is the only option that does.
- **Scaffold per slice** rather than per system, so an unpromoted slice has no test file yet.
- **Split the field** — `status=` for progress, and let the runner decide skipping some other way.

Until then, say out loud which convention a project is using, because the model does not.

**MITIGATED, not fixed.** `node tools/progress.mjs` reads the generated **code** rather than the claim
and prints both side by side — `N/20 built · NNN holes left` — with a `STATUS DOES NOT MATCH THE CODE`
section naming the exact `slice.mjs promote` command to reconcile it. `--stale` shows only the
disagreements. And `slice.mjs promote` now exists as the symmetric twin of `demote`, so moving a slice
forward is one command rather than a hand edit of two places that must agree — which is how `hold-bay`
came to sit at `in-progress` after it was finished.

That makes the drift **visible and cheap to correct**. It does not remove the conflict: `status=` still
cannot be both things at once, and the run-time-skip option above is still the only answer that does.

### V4 — every MOBILE review shot of a data-driven page is a picture of the loading state · **BROKEN**

`shoot.mjs` renders below `MIN_HONEST_WIDTH = 520` inside an `<iframe>`, which is the correct fix for the
sub-500px Windows layout lie it was written for. But the iframe is **cross-origin** (`file://` inside
`file://`), so it gets its own renderer process, and `--virtual-time-budget` — which advances a clock in
the *main* frame rather than sleeping — does not pause for the iframe's pending `fetch`. The shot is taken
before the data arrives.

**Measured on Voltway's `bay-finder`** at `--settle` 0, 4000 and 20000: identical loading-state shot every
time. Shooting at 520 gets real data — and then `review.mjs`'s sheet hard-codes `img { width:${w}px }`
(line ~161), so a 520px shot placed in a 390px column is **silently downscaled to 0.75×**. The port's type
then looks a quarter smaller than the design's, side by side, under a caption that says *"at 1:1"*.

So the two failure modes compose: shoot honestly and you photograph a spinner; shoot wide enough to get
data and the sheet lies about the scale. **This affects every data-driven screen in the kit at mobile
width**, and `design.mjs` is unaffected only because a static design page fetches nothing.

**AND IT HAS A THIRD FACE, WORSE THAN BOTH: an entirely BLANK page.** Measured on a second project run, on
three screens at 390px against a live Vite app — `fault-report?siteId=…` came back **byte-identical blank
across five runs**, unaffected by `--settle 0`, `1200` or `4000`, while *the same URL at 390 through real
device metrics rendered perfectly* and the same page at 1440 rendered perfectly. Another shot came back
showing the loading state, another was blank once and fine after.

**A blank shot reads as a bug in the port**, and that is what makes this the expensive failure: the
implementer's first move is to go looking for a rendering fault in code that is correct. Two of the three
screens in that run were re-shot through device metrics to complete the sheet.

That is now three independent symptoms of one cause — spinner, wrong scale, blank — which strengthens the
case for the CDP `Emulation.setDeviceMetricsOverride` fix over the same-origin shim: device metrics is the
path that demonstrably works at 390 in every one of these cases.

**The workaround in the project is a same-origin shim** (`web/_shot390.html`: a 390px iframe scaled
×1.333, served by Vite so the outer page shares the app's origin). It works and it is not where the fix
belongs.

**MEASURED, so the obvious fix can be ruled out.** `probes/` style run against a page that prints
`innerWidth` and flips a line after a resolved promise:

| invocation | `innerWidth` | async work landed? |
| --- | --- | --- |
| `--window-size=390` DSF 1 | **492** | — |
| `--window-size=390` DSF 2 | **492** (png 780×600) | yes |
| `--window-size=780` DSF 2 | **764** (png 1560×1200) | yes |

So **`--force-device-scale-factor` cannot produce a narrow CSS viewport** — `--window-size` is in CSS
pixels and DSF only changes output density. That kills the "drop the iframe, shoot at 780 physical"
suggestion outright.

The same probe settles the mechanism: **`--virtual-time-budget` DOES wait for async work in the main
frame.** The iframe is the entire problem, and only for an `http://` target — a `file://` design page
inside a `file://` shim is unaffected, which is why `design.mjs` never showed this.

**Two fixes remain, both real:**

1. **Same-origin shim, generalised into `review.mjs`.** Write the wrapper into the app's own served root
   so shim and target share an origin and one renderer, shoot it, delete it. This is exactly the manual
   workaround, moved into the tool. Cheap; only helps targets the kit can write a file into.
2. **Drive Chrome over CDP instead of flags** — `Emulation.setDeviceMetricsOverride` sets a true 390 CSS
   viewport with no iframe at any width, and `Page.captureScreenshot` takes the shot. Node 22+ has a
   global `WebSocket`, so this needs no dependency. Larger, and it fixes the width floor permanently
   rather than working around it.

### V2 — a documented Marten `Apply` overload is SILENTLY SKIPPED on a multi-stream projection · **BROKEN** *(in Marten, not the kit)*

`marten/events/projections/conventions.md` lists **`Task<T> Apply(TEvent, IQuerySession, T)`** as valid
return type 4 — *"allows you to use immutable aggregate types while also using external data read through
IQuerySession"*. On **Marten 9.22.5 / JasperFx.Events 2.42.2** it compiles, the host boots, the daemon
runs, and **that one `Apply` does nothing**: no exception, no warning, no log line. Measured on Voltway's
`AvailableBays` — the row came back with `bayId`, `siteId`, `bayLabel`, `connectorType` and `maxKw` all at
their type defaults while every other `Apply` on the same projection worked. Reproduced `static` and
instance.

**This is the worst failure shape there is** — a documented API that compiles and silently does nothing —
and nothing in this kit would have caught it. The model validates, the code compiles, the suite is green,
and the read model is empty. It was found because the slice gate says *look at the endpoint*, and the
agent looked.

**What works instead is `EnrichEventsAsync`**, which is an `override` and therefore cannot be silently
skipped. `enrichment.md` says the hook exists *"at least for SingleStreamProjection classes"*; the
`JasperFx.Events.xml` doc file puts it on `JasperFxAggregationProjectionBase`, the base of **both**, and it
runs fine on a multi-stream projection. Its two halves live in namespaces no page states —
`JasperFx.Events` for `IEvent<T>`/`EventSlice`, `JasperFx.Events.Grouping` for `SliceGroup`. It also
batches, so it avoids the N+1 the docs warn about in the same breath as the shape that does not work.

**Wanted:** confirm against a newer Marten and report upstream if it survives. Until then, treat
`IQuerySession` in an `Apply` signature as non-functional on multi-stream projections and reach for
`EnrichEventsAsync`. This is the third entry in the *"the mirror is not infallible either"* family and the
first where the documented member **exists, compiles and lies**.

### V3 — the generated Async-view test hint names a namespace that does not exist · **BROKEN** · ***FIXED***

`codegen.mjs` told every Async view's test to import `Marten.Events.TestingExtensions`. That is a **static
class**, not a namespace, so the `using` is `CS0138` — settled from `Marten.xml`, where the member is
`M:Marten.Events.TestingExtensions.WaitForNonStaleProjectionDataAsync`. The hint appeared on all five of
`bay-availability`'s scaffolded GTs and would have sent every implementing agent down the same path. Fixed
in both hint sites; the correct import is `using Marten.Events;`. Checked while fixing: overloads exist on
**both** `IHost` and `IDocumentStore`, so the hint's `Store.…` receiver was right.

### V1 — a race test for a lock taken BEFORE the read can pass without the writers ever overlapping · **BROKEN**

`architect.mjs tests` scaffolds, and `reference-implementations/cross-aggregate-invariant/` ships, an
advisory-lock race test that is a bare `Task.WhenAll` of two writers. **The reference implementation
explains why it cannot use the `Barrier(2)` every other arm uses** — a read-barrier deadlocks against a
lock taken before the read, since preventing simultaneous reads is exactly what that lock does — and then
asserts an outcome *shape* instead. That reasoning is correct and the conclusion is still not safe:
nothing in either version proves the two writers overlapped at all.

**Measured on Voltway's `hold-bay`.** Written that way the test went green; **mutating the advisory key to
a random value left it green**, because each writer read and committed before the other reached its read.
The guard was never exercised.

**What works is a delay seam rather than a barrier.** The writer holding the lock waits between its read
and its append while the other writer is blocked at the lock; remove the lock and the second writer reads
straight through the open window and both commit. Mutation-checked in both directions —
`HoldBayMechanism.HoldAsync` carries a test-only `afterRead` hook, null on every production path.

**A delay is still a bet, so the shipped form uses no wall clock at all.** The lock-holder *parks* in the
`afterRead` seam until the test releases it; the test then proves the boundary is locked with a keyed
`pg_try_advisory_xact_lock` on its own connection, waits for the second writer to be **observably**
blocked in `pg_locks` (a condition, not a duration), releases, and asserts the outcome shape. Mutating
the lock key fails it at the keyed assertion in under a second — 3 runs red, 5 green alone, 3 green with
the suite.

> **A RETRACTION, AND IT IS THE METHOD TURNED ON ITSELF.** This entry first recorded the intermediate
> version as *"order-dependent — passes in the suite, fails 0 of 6 alone."* **That measurement was
> wrong.** The restore step used `Move-Item` from a `Copy-Item` backup, which preserves the ORIGINAL
> mtime — so the restored source was older than the compiled assembly, MSBuild judged the build up to
> date, and `--no-build` re-ran the **mutated** binary six times. After a real rebuild: 5 of 5 green.
> The lesson is exactly the one this kit keeps relearning at a different altitude: **a mutation test
> proves nothing unless you can show the mutation actually reached the binary**, and `--no-build` after
> a timestamp-preserving restore silently guarantees it did not.

**And the reference implementation's arm 3 should be re-measured the same way**, because if its two
writers never overlap either, the arm that CLAUDE.md calls "the odd one and often the best" is green for
a reason unrelated to the lock. The implementing agent's independent read is that arm 3 uses the v1
shape and **v1 is the version that survives its own mutation** — so this is a live suspicion about
shipped reference code, not a hypothetical.

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

### BN4 — nothing emits `docker-compose.yml`, and the `ui-journey` gate requires it · **GAP** · cause `kit`

**`ui-journey`'s gate says the run that counts is against compose, and no tool in the kit writes a compose
file, a Dockerfile or an nginx config.** `codegen`'s skill says *"the demo uses docker-compose"*,
`uijourney.mjs`'s scaffolded config prints the `docker compose -f generated/<System>/docker-compose.yml`
command, and `web/vite.config.ts`'s own comment warns that *"the same trap is waiting in the compose nginx
config"* — a file that did not exist. So the gate was unmeetable on a fresh project, and the previous
project only met it because somebody hand-wrote the files once.

Hand-written for Voltway during the first UI-journey run, and **all four of the things compose is supposed
to catch were live in it**, which is the argument for generating it:

| | |
| --- | --- |
| the nginx prefix trap | `location /estate` swallows `/estate-admin`. Needs `location ^~ /estate/`, exactly as vite.config predicted |
| the SPA fallback | seven screens are seven real paths; without `try_files … /index.html` only `/` loads and every deep link 404s |
| `ASPNETCORE_ENVIRONMENT` | the seed hangs off `IsDevelopment()`, so without it every screen is empty with no error |
| Wolverine runtime codegen | the aspnet runtime image has no reference assemblies for Roslyn. Solved by `codegen write` at build time plus `JASPERFX_CODEGEN_TYPE_LOAD_MODE=Static`, so a missing generated type is a loud startup failure rather than a silent recompile that works in dev only |

None of that is judgement — it is mechanically derivable from the IR (the route prefixes are the contexts,
the screens are the paths). It belongs in `emit`, with the nginx config `scaffold` if anything is.

### BN5 — the "no skipped navigation" rule has no notion of an ACTOR CHANGE · **GAP** · cause `kit`

`ui-journey`'s one rule says no step may skip the navigation it is testing, and reaching a screen by typing
its URL is the offence. **That is right within one actor and meaningless across two**, and the skill does
not draw the line — so the rule as written condemns every cross-actor journey, which is the interesting kind.

Voltway has five actor lanes over seven screens. `estate-to-driver` walks `estate-admin` (Estate Manager) then
`bay-finder` (Driver): two people, two devices, two buildings. There is no in-app link between them, there
should not be one, and adding one to make the test "click properly" would invent a workflow nobody has.
Honouring the rule literally would have meant either building that link or declaring the journey unwalkable.

The model already holds the fact needed to decide it — `actor=` on the lane, which the kit added for exactly
this class of question. So `uijourney.mjs plan` could say *"step 2 changes actor, so its URL entry is a
login, not a shortcut"* instead of leaving it to a judgement call the human has to be asked for. Answered by
the human this run and recorded in the spec's doc comment, which is currently the only place it lives.

**Related and unfixed:** `plan`'s "HOW DOES THE USER GET HERE?" prompt fires on any screen with no
`displays=`, which cannot distinguish a modal that must be opened from an entry point that is simply typed.
Both of Voltway's flagged screens were entry points, so the prompt was noise both times.

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
