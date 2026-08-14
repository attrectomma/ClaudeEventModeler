---
name: architect
description: >-
  Answer the concurrency and consistency questions the event model deliberately leaves open — stream
  boundaries, races across streams, how stale a read model may be, replay safety — by reading the real
  Wolverine/Marten docs and writing the decisions down. Use when the model validates and before the first
  slice is generated, or when the user says "architect", "review the architecture", "how do we handle
  concurrency here", or invokes /architect. Runs AFTER event-model and BEFORE codegen. It never edits the
  model.
---

# architect — the choices the model leaves open

**The event model's responsibility is domain knowledge and how information flows. That is all.** Concurrency,
optimistic locking, projection consistency mode and snapshots are technical concerns, and both books say so
outright:

> *"Snapshots are a pure technical tool and are **neither modeled nor mentioned in an Event Model**
> typically."* — Understanding EventSourcing

The little book files its Live-Model vs Database-Projection trade-off under *"Implementation Hints"*. So none
of this becomes notation.

**You never touch a `.drawio`, and you never propose a grammar rule for any of it.** The kit made that
mistake once and recorded it as finding **T0**: an implementation concern climbed into the domain model as a
business rule, where it validated, generated a test and passed. If your answer to a question here is *"add
an attribute to the model"*, the answer is wrong — with one exception, below.

**The one exception.** If a question reveals that the *boundary itself* is wrong — the stream key does not
contain the thing being contested — then the fix **is** a model change, because the stream key is a domain
fact and the swimlane is where it lives. That is not a technical concern leaking in; it is modelling done
right, and both books agree the aggregate *is* the transactional consistency boundary. Say so, hand it back
to `add-slice` or `event-model`, and expect the ripple: the key has to go on every event of that stream and
on the commands.

## When to run

**After `model.mjs validate` is at zero errors, and before the first slice is generated.** That order is the
whole point. These decisions are **system**-scoped: if slice 1 picks `Inline` and slice 4 needs `Async`, they
conflict after both are green and one of them has to be rewritten. codegen is per-slice by design, which is
why this is a separate step and not part of it — same reasoning that keeps `journey` out of codegen.

Re-run whenever the model grows. `check` reports questions the model has started asking since the record was
written, which is the failure mode every write-once file in this kit has eventually hit.

## 1 — read the questions

```
node tools/architect.mjs questions              # <project>/diagrams
node tools/architect.mjs questions <model-dir>   # anywhere else — a reference implementation, say
```

Six families, all derived mechanically from the compiled IR. **The tool asks; it never answers.**

**If it prints `<something> does not exist.` and exits 1, pass the model directory.** All four subcommands
assumed `<project>/diagrams` until 2026-08-11, which meant they died on every reference implementation — and
`codegen` wraps `check` in a `try/catch`, so that death was *silent* and `ARCHITECTURE DECISIONS MISSING` could
never fire there. Do not read a quiet `check` as a clean one without confirming it ran. KIT-HISTORY **BP2**.

**`codegen` reads this tool's answer.** `questions --json`'s `contended-invariant` family is what decides
whether a slice's decider is scaffolded off the HTTP arm, so a question family that fails to derive here
changes generated code. That is deliberate — one computation, one caller (V9) — and it means this tool
failing is never a local problem.

