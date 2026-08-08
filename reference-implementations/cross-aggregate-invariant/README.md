# cross-aggregate-invariant — an invariant that spans streams

**Status: the concurrency study is complete. All four mechanisms are built, green and stable.**
The 13 generated GWT tests are still unimplemented, so this is not yet a complete slice implementation —
see [What to do next](#what-to-do-next).

An advanced **state-change** pattern. Every other reference implementation answers *"what did this choice
cost?"* for a shape that fits inside one stream. This one carries the shape that does not:

> the sum of committed-minus-released across **every Project stream of a Department**
> must never exceed that Department's budget

The command appends to **one** project stream. The fact that would refuse it may live in **another**. No
stream's own version covers that, so `FetchForWriting`'s optimistic concurrency — the kit's standard
answer everywhere else — cannot see the conflict. This folder exists to find out what can.

It is **not a domain**. Names carry no business claims.

---

## The model

`spend/spend.drawio` — 0 errors, 0 warnings. Two streams, five slices, thirteen GWTs.

| | |
| --- | --- |
| **Department** stream (`departmentId`) | `Department Budget Set` |
| **Project** stream (`projectId`) | `Project Opened`, `Spend Committed`, `Commitment Released` |
| **DepartmentSpend** | multi-stream view keyed `departmentId`: `budget`, `committed`, `available`, `ProjectLine[]` |

The rule is **stated on the model**, not only in code — `gwt-commit-2`:

```
GIVEN Spend Committed(projectId=$ProjectB, amount=70000)
WHEN  CommitSpend(projectId=$ProjectA, amount=40000)
THEN  error: DepartmentBudgetExceeded
```

A GIVEN in a stream the command does not write to. That is `architect.mjs`'s `cross-stream-rule`
question with a runnable model behind it.

---

## Where it stands

```
dotnet test --filter "FullyQualifiedName~CrossAggregateRaceTests"

Passed!  -  Failed: 0,  Passed: 15,  Skipped: 0,  Total: 15
```

15 tests, **5 consecutive runs, 0 flakes** (75 executions).

| Arm | What guards it | Loser gets | State |
| --- | --- | --- | --- |
| **0 — naive** | nothing | — | **proven broken**, deterministically. This is the point of it |
| **1 — guard row** | one `IRevisioned` row per department, `UpdateRevision` | `Conflict` | **GREEN** |
| **2 — reservation row** | a unique index on `(department, sequence)` | `Conflict` | **GREEN** |
| **3 — advisory lock** | `pg_advisory_xact_lock`, taken before the read | **`BudgetExceeded`** | **GREEN** |
| **4 — DCB** | `mt_dcb_tag_version`, one row per tag value | `DcbConcurrencyException` | **GREEN** |

**The headline: arms 1–3 need no migration.** They work on the kit's own Marten 8 stack. DCB is the
version-maintained-for-you option, not the only door — which is the opposite of the conclusion this
folder pointed at while arm 1 was red, and the reason its README warned against drawing one early.

**Arm 3 is the shape worth noticing.** Because the lock is taken *before* the read, the loser reads the
winner's commit and is refused by the **ordinary business rule** — no conflict, no retry, nothing wasted.
Ten writers against a budget for six give exactly `6 Committed, 4 BudgetExceeded`, every run. The other
three arms degrade into retries under contention; this one degrades into waiting.

**A green control test means the race reproduces.** `CONTROL_*` assert the invariant is *violated*. If
they ever start failing, the naive arm has accidentally become correct and every conclusion drawn from
the other arms needs re-checking.

### Two tests that exist only to stop the others passing for the wrong reason

`*_still_allows_successive_commits_that_fit` is on every guarded arm, and it closes a hole the original
pair had: **a mechanism that simply refused everything after the first commit would have passed both of
them.** The deterministic test asserts exactly one commit — which such a mechanism also produces — and the
stress test only asserted that *some* commit got through. So each arm now also proves it is invisible when
nobody is racing: two uncontended commits both succeed, and the third is refused by the **budget rule**
rather than by the guard.

The same test pins arm 4's fold, which nothing else did — the third call can only be refused if
`FetchForWritingByTags` really accumulated across two *different* project streams.

---

## The organising principle, from Marten's own migration guide

> *"The side-table mechanism **converts the predicate read into a row-level write conflict**, so
> concurrent boundary saves serialize on a row lock at `READ COMMITTED` — no `SERIALIZABLE`, no advisory
> locks."*

That is the whole answer stated generally. **Optimistic concurrency is not the problem; the thing being
versioned was.** A version needs to sit on something *both writers write*:

| Version on | Guards | Here |
| --- | --- | --- |
| a **stream** | appends to that stream | ❌ the writers are on different streams |
| a **document row** | updates to that row | ✅ if both writers write it — arm 1 |
| a **DCB tag value** | the predicate itself | ✅ arm 4, and Marten maintains the row for you |

So **DCB is optimistic concurrency**, with the version attached to the boundary key instead of a stream.
Arms 1 and 2 are the same idea hand-rolled — on a document row's revision, and on a unique index. Arm 3
opts out of the framing entirely: it does not version anything, it just refuses to let the two reads
happen at once.

**Arms 1–3 are all green, so the guarantee is available on Marten 8 with no migration.** What DCB buys is
not the capability but the maintenance: Marten owns the version row, so nothing in your code has to
remember to write it.

---

## Running it

```bash
node tools/model.mjs validate reference-implementations/cross-aggregate-invariant/spend/spend.drawio
node tools/codegen.mjs      reference-implementations/cross-aggregate-invariant/spend \
                            --project reference-implementations/cross-aggregate-invariant --out generated

cd reference-implementations/cross-aggregate-invariant/generated
dotnet test --filter "FullyQualifiedName~CrossAggregateRaceTests"
```

Needs Docker (Testcontainers). The 13 generated GWT tests still throw `NotImplementedException` — they
are not part of this folder's argument yet and are filtered out above.

---

## This folder is pinned OFF the kit's enforced stack, deliberately

`package-versions.json` moves it to **Marten 9.22.5 + Wolverine 6.25.1 + JasperFx 2**, and the file
carries its own reasons. That mechanism is new — `codegen.mjs` reads it, an unknown package name is an
error rather than a no-op, and every override prints on each run (KIT-FINDINGS **AD10**).

**Why:** Marten 8.37.4 ships the whole DCB API — `FetchForWritingByTags`, `DcbConcurrencyException` —
**without `mt_dcb_tag_version`**, the side table the docs call the serialization point, added in 9.4 to
fix [marten#4591](https://github.com/JasperFx/marten/issues/4591). On Marten 8 a DCB implementation
compiles, runs, and can let both writers through: the exact failure this folder exists to catch.

`generated/Directory.Build.props` adds `WolverineFx.RuntimeCompilation`, which Wolverine 6 needs and
codegen has no reason to emit. Adding a package there is reliable; **re-versioning one in a target is
not** — see AD10.

---

## Traps already paid for

**A green build proved nothing.** All three Marten 9 breaks compiled at 0 warnings 0 errors and failed at
host startup (**AD11**):

- Wolverine 5 cannot *run* on Marten 9 — `TypeLoadException: Weasel.Core.IAdvisoryLock`. The Wolverine
  family moves with Marten.
- Marten 9 requires **`partial`** on projection subclasses using convention methods — dispatched by a
  compile-time source generator with no runtime fallback. **`codegen.mjs` still emits them non-partial**,
  which will block the next migration. One-word fix, not yet applied.
- Wolverine 6 dropped the runtime compiler from core.

**Four types are documented with no namespace, and none is where you would guess.** Found by grepping the
packages' `.xml`, which is the tiebreaker CLAUDE.md prescribes:

| Docs write | Actually |
| --- | --- |
| `[BoundaryAggregate]` | `JasperFx.Events.Aggregation` |
| `new EventTagQuery()` | `JasperFx.Events.Tags` |
| `IRevisioned` | `JasperFx` (was `Marten.Metadata`) |
| `ConcurrencyException`, `DocumentAlreadyExistsException` | `JasperFx` (was `Marten.Exceptions`) |
| `SessionOptions.ForTransaction` | **`Marten.Services`** — and this one **misresolves silently** |

**The last one is the nastiest, because the bare name still compiles to something.** With `using Marten;`
in scope, `SessionOptions` resolves to a different type, so you get `CS0117: does not contain a definition
for 'ForTransaction'` — which says *the type is right, the member is missing*, i.e. reads as a **version**
problem. On a folder deliberately pinned off the kit's stack, that is exactly the wrong trail. **Grep the
package `.xml` before suspecting the version: a wrong namespace can imitate a wrong version, never the
reverse.** KIT-FINDINGS **AD15**.

**The identity-less boundary aggregate does not work as documented.** `dcb.md` says it has *"no `Id`
property and no `[AggregateIdentity]`"*; on 9.22.5 `RegisterTagType(...).ForAggregate<T>()` still routes
it through the document mapper and throws `InvalidDocumentException`. Adding an `Id` — as the docs' own
`StudentCourseEnrollment` example does — fixes it. **Follow the example, not the prose.**

**`Store()` is an UPSERT.** Two writers that both find no guard row both INSERT one and both succeed. A
revision check only bites on an UPDATE, so a guard created lazily by the first writer protects nothing
exactly when it matters. The row must exist before the race — in production, `SetBudget` owns it. (Arm 2
hits the mirror image of this and is why it calls `session.Insert`, not `Store`: an upsert would quietly
overwrite the competing row instead of colliding with it.)

**And `Store()` cannot conflict at all, which is the deeper version of the same trap.** The docs say
`Store()` on an `IRevisioned` document *"is essentially `UpdateRevision(entity, entity.Version)`"* — the
version it **already has** — while the enforcing rule rejects a revision only when the database version is
*equal or greater* than the one supplied. So `Store()` asserts something already true. Three attempts to
fix arm 1 by configuration (`IRevisioned` alone, pre-creating the row, `UseNumericRevisions(true)`) all
failed because none of them changes **which number is supplied**. `UpdateRevision(guard, guard.Version + 1)`
does. KIT-FINDINGS **AD14**.

**A read-barrier deadlocks against a mechanism that locks before reading.** Arms 0, 1, 2 and 4 are all
tested by holding both writers until both have read; arm 3 makes that impossible on purpose, so writer A
would hold the lock while waiting for writer B, and B could not read until A released it. Not a flaw in
either — a mechanism that prevents simultaneous reads cannot be observed by forcing two. Arm 3 asserts
outcome shape instead. The barrier's 30-second timeout exists so this class of mistake fails a run rather
than hanging it.

**Assert the invariant on the event store, never on a projection** (**AD12**). The first race test
asserted `DepartmentSpend.Committed == 140000` and *failed* — because the same race also makes two inline
projection updates overwrite each other, so the view reported **70,000** while the store held **140,000**.
A test trusting the view would have shown the budget intact while the money was spent twice. The helper
`CommittedAccordingToTheEventStore()` exists for this reason.

---

## What to do next

**One item left.**

**Fill the 13 GWT tests**, so the folder is a complete slice implementation and not only a concurrency
study. They currently throw `NotImplementedException` and are filtered out of the command above. This is
ordinary `codegen`-skill work — the model validates, the skeleton builds, and nothing about it is blocked.

### Done, and what each one settled

1. ~~**Finish arm 1.**~~ `session.Store(guard)` → **`session.UpdateRevision(guard, guard.Version + 1)`**.
   The three earlier attempts — `IRevisioned` alone, pre-creating the row, `UseNumericRevisions(true)` —
   all changed whether the version is *enforced*; none changed **which number is supplied**, and `Store()`
   supplies the version it already has, so it asserts something already true. **The `+1` is the whole
   mechanism.** KIT-FINDINGS **AD14**.
2. ~~**Adversarial review of the tests.**~~ Three concerns, three answers. `Barrier(2)` does serialise
   correctly — and the control reproducing deterministically across 5 runs is the empirical proof, since a
   broken barrier would show up as a flaky control. The DCB tests cannot pass with both writers refused,
   because they assert `Committed == 1` as well as `Conflict == 1`. The `> 6 of 10` threshold is exactly
   right (6 × 15k fits, 7 does not). **The real hole was elsewhere** — see the section above on
   `*_still_allows_successive_commits_that_fit`. Two robustness fixes came out of it: the barrier now times
   out at 30s so a writer that throws before arriving fails the run instead of hanging it, and a comment in
   `ViewRegistrations` that claimed `DepartmentSpend` was `Async` was corrected — it is deliberately
   `Inline`, and that is load-bearing for this folder's whole argument.
3. ~~**Arms 2 and 3.**~~ Both green. Arm 3's constraint was real and had a second consequence nobody had
   predicted: **a read-barrier deadlocks against it**, because writer A holds the lock while waiting for
   writer B to read, and B cannot read until A releases. A mechanism that serialises *before* the read
   cannot be observed by forcing two simultaneous reads — preventing them is what it does. Arm 3 is
   therefore tested on outcome shape instead, which is sharper anyway.
   `Marten.Services.SessionOptions.ForTransaction` is what hands Marten a transaction you own; the docs
   name no namespace and the bare name misresolves, giving CS0117 rather than "not found". KIT-FINDINGS
   **AD15**.
4. ~~**Fix `codegen.mjs` to emit `partial` projections.**~~ Done, with the reason at the emit site.
   Verified harmless on Marten 8 by regenerating `state-view/` fresh and building at 0 warnings 0 errors.
   Note it reaches **new** files only — a view is `scaffold`, so an existing project still needs the
   one-word hand edit.

---

## Findings this folder produced

`KIT-FINDINGS.md` **AD1** (DCB exists, kit never mentions it) · **AD2** (the open question: is DCB needed,
or does multi-stream aggregation suffice) · **AD9** (`validate` passes on a `.drawio` draw.io cannot open)
· **AD10** (per-project package pins; the MSBuild workaround that silently downgraded to a CVE-carrying
2018 package) · **AD11** (three Marten 9 breaks a green build hides) · **AD12** (never assert an invariant
on a projection) · **AD13** (DCB works, and is not seamless).
