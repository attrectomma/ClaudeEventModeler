# reservation — the two-step reserve → execute workflow

**Status: complete. 43 tests — 31 integration, 12 pure unit — all green, 0 warnings 0 errors.**
Both execution modes measured against one model, all five slices implemented end to end, every
load-bearing line mutation-checked.

*Understanding EventSourcing* **ch. 36**, the half that is a **workflow** rather than a concurrency
mechanism:

> *"The Reservation-Pattern always consists of two steps. Reservation … Execution."*
>
> *"…helps to synchronize concurrent access to a limited resource across aggregate boundaries … where
> relying on ACID transactions is either impossible or significantly limited."*

The mechanism half of that chapter is already built and measured next door: `cross-aggregate-invariant/`
arms 2 and 5 are its two implementations (a unique index; a stream-id collision). **This folder is not
about the guard.** It is about what the two steps cost, what happens when the second one fails, and the
one sentence in the chapter nobody had tested:

> *"Although it is modeled as Event, Read Model and Processor — the whole cycle of reservation and
> execution can be done within one single web-request."*

It is **not a domain**. Names carry no business claims.

---

## The finding that matters most is that nothing was added

**The Reservation Pattern needed no new notation, and that is the headline.** No `pattern="reservation"`,
no new attribute, no marker saying two slices are a pair. It is a **composition of the four patterns the
kit already has**:

```
reserve-slot   state-change   screen → ReserveSlot → Slot Reserved
issue-grant    automation     Slot Reserved → SlotsToIssue → GrantIssuer → IssueGrant → Grant Issued | Grant Refused
release-slot   automation     Grant Refused → SlotsToRelease → SlotReleaser → ReleaseSlot → Slot Released
```

A state change followed by an automation, with a second automation for the compensating path. The kit's
own cheat-sheet grammar covers every edge; `model.mjs validate` reports **0 errors, 0 warnings** and the
completeness check accepts the composition without being told anything about it — the reservation event
supplies the execute command exactly as any event supplies any downstream element.

That was the thing worth checking, and the check passed. **A fifth pattern would have been a mistake**,
because what makes this the Reservation Pattern is not a shape the notation lacks — it is which stream the
first step writes to, and that is `identity=` on a swimlane, which the kit already has.

---

## The model

`allocation/allocation.drawio` — 5 slices, 3 streams, 6 events, 15 GWTs, 0 errors 0 warnings.

| | |
| --- | --- |
| **Pool** stream (`poolId`) | `Pool Opened` — the limited resource, and its capacity |
| **Slot** stream (`poolId, slotNumber`) | `Slot Reserved`, `Slot Released` — **one stream per UNIT of the pool** |
| **Grant** stream (`grantId`) | `Grant Issued`, `Grant Refused` — what the reservation was *for* |

**The whole trick is in the second row.** A pool of N units is N streams, not a counter. Ch. 36 states it
for a unique value —

> *"there can only ever be one aggregate for a given ID at any point in time. So if we define the E-Mail
> address as the aggregate-id, it ensures that an E-Mail can only be taken once."*

— and this folder applies it to a **count**: enumerate the resource, and "no more than N holders" stops
being a running total two writers can both read. There are exactly N keys and each admits one holder.

---

## Where it stands

```
dotnet test

Passed!  -  Failed: 0,  Passed: 43,  Skipped: 0,  Total: 43
```

| | |
| --- | --- |
| 15 | GWT/GT scenarios generated from the model |
| 5 | reservation race tests, including a control that asserts the invariant BREAKS |
| 6 | execution-mode tests, each booting its own host, including two controls |
| 3 | todo-list tests, which exist because a mutation went uncaught — see below |
| 2 | cross-stream consistency tests: the guarded read, and a control proving the unguarded one commits |
| **12** | **pure decider unit tests — no container, no host, ~150 ms with Docker stopped** |

---

## The two execution modes, and what each costs

Both satisfy **every GWT unchanged** — the GWTs name the command, and neither mode changes what the
command does. Only what *sends* it differs, which is the automation folder's argument arriving at a slice
where the book itself licenses the second option.

