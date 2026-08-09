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

### AD7 — `route` refuses a same-column View → Screen because of `SCREEN_X_NUDGE` · **BROKEN**

The one edge ch. 16 of the book requires — a View feeding the screen in its own column — is the one the
router will not draw. → [detail](KIT-HISTORY.md)

---

## 2. Missing capability

### A11 — `codegen` scaffolds no endpoint for a State Change slice · **GAP**

The command record, the fold and the test are generated; **the decider is not**, so every state-change
slice starts with an empty folder and a hand-written file. Confirmed still true on 2026-08-09: implementing
`cross-aggregate-invariant`'s five slices meant hand-writing five endpoints, all of which followed the same
shape. That shape is scaffoldable.

### T1 — no ingest seam for a foreign event · **GAP**

The generator emits an external event's record and a `SeedData` TODO to append it *in tests*, and nothing
in the application. So no production path exists by which a foreign event enters the store, and *"nothing
ever ingests this"* is invisible to a green suite — exactly as *"nothing ever wakes this"* was. Wanted:
an `INGEST NOT WIRED` report, by the same logic as the reports that already exist.

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

### BK1 — an automation sweeping an ASYNC todo View can silently lose work · **GAP**

`UES` **ch. 32** names the exact failure: *"we had this eventually consistent Read Model that was used by
a **processor**. Because of the eventually consistent nature, in certain situations, it could happen that
**entries get lost if the processor was running before the model got updated**."* That is the kit's
automation pattern — `Event(s) → todo View → Trigger` — with the View registered `Async`, which is what
`codegen` picks for any multi-stream view. **No test can see it and nothing warns.** The chapter's answer
is the *partially synchronous projection* (a bounded in-memory queue filled by a synchronous handler),
which CLAUDE.md already names as the missing third read-side option and no reference implementation builds.
→ [BOOK-INDEX.md](reference/BOOK-INDEX.md) gap 1

### BK2 — the Reservation Pattern is a fifth cross-aggregate mechanism, and the cheapest · **GAP**

`UES` **ch. 36**: make the contested value **the stream id**, because *"there can only ever be one
aggregate for a given ID at any point in time."* No guard row, no unique index, no lock, no DCB — and the
kit's own `ConcurrencyHarness` already classifies its failure (`ExistingStreamIdCollisionException`).
`architect` offers *"make the contested thing ONE stream"* as an option with no name and no worked
example; `cross-aggregate-invariant/` builds four mechanisms and not this one.

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