| | What it means, and why it is a question |
| --- | --- |
| `stream-boundaries/<ctx>` | the whole boundary map — every stream we append to, its key, its writers. **The least reversible decision in the system.** A rule whose scope sits inside one key is a true in-transaction invariant; the same rule against a wider key is a check against a projection that two concurrent writers both pass |
| `no-stream-key/<lane>` | a band holding events we append with no `identity=`. There is no consistency boundary at all until this is answered |
| `contended-invariant/<slice>/<gwt>` | **a rejection that depends on state in the very stream its command appends to** — the class of rule two callers at the same instant can both pass. Every generated GWT is sequential, so nothing else can see it. These are the ones that get a **race test** |
| `cross-stream-rule/<slice>/<gwt>` | **the sharpest one.** A scenario whose GIVEN lives in a stream the command does not append to, so enforcing it means *reading another stream* — and that stream can change between the read and the append. Optimistic concurrency on *our* version cannot close that window, because the version that moved is somebody else's |
| `stale-read/<View>` | a view fed by more than one stream type (**codegen registers those `Async`, following Marten's own guidance**), or read by a screen that also issues a command feeding it — the user reads their own write |
| `view-identity/<View>/<field>` | a key value no feeding event carries. If the answer is event metadata, the view is keyed on **append** time |
| `replay-safety/<slice>` | an automation or translation. A replay, a redelivery and a restarted sweep all run it twice |
| `type-binding/<ctx>` | **what a domain type IS, in C#.** The model is stack-agnostic on purpose — `fields="aggregateId:UUID"` is the business saying "a universally unique id", not a claim about .NET — so something has to translate, and it must not be codegen guessing. A table is proposed for the unambiguous ones; anything with a real trade-off arrives as `TODO` |

**On `type-binding`, two things are easy to get wrong.**

**A proposal is not a decision.** The table arrives pre-filled for types that have one obvious answer, and
that is a convenience, not an answer — the `Because:` and `It costs:` lines are still yours. The binding
that always deserves a sentence is the fractional one: the proposal is **`decimal` for every fractional
type**, including `Double` and `float`, because money is the overwhelmingly common case in these models and
binary floating point cannot represent 9.99. A field that is genuinely a measurement should say `double`
and say why.

**If the domain word is simply wrong, fix the MODEL, not the binding.** A binding translates a correct
domain word into a stack type. It is not the place to paper over `custmerId`. That is a domain fact and it
goes back to `add-slice`.

## 2 — answer them against the mirror, never from memory

**Read `reference/llms/` before deciding anything.** The whole reason the mirror exists is that these APIs
move faster than model knowledge, and a wrong answer here is one that compiles, passes and is silently
broken. `node tools/docs.mjs status` first; `sync` if stale.

The kit's own escalation, in order: **read the mirror → grep the NuGet package's `.xml` doc file → compile.**
And remember the mirror can be *ahead* of the pinned version, which reads exactly like a namespace mistake.

### The write side

Once the boundary is right, concurrency is mechanical rather than a design problem:

> *"we apply optimistic locking not on the entire Event Store, but on **individual event streams**."*
> — Understanding EventSourcing, ch. 4

On this stack that is **Wolverine's aggregate handler workflow**, which does the fetch, the fold, the
optimistic concurrency check and the save as middleware — leaving a decider that is a pure function of
`(command, state)`. Both books ask for exactly that (`LEB` ch. 15), and Wolverine calls it the Decider
pattern.

**BUT THE RETRY THAT MAKES IT WORK IS A MESSAGE-PIPELINE POLICY.** `opts.OnException<…>().RetryTimes(3)`
never reaches a Wolverine.HTTP endpoint, so on the HTTP arm a lost race arrives at the caller as a **500**
instead of the ordinary business refusal. **So every `contended-invariant` you answer with "the stream
version refuses the loser" carries a rider: it is only true if the decider is on the message path.** Say so
in the decision, because the implementing agent reads this file and the scaffold puts the decider in the
endpoint by default. Measured on both arms of one model in `reference-implementations/state-change/`;
KIT-FINDINGS **V7**.

**A composite key does not rule it out.** That claim was in this file for five runs and is retracted:
`[WriteAggregate]` resolves the stream from a public **member**, and `codegen` emits an assembled
`StreamKey` member on any command carrying the whole identity. KIT-FINDINGS **BM1**.

**Reading *another* stream is a second `[WriteAggregate]` with `AlwaysEnforceConsistency = true`** — Marten
then version-checks that stream even though nothing is appended to it, which turns *"accept the window"*
into an enforced answer. Prefer it over `FetchLatest`, which adds no check at all.

`FetchForWriting` by hand is for two cases only: a decider that must **search** for its stream (no key to
hand the middleware), and a slice implementing a concurrency **mechanism** that has to own its transaction.

**For a `cross-stream-rule`, the honest answers are:**

| | Costs |
| --- | --- |
| **accept the window** | a late write gets through. Legitimate — but name who agreed |
| **make the contested thing one stream** | the rule becomes a true invariant. Costs a model change and the key on every event |
| **compensate** | let it through, emit a correcting event when the conflict is found. Costs a second slice and a visible-to-users reversal |
| **guard the boundary directly** | **four measured mechanisms — see below.** The rule becomes real with no model change |
| ~~serialise on both streams~~ | couples them, and can deadlock. Superseded by the row below it — every mechanism there serialises on **one** thing, which is what makes it safe |

#### Guarding the boundary: four mechanisms, all measured

**This used to read "no stream's version covers a cross-stream rule, so you cannot enforce it." That is
false, and `reference-implementations/cross-aggregate-invariant/` exists to say so.** All four hold the
invariant against real Postgres; the control proves the race reproduces deterministically without them.

The organising idea is one sentence from Marten's own migration guide, and it generalises past DCB:

> *"the side-table mechanism **converts the predicate read into a row-level write conflict**, so concurrent
> boundary saves serialize on a row lock at `READ COMMITTED`."*

**Optimistic concurrency was never the problem — the thing being versioned was.** A version has to sit on
something *both writers write*. A stream fails that test when the writers are on different streams; a
document row, a unique index, a lock or a DCB tag all pass it.

| | Serialisation point | Loser gets | Costs |
| --- | --- | --- | --- |
| **guard row** | one `IRevisioned` row per boundary, written with `UpdateRevision` | `Conflict`, retry | every write in the boundary contends on one hot row |
| **reservation row** | a unique index on `(boundary, sequence)` | `Conflict`, retry | a row per write, unbounded; the sequence is an O(rows) count. Leaves an audit trail |
| **advisory lock** | `pg_advisory_xact_lock`, taken **before the read** | **`BudgetExceeded`** — the ordinary rule, **no retry** | serialises everything in the boundary; contention becomes latency rather than failure |
| **DCB** | `mt_dcb_tag_version`, maintained by Marten | `DcbConcurrencyException`, retry | none beyond being on the current stack |
| **reservation stream** | the **event store's own stream table** — `StartStream` on an id derived from the contested thing | `ExistingStreamIdCollisionException`, retry | **the cheapest**: no document, no index, no registration, no lock, no Marten 9. Costs a stream per claim |

**The last two rows are one pattern** — *Understanding Eventsourcing* ch. 36's Reservation Pattern, which
offers exactly these two implementations (*"using a database to synchronize access"* and *"using aggregates
to ensure consistency"*). Reach for the stream form first: it adds no schema of yours at all, and
`ConcurrencyHarness` already classifies its refusal.

**Three things to know before choosing:**

- **`Store()` cannot conflict.** On an `IRevisioned` document it supplies the version the entity *already
  has*, and a revision is only rejected when the stored version is **equal or greater** than the one
  supplied — so it asserts something already true. `UpdateRevision(doc, doc.Version + 1)` is the mechanism;
  the `+1` is the whole thing. Three attempts to fix this by configuration failed because none of them
  changed *which number was supplied*. KIT-FINDINGS **AD14**.
- **The advisory lock is the odd one and often the best.** Because it locks before the read, the loser sees
  the winner's write and is refused by the **business rule** — so callers never retry and the budget is
  fully used rather than partly lost to conflicts. Ten writers against a budget for six give exactly
  `6 accepted, 4 refused`, every run. Prefer it when contention is low and a wait is cheaper than a retry.
- **DCB is additive, not a re-modelling.** The event is still appended to *its own* stream with the tag
  attached; the tag is a boundary marker, not a stream key. So an existing model keeps its stream layout
  and gains the boundary. It does need an `Id` on the boundary aggregate despite `dcb.md` saying otherwise.

**Nothing checks whether you chose right** — not a rule, not the compiler, not a test. Say which one, and
why, in `ARCHITECTURE.md`.

### The read side — the book gives three options, with the costs

| | On this stack | What it costs |
| --- | --- | --- |
| **Accept it, document it** | `Async`, and tests must `WaitForNonStaleProjectionDataAsync` | *"if a problem is not a problem, we should not try to fix it with technology just because we can"* |
| **Make it immediately consistent** | `Inline` — **what codegen picks for a single-stream view** | the book names three: the write side is no longer independently scalable; a projection error can abort the business transaction; every added projection slows the write |
| **A (partial) live model over the projection** | `FetchLatest` for the newest events, filling the gap inside the query | in-memory, so lost on restart. **Not in the kit's six-recipe menu as a combination** — the table lists live aggregation *or* a projection, never both layered |

**codegen follows the library rather than a house habit: single-stream `Inline`, multi-stream `Async`.** Marten has NO default — ProjectionLifecycle is a required argument — and its multi-stream page says outright: "Register the lookup projection inline and the multi-stream projection async". So the question here is whether that is right for *this* view — not whether to depart from a kit default. (It used to be a house habit, justified by two claims the mirror does not support; see KIT-FINDINGS MD.)

**And the book is explicit about who decides:**

> *"This issue should be discussed with the subject-matter-experts during one of the Event Modeling sessions
> to determine if this is acceptable… It's critical that this issue is discussed in detail and made
> transparent to everyone involved, as it could lead to hard-to-find bugs that are nearly impossible to
> reproduce."*

So **ask the user** whether a stale read is acceptable, and for how long. Do not decide it for them, and do
not answer it with technology because you can.

### Growth, and why snapshots are the last resort

> *"Often, it's better to limit the length of a stream naturally by understanding the business processes."*

Banks close the books after a day, a month, a year; the stock market settles after each trading day. A
business period in the stream key turns one endless stream into many short ones, and the book calls
snapshots *"the exception, not the rule"* — *"a technical workaround"*. Prefer the period. It is also the one
answer here that is a **model** change, per the exception above.

## 3 — write the decisions down

```
node tools/architect.mjs record       # a section per question, in <project>/ARCHITECTURE.md
```

Fill in three lines per question, and none of them is optional:

```
**Decision:** what was chosen
**Because:** why, in a sentence a reviewer can disagree with
**It costs:** the daemon, eventual consistency, a rebuild hazard, a model change
```

**`It costs:` is the line that matters.** A decision with no stated cost has not been made, it has been
assumed. And the reasoning is the whole point of the file: **nothing can check whether an answer is right** —
not a rule, not the compiler, not a test. The model validates, the code compiles, the suite is green, and the
choice can still be wrong. This file is the only artifact that will carry why.

Scaffolded, never overwritten: re-running `record` appends the new questions and keeps every answer already
there.

## 4 — write the race tests, because nothing else can

```
node tools/architect.mjs tests        # one race test per contended invariant
```

**This is the step that exists because a GWT cannot express it.** A GWT has one WHEN, by rule, so *"two
callers at the same instant"* has no home in the model — and must not get one. The business rule is *"one
member per desk per day"*; the race is how that rule is **enforced**. Putting it on a cell is finding T0
again. Finding *where* it matters is derivable, which is why it lives here.

It writes, into the project's own test project:

| | | |
| --- | --- | --- |
| `Concurrency/ConcurrencyHarness.cs` | **emit** — overwritten | `RaceAsync`, and the outcome classification |
| `Concurrency/<Slice>ConcurrencyTests.cs` | **scaffold** — kept | one per contended invariant |

Each scaffold has two tests and **neither is optional**:

1. **Deterministic, two-plus sessions.** Reliable, no timing, and it proves *the stream key* enforces the
   rule. This is the primary assertion.
2. **Through the real endpoint**, N callers via `Task.WhenAll`. It proves a **lost race becomes a sane
   response rather than a 500**. Note it asserts **at most** one success, not exactly one — see below.

### Four things measured before this harness existed, and each one would otherwise cost a wrong conclusion

All from `probes/concurrency-invariant.cs`, which you can re-run.

- **`Task.WhenAll` alone is not a race.** Released together, each caller then does its own read and the
  database serialises them. The first version reported *one winner, zero conflicts, nine refused by the
  rule* — a pass, with the concurrency guard never exercised. **Every writer reads and decides first, then
  the starting gun fires.** That is what `RaceAsync` does, and why it splits `decideAndStage` from the commit.
- **There are TWO refusal mechanisms with two exception types**, and which you get depends on whether the
  stream already existed:

  | | Refused by | Exception |
  | --- | --- | --- |
  | creating the stream — a first write to the key | the stream table's primary key | `ExistingStreamIdCollisionException` |
  | appending to a stream that exists | the optimistic version check | `EventStreamUnexpectedMaxEventIdException` |

  **Assert on the winner count, not on the loser's flavour**, unless you mean to pin the flavour.
- **The documented exception is not the one thrown.** Marten's `command_handler_workflow` page says
  `ConcurrencyException`; the pinned Marten throws `EventStreamUnexpectedMaxEventIdException`. The harness
  accepts either. This does *not* contradict the "docs win" rule — that rule is about which **design** to
  adopt; for an observable runtime fact the compiler is the tiebreaker.
- **You cannot easily prove the test bites by removing the Marten guard.** In Rich append mode even a bare
  `Append` carries a client-assigned version, so the loser still loses. **The control is the boundary:**
  key the stream per-operation instead of per-contested-thing and the rule collapses. Measured at **ten
  winners for one desk-day.** That is this whole question family in one number.

**Mutation-check at least one race test before believing it.** Temporarily point it at a per-operation key;
test 1 must fail. A green concurrency test is exactly the kind that proves nothing. Measured on Voltway:
`Won should be 1 but was 10`.

### The second test assumes an HTTP ENDPOINT, and a contended AUTOMATION slice has none

The scaffold hands you `Host.Scenario(...).ToUrl(<Slice>Endpoint.Route)`, which is right for a state-change
slice and impossible for an automation or translation one — those commands are issued by a trigger and have no
route at all. **Race the BUS instead**, and it is the better test rather than a workaround:

```csharp
var bus = Host.Services.GetRequiredService<IMessageBus>();
var outcomes = await Task.WhenAll(Enumerable.Range(0, 8)
    .Select(_ => bus.InvokeAsync<TheOutcome>(command)));
outcomes.Count(o => o.Succeeded).ShouldBeLessThanOrEqualTo(1, summary);
outcomes.Where(o => !o.Succeeded).ShouldAllBe(o => o.Rule == TheRule, summary);
```

`InvokeAsync` is the production path *and* the only path `OnException<...>().RetryTimes(3)` covers — which is
exactly why it is what caught **BS1**: the emitted policy retried the version-conflict exception and not the
stream-creation one, so a lost race on a stream-creating slice escaped unhandled. Five worked examples are in
`DemoAllPatterns`'s `Concurrency/` folder. **The scaffold should generate this shape when the slice has no
endpoint; it does not yet.**

## 5 — the gate

| | Must be true |
| --- | --- |
| `architect.mjs check` | no `QUESTION WITH NO SECTION`, no `DECISION STILL TODO`, no `RACE TEST NOT WRITTEN` |

**`RECORD DELIBERATELY ELSEWHERE` is the one other clean outcome**, and it is an acknowledgement rather than a
pass: a folder whose decisions genuinely live in another artifact says so in a ```architect-record-elsewhere`
fence in its `README.md`, naming the section that decides. Every question is still listed by `questions` — what
changes is that the *absence of ARCHITECTURE.md* stops being reported. The five reference implementations use it,
because each one's README is a measured comparison of mechanisms with their costs, which is richer than the
per-question sections `record` scaffolds; duplicating it would put one decision in two places.

**A project should almost never use this.** It exists for a folder whose entire purpose is to record a decision.
If you reach for it because writing the record is tedious, that is the wrong reason and the fence will read as an
excuse to whoever finds it.
| race tests | every `contended-invariant` has a race test whose deterministic half **passes**, and one of them has been mutation-checked against a wrong key |
| every decision | has all three lines, and `It costs:` is not "nothing" unless that is genuinely true |
| the mirror | was read. "Same as the reference implementation" is not an answer unless you checked for a closer fit |
| the model | still validates at zero errors — unless you deliberately changed the boundary, in which case say so and expect the ripple |
| the user | answered every question that is theirs: *is this staleness acceptable, and to whom* |

Then hand the record to `codegen`, which reports `ARCHITECTURE DECISIONS MISSING` if a claimed slice's
questions are unanswered. Carry the relevant `Decision:` sentences into the agent briefs — an implementing
agent that has to re-derive the consistency model will derive a different one.

## What this cannot do

- **It cannot tell you an answer is wrong.** Nothing can. That is why the reasoning is written down.
- **It cannot find a question the model does not imply.** It reads what is drawn; a missing edge or an
  unmodelled contention is invisible to it, exactly as it is to the completeness check.
- **`stream-growth` is not derivable and is not attempted separately.** Whether one stream grows without end
  depends on volume, which is domain knowledge — so it is folded into the boundary map as a prompt rather
  than claimed as a finding.
- **It cannot tell you the race test is right.** It scaffolds the harness and the shape; whether the two
  writers really contend over the thing the rule is about is judgement. Mutation-check it.