| | **in-request** | **out-of-request** (the drawn shape) |
| --- | --- | --- |
| what wakes the execution | the reserve request itself | Marten `ISubscription` on `Slot Reserved` |
| async daemon | **not needed** | required |
| grant exists when the caller gets its answer | **yes** | no |
| compensating events on a refusal | all three, in the same request | all three, eventually |
| caller waits for the work | **yes** | no |
| **process dies between the two commits** | **the unit is held for ever and nothing knows** | the pending row survives; the next wakeup executes it |
| lines of registration | 0 | a subscription + `AddAsyncDaemon` |

**The last row is the real price of the book's sentence, and the book does not mention it.** "One web
request" removes the daemon, the subscription and everything that can be got wrong about waking a
trigger — and it removes the only record that there was work to do. Out-of-request keeps a pending row in
a durable store, which is precisely a *record of intent outside the moment*: the property the automation
folder identified as what a subscription buys over event forwarding, arriving here as the difference
between recovering a crash and not noticing one.

**Two commits, not one, in both modes.** It is tempting to read "one web request" as "one transaction",
and that would make the pattern pointless: if reserve and execute can be atomic, there is nothing to
reserve *against*. The pattern exists exactly where they cannot be — the execution calls something a
rollback cannot un-call — which is why `IGrantExecutor` is an interface and why a refusal is an **event**
rather than a rejected command.

`ExecutionModeTests` boots its own host per mode, posts a reservation through the ordinary endpoint, and
waits. **Nobody invokes the trigger.** `CONTROL_with_no_mechanism_nothing_is_ever_executed` is why the
other four mean anything.

---

## The measurements

### You cannot build a broken reserver on one stream, and finding that out reshaped the control

The obvious control for the race tests was the same enumerated slots appended *without*
`FetchForWriting`. **It does not reproduce.** Marten 9 refuses the second concurrent append with:

```
JasperFx.Events.EventStreamUnexpectedMaxEventIdException ::
  duplicate key value violates unique constraint "pk_mt_events_stream_and_version"
```

`Won=1, VersionConflict=1`, deterministically, with no optimistic-concurrency API involved anywhere. The
event table's own primary key is the guard.

**That is the Reservation Pattern's claim arrived at from the other side.** Once the contested thing *is*
a stream, the guarantee lives in the table rather than in anybody's discipline — `FetchForWriting` buys
the fold and a clean exception, not the safety. It also means a missing `FetchForWriting` on a
single-stream decider is not automatically a live over-allocation bug, which is worth knowing before
diagnosing one.

So the control had to be a different **design**: per-grant streams and a running total. Two writers both
count "0 of 1 used", both append to streams that share no row, Postgres has nothing to detect, and a pool
of one has two holders. That is arm 0 of `cross-aggregate-invariant/` in miniature, and it is exactly what
the enumeration makes unrepresentable.

### A create-collision is not enough once a unit can come back

`cross-aggregate-invariant/` arm 5 guards a reservation with `StartStream` — the stream table's primary
key refuses the second claim on a key. That is correct for ch. 36's e-mail address, which is claimed once
and never released.

**Here a refused execution gives the unit back**, so the second reservation of that slot finds a stream
that already exists and there is no creation to collide on. `Two_reservers_re_taking_a_freed_unit_only_one_wins`
asserts `StreamCollision == 0` for exactly this reason: what refuses the loser is the stream's **version**,
which means the decider must *fetch and fold* a `Held` flag rather than try to create.

Which is what the book's own code does — `@CreationPolicy(CREATE_IF_MISSING)` plus
`var reserved: Boolean = false` — even though its prose emphasises the creation trick. **Follow the
example, not the prose**, again.

### Ten callers, a pool of six, no side table

`Ten_callers_against_a_pool_of_six_get_exactly_six_units` runs ten concurrent reservations through the
real path. Exactly six succeed, each unit exactly once, four are told the pool is full — with **no guard
row, no unique index, no advisory lock and no DCB**. That is BOOK-INDEX §2 gap 2's prediction ("the
cheapest of them, and needs no extra row, index or lock") measured.

**What it costs is retries.** A reserver that loses slot 3 walks to slot 4, so taking the last unit of a
nearly-full pool can take O(capacity) round trips. The advisory-lock arm next door degrades into waiting
instead. And the resource has to be **enumerable** — a budget in currency has no slot numbers, which is
why that folder still exists.

### The ch. 32 hazard, reproduced deterministically — and it changed a registration

`codegen` registers a multi-stream view **Async**, following Marten's *"register the lookup projection
inline and the multi-stream projection async"*. Both todo Views here are multi-stream, so both got Async.
**That is wrong for a todo View**, and this folder is the first place in the kit where it is executable
rather than argued.

`CONTROL_an_async_todo_view_silently_loses_the_work` registers them Async and runs the in-request mode: the
reservation commits, the request wakes the trigger, and the async daemon cannot have caught up inside that
request — so the trigger reads an empty list, does nothing, and nothing ever wakes it again. **The unit is
held, the work is never done, and never compensated.** A 200 response, a clean log, a green suite.

That is *Understanding EventSourcing* ch. 32 exactly — *"entries get lost if the processor was running
before the model got updated"* — which BOOK-INDEX §2 gap 1 records as an open kit gap with no reference
implementation. **It now has one.**

**So `ViewRegistrations` registers both todo Views Inline**, and the reasoning is written at the line.
Marten's guidance is about a view somebody *reads*; a view an automation's **liveness** depends on is a
different animal. The costs are the ones the book names and they are real: the write side is no longer
independently scalable, and a projection exception now aborts the business transaction that appended the
event — a bug in a todo list can refuse a reservation. Accepted, because the alternative fails silently.

`PoolAvailability` stays **Async**, because nothing decides anything from it.

### A hint that is allowed to be wrong

The reserver reads `PoolAvailability` — an Async, deliberately stale view — to choose which slot to *try
first*. It cannot make the reservation wrong, only slower: an absent row leaves the candidate order at
1..capacity, which is also the correct order, and a row naming slots that have since been released merely
tries them last.

This is ANTI-PATTERNS #17 being **obeyed**, not dodged. The rule is "never assert an invariant on a read
model"; the limit here is asserted on the streams, and the view is asked a question whose wrong answer
costs a retry.

### A mutation went uncaught, and the model had already asked about it

`model.mjs validate` emits `derived-on-todo-view` for both todo Views, asking: *"would getting the fold
wrong change which events appear, and would a GWT catch that?"*

Measured: break `SlotsToIssue.Apply(GrantIssued)` so a successful grant never ticks its row off, and **all
26 tests still passed**. The note was right to ask, and the answer was no.

And the note's suggested remedy does not apply, which is the interesting part. The wrong fold does *not*
change which events appear — the row stays pending, every later wakeup re-issues, and `AlreadyIssued`
refuses each one, so the event stream is byte-identical. What happens instead is an unbounded leak of
**wasted work**: a decider call per wakeup per grant, for ever.

So there is no event-level scenario for it. `Automation/TodoListTests.cs` is the answer — three tests that
assert on the todo rows **on purpose**, and are deliberately not in `Slices/` because a slice's contract is
its events and none of this is part of it. With them, the same mutation fails exactly one test.

### The cross-stream read, and the hazard this folder shipped for a day

`issue-grant` appends to the Grant stream and only READS the Slot stream, to confirm the unit is still held.
No stream's version covers that — they share no row — and `ARCHITECTURE.md` first answered it with *"accept
the window"*.

`AlwaysEnforceConsistency = true` on the second `[WriteAggregate]` closes it, and the docs describe it for
exactly this: *"Marten will enforce an optimistic concurrency check on this stream **even if no events are
appended**."* Measured with a barrier that releases the slot between the middleware's fetch and its save:

| | outcome |
| --- | --- |
| **guarded** | `EventStreamUnexpectedMaxEventIdException` — *expected 1 but was 2*; the retry then refuses it by the ordinary `SlotNotHeld` rule |
| **control**, same interleaving, no check | **a grant issued against a unit already handed back** |

`CrossStreamConsistencyTests` pins both, and the control is green while asserting the invariant breaks.

**It does not generalise to `cross-aggregate-invariant/`**, which is the distinction worth carrying: that
folder's rule spans *every* Project stream of a Department, so there is no single referenced stream to
version-check and its five mechanisms stand. This one answers the narrower and far commoner shape — *read one
specific other stream, write this one*. "Cross-stream invariant" had been hiding two different problems.

**The first attempt at this test passed and proved nothing**, which is the control-shaped mistake the kit
already warns about: it raced two handlers that both only READ the slot stream, so nothing advanced it and
both correctly succeeded.

### Every decider here is a pure function, and that is new

`ReleaseSlotHandler` is `(command, state) -> (outcome, events)` and `IssueGrantHandler` is the two-stream
version of the same shape. Neither holds an `IDocumentSession`. That is Wolverine's aggregate handler
workflow — the **Decider pattern**, which its own docs name — and it is what `LEB` ch. 15 is asking for when
it warns that a handler gaining dependencies means *"you'll need a mocking framework"*.

**The kit believed this was unavailable here**, because a composite `(poolId, slotNumber)` key supposedly
had no single member for `[WriteAggregate]` to read. It reads a *member*, and a computed property is one.
KIT-FINDINGS **BM1**.

What it buys is `Deciders/` — **12 unit tests in ~150 ms with Docker stopped**, against 43 integration tests
taking over a minute. They do not replace the GWT tests, which are the only thing that can see a wrong stream
key or a missing registration. What they add is reach: `an_already_decided_grant_does_not_call_the_work_again`
asserts the executor was not invoked twice, which leaves **no trace in the event store** and is the one thing
that cannot be undone.

`reserve-slot` stays hand-rolled and says why: a decider that must **search** for its stream has no key to
hand the middleware. That is the honest limit of the workflow, as against the one the kit used to state.

### Mutation checks

Every load-bearing line was broken on purpose:

| Mutation | Fails |
| --- | --- |
| `ReserveSlotState.Apply(SlotReleased)` → no-op | `AReleasedSlotCanBeReservedAgain`, `Two_reservers_re_taking_a_freed_unit_only_one_wins` |
| the `Held` guard removed from the reserver | `ASecondReservationTakesTheNextSlot`, `APoolWithEverySlotTakenRefusesAReservation`, `Uncontended_reservations_that_fit_all_succeed` |
| `SlotsToIssue.Apply(GrantIssued)` → stays pending | `An_issued_grant_is_off_the_issue_list` — and **nothing at all** before `TodoListTests` existed |
| `SlotsToRelease.Apply(SlotReleased)` → stays pending | `A_refused_grant_moves_from_the_issue_list_to_the_release_list`, `Running_both_triggers_again_does_nothing_at_all` |

---

## Where the notation genuinely runs out

Three places, and none of them is an argument for new notation.

**1. The same GIVEN, the same WHEN, a different THEN.** `gwt-issue-1` issues a grant and `gwt-issue-3`
records a refusal, from identical prior state and an identical command — because whether the *work*
succeeds is not a fact about the system at all. Only the example data separates them: `$AcceptedGrant`
against `$RefusedGrant`. That is exactly what CLAUDE.md says an example is for — it specifies the how well
enough to **verify** and never well enough to **generate** — and it is the cleanest illustration of it in
the kit.

**2. `terminal=` has no kind for "an answer from the work the command performed".** `Grant Refused.reason`
comes from the executor's verdict. It is not `actor`, not `clock`, not `const`, and not really `generated`
either, which is what it had to be declared as. A `result` kind would fit, and one model wanting one is not
yet a case for adding it — recorded so it is a decision rather than an omission.

**3. Nothing says these two slices are a pair.** `reserve-slot` and `issue-grant` are a reservation and its
execution, and the model says only that one event feeds the other's todo list. That is arguably right —
the ordering is visible, left to right, which is what an event model is for — but it means "this
reservation has no executor" is not a checkable condition. See below.

## What this model does not do, deliberately

**There is no expiry.** A reservation whose execution never runs holds its unit for ever. Every mechanism
here recovers a *crashed* execution, and none recovers an execution that was never woken — in-request most
obviously, but a subscription whose checkpoint is manually advanced loses one just as permanently.

A real system needs a sweep that releases reservations older than some age, and it would be a **third
automation slice**, not a new mechanism: `Slot Reserved` → a stale-reservations View → a sweeper →
`ReleaseSlot`. It is left out because it teaches nothing this folder does not already teach, and because
adding it would make the *absence* of a recovery path invisible — which is the thing worth seeing.

**Two `accept the window` decisions in ARCHITECTURE.md used to depend on that absence — and are now
enforced instead.** `issue-grant` reads the Slot stream while appending to the Grant stream, and the original
answer reasoned that nothing would change it meanwhile because the only other writer is the compensation.
True of the model, enforced by nothing. `AlwaysEnforceConsistency = true` on that second `[WriteAggregate]`
makes Marten version-check the read stream anyway, and the interleaving it prevents is measured with a
control — see *The cross-stream read* below. The lesson generalises: **"accept the window" is an answer of
last resort, and it was reached here before checking whether the stack had a mechanism.**

---

## Running it

```bash
node tools/model.mjs validate reference-implementations/reservation/allocation/allocation.drawio
node tools/codegen.mjs      reference-implementations/reservation/allocation \
                            --project reference-implementations/reservation --out generated

cd reference-implementations/reservation/generated
dotnet test                                                      # all 29
dotnet test --filter "FullyQualifiedName~ReservationRaceTests"    # the 5 concurrency tests
dotnet test --filter "FullyQualifiedName~ExecutionModeTests"      # the 6 mode tests, own hosts
```

Needs Docker (Testcontainers). No `package-versions.json` and no `Directory.Build.props`: this folder runs
on the kit's own enforced stack — Marten 9.\*, Wolverine 6.\*, JasperFx 2.\*, Alba 8.\*.

**`architect` wants `<project>/diagrams/`, and this folder keeps its model in a named folder.** So the
record was produced against a scratch project and copied here:

```bash
mkdir -p /tmp/resv/diagrams && cp reference-implementations/reservation/allocation/allocation.drawio /tmp/resv/diagrams/
EM_PROJECT=/tmp/resv node tools/architect.mjs questions
EM_PROJECT=/tmp/resv node tools/architect.mjs record      # then answer, and copy ARCHITECTURE.md back
```

`architect.mjs tests` additionally expects `<project>/generated/<System>/`, which the reference-implementation
layout does not use — its scaffolds were generated the same way and then hand-replaced by
`ReservationRaceTests`, which asserts more than the scaffold does.

**To see the mechanisms actually bite, break one.** The four mutations in the table above are the ones that
were run; each names the test that must fail and no other.

---

## Findings this folder produced

`KIT-FINDINGS.md` **BL2** (codegen registers a **todo** View Async like any other multi-stream view, which
is the ch. 32 hazard shipped as a default) · **BL3** (a crashed codegen run leaves partial scaffolds that
the next run reports as `kept`) · **BL4** (`architect.mjs` and the reference-implementation layout disagree
about where `diagrams/` and `generated/` live) · **BL5** (the view scaffold's doc comment hard-codes
"registered INLINE in Program.cs" whatever lifecycle is emitted, and Program.cs is no longer where it is)
· **BL6** (`cross-stream-rule` fires on 8 of this model's 15 GWTs and exactly one is genuinely contended)
· **BL7** (`terminal=` has no kind for a value the work itself answers).

`KIT-HISTORY.md` **BL1** (a primitive array on a read model crashed `codegen.mjs` outright — fixed here)
· **BK2** (ch. 36, both halves — this folder is the second).
