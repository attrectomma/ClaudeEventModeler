# Architecture decisions

**What this file is.** The choices the event model deliberately leaves open, and the reasoning behind each
one. Generated as questions by `node tools/architect.mjs record` and answered by a human or the
`architect` skill against the library docs in the kit's `reference/llms/`.

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

`node tools/architect.mjs check` reports questions with no answer, answers still marked TODO, and answers
whose question the model no longer asks.


## THE WRITE SIDE — invariants, boundaries and races

### `stream-boundaries/allocation`

**Subject:** 3 stream(s) we append to, in allocation
**What the model says:** the boundary map as drawn:
      Pool keyed by (poolId) — written by 1 slice(s): open-pool
      Slot keyed by (poolId, slotNumber) — written by 2 slice(s): release-slot, reserve-slot
      Grant keyed by (grantId) — written by 1 slice(s): issue-grant
**The question:** Is each key the consistency boundary its invariants need, and does any of these streams grow without end? Both books: the aggregate IS the transactional consistency boundary.

Options, with what each costs:

- keep them — every invariant sits inside one key, so optimistic concurrency on the stream version enforces it
- widen a key so a contested thing lives in ONE stream — the rule becomes a true in-transaction invariant, at the cost of putting that key on every event of the stream and on the commands
- accept that a wider-than-key rule is a best-effort check against a projection, and say who agreed
- close the books on a long-lived stream by putting a business period in its key — the book prefers this to snapshots outright, and calls snapshots the exception rather than the rule

**Read first:** marten/events/appending and optimistic concurrency; the kit uses FetchForWriting<T>(streamKey) because [Aggregate] cannot resolve a composite key. For growth: marten snapshots, but read the book's preference for a business period first

**Decision:** **Keep them** — and note that `Slot` keyed by `(poolId, slotNumber)` is not an incidental key. It IS the reservation mechanism.

**Because:** The limited resource is *enumerated* into one stream per unit, so "at most `capacity` holders" is enforced by there being exactly `capacity` stream keys, each admitting one holder at a time. That is ch. 36's trick — *"there can only ever be one aggregate for a given ID at any point in time"* — applied to a count rather than to a unique value. No stream grows without end: a Slot stream gains one event per reserve/release cycle, a Grant stream at most two, and a Pool stream exactly one.
**It costs:** `(poolId, slotNumber)` is composite, so the WHOLE store is `StreamIdentity.AsString` and Wolverine's aggregate handler workflow is unavailable for **every** stream in the system — including `Pool` and `Grant`, which would each have qualified on their own. The reservation pattern's cheapness is paid for at the level of the store, not of the one slice that needs it. Second cost: the resource must be enumerable. A continuous quantity (a budget in currency) has no slot numbers, which is why `reference-implementations/cross-aggregate-invariant/` exists and needs a side table where this folder needs none.

### `cross-stream-rule/allocation/issue-grant/gwt-issue-2`

**Subject:** issue-grant: A grant already issued is not issued twice
**What the model says:** the command appends to Grant but this scenario's GIVEN lives in Slot, and it is a REJECTION
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **Make the contested thing ONE stream** — it already is, and this question is a **false positive**.

**Because:** The GIVEN names `Slot Reserved` for context, so the check sees a GIVEN outside the appended-to stream. But the fact that actually refuses the command is `Grant Issued`, which is on the **Grant** stream this command appends to — so `FetchForWriting<...>(grantId)` sees it, and the stream's own version covers the simultaneous duplicate that the rule alone would miss.
**It costs:** Nothing here. The cost is to the check: `cross-stream-rule` fires on **8 of this model's 15 GWTs** and exactly one of them (`gwt-reserve-3`) is genuinely contended. A check that cannot tell a *context* GIVEN from a *deciding* GIVEN answers by the dozen, which is how the one that matters gets skimmed. Recorded as a kit finding rather than answered away.

### `cross-stream-rule/allocation/release-slot/gwt-release-2`

**Subject:** release-slot: A slot already given back is not released twice
**What the model says:** the command appends to Slot but this scenario's GIVEN lives in Grant, and it is a REJECTION
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **Make the contested thing ONE stream** — it already is. Second false positive, same shape as `gwt-issue-2`.

**Because:** The deciding fact is `Slot Released`, on the **Slot** stream this command appends to. `FetchForWriting` on that stream catches the sequential duplicate through the fold and the simultaneous one through the version.
**It costs:** Nothing beyond the composite key already paid for under `stream-boundaries`.

### `cross-stream-rule/allocation/reserve-slot/gwt-reserve-3`

**Subject:** reserve-slot: A pool with every slot taken refuses a reservation
**What the model says:** the command appends to Slot but this scenario's GIVEN lives in Pool, and it is a REJECTION
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **Make the contested thing ONE stream** — already done, by drawing one Slot stream per unit of the pool. No guard row, no unique index, no advisory lock, no DCB.

**Because:** Two things are read from outside the Slot stream and they are not alike. `capacity` comes from `Pool Opened`, which is written once and never again — a read of an immutable value has no window to lose. What is genuinely contested is *which unit you get*, and that contention is entirely **inside one Slot stream**, where `FetchForWriting`'s optimistic concurrency already serialises it: two reservers who both pick slot 3 are two writers on `slot:{poolId}:3`, and one of them gets a `ConcurrencyException`. The invariant never spans streams, because the pattern renamed the contested thing INTO a stream id.
**It costs:** A reserver that loses the race for slot N must retry on N+1, so contention becomes **retries** rather than conflicts — worst case O(capacity) round trips to take the last slot in a nearly-full pool. Compare the four mechanisms in `cross-aggregate-invariant/`: the advisory lock degrades into waiting, the other three into retrying, and so does this. What this one buys over all of them is that nothing extra is written, indexed or locked.

**And one thing it buys that was not expected, measured while trying to write the control.** The obvious control — the same enumerated slots appended WITHOUT `FetchForWriting` — does not reproduce a double-booking. Marten 9 refuses the second concurrent append to one stream on `pk_mt_events_stream_and_version`, the event table's own primary key: `Won=1, VersionConflict=1`, deterministically, message *"duplicate key value violates unique constraint"*. **So there is no careless way to double-book an enumerated unit** — the guarantee is in the table, not in the API call, and `FetchForWriting` buys the fold and a clean exception rather than the safety. The control that does reproduce had to be a different DESIGN (a running total across per-grant streams), which is the point of the pattern restated from the other side. Worth knowing before assuming a missing `FetchForWriting` elsewhere is a live bug.

### `cross-stream-rule/allocation/issue-grant/gwt-issue-1`

**Subject:** issue-grant: A reserved slot is executed into a grant
**What the model says:** the command appends to Grant but this scenario's GIVEN lives in Slot
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** ~~Accept the window.~~ **ENFORCE IT** — a second `[WriteAggregate]` on the Slot stream with `AlwaysEnforceConsistency = true`. *Re-decided 2026-08-09.*

**Because:** The first answer reasoned that the only other writer to the Slot stream is the compensation, which cannot run until this execution has refused — true of the model, **enforced by nothing**, and exactly the class of answer that is right until somebody adds a slice. Then the mechanism turned out to exist and to be one attribute property: Marten *"will enforce an optimistic concurrency check on this stream **even if no events are appended**"*. **Measured with a barrier** that releases the slot between the middleware's fetch and its save — guarded, the save is refused with `expected 1 but was 2`; unguarded, the grant is issued against a unit somebody had already handed back. Both arms are pinned by `CrossStreamConsistencyTests`, and the control is green while asserting the invariant breaks. So this was never a window that reasoning made safe; it was a live hazard that nothing had provoked.
**It costs:** A read is now a contention point — an unrelated release of the same slot makes this command **retry** rather than proceed, and the retry policy is what turns that into a clean refusal instead of a 500. Correct here, because the alternative is a grant against a unit nobody holds; it would be the wrong trade on a hot stream read by many slices, where the honest answer really is to accept the window and say who agreed.

### `cross-stream-rule/allocation/issue-grant/gwt-issue-3`

**Subject:** issue-grant: Execution the work refuses is recorded as a fact rather than thrown away
**What the model says:** the command appends to Grant but this scenario's GIVEN lives in Slot
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **ENFORCE IT** — same as `gwt-issue-1`, and the same one attribute property covers both scenarios. *Re-decided 2026-08-09.*

**Because:** Same read of the same `Slot Reserved`. The refusal path matters as much as the happy one: an execution that refuses against a slot somebody else already released would open a compensation row for a unit that is not held, and `release-slot`'s `NotHeldByThisGrant` rule would then be the only thing between that and a unit handed back twice.
**It costs:** Same retry-under-contention as `gwt-issue-1`.

### `cross-stream-rule/allocation/release-slot/gwt-release-1`

**Subject:** release-slot: A refused grant gives its slot back
**What the model says:** the command appends to Slot but this scenario's GIVEN lives in Grant
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **Accept the window.**

**Because:** `Grant Refused` is terminal for that grant — nothing in this model ever un-refuses one — so a read of it cannot go stale between the read and the append.
**It costs:** It stops being true if a refused grant can later be re-issued. Then the release and the re-issue race, and the slot could be handed back while an execution is live.

### `cross-stream-rule/allocation/reserve-slot/gwt-reserve-1`

**Subject:** reserve-slot: The first reservation takes the lowest slot
**What the model says:** the command appends to Slot but this scenario's GIVEN lives in Pool
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **Accept the window** — the only fact read from `Pool` is `capacity`.

**Because:** `capacity` is written once by `open-pool` and by nothing else, so between the read and the append it cannot have changed. The window the question asks about is empty.
**It costs:** It is empty **only while capacity is immutable**. A future slice that raises or lowers a pool's capacity makes this and the two scenarios below genuinely contended, and neither the model, the compiler nor the suite would notice — this paragraph is the only thing that would.

### `cross-stream-rule/allocation/reserve-slot/gwt-reserve-2`

**Subject:** reserve-slot: A second reservation takes the next slot
**What the model says:** the command appends to Slot but this scenario's GIVEN lives in Pool
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **Accept the window** — same as `gwt-reserve-1`.

**Because:** `capacity` is immutable after `Pool Opened`. What decides *which* slot this scenario gets is the occupancy of the Slot streams, which is not a cross-stream read at all: the decider attempts each slot stream in turn and the stream's own version answers.
**It costs:** Same as `gwt-reserve-1`: it stops being true the day capacity becomes mutable.

### `cross-stream-rule/allocation/reserve-slot/gwt-reserve-4`

**Subject:** reserve-slot: A released slot can be reserved again
**What the model says:** the command appends to Slot but this scenario's GIVEN lives in Pool
**The question:** Enforcing this means reading another stream. What happens if that stream changes between the read and the append?

Options, with what each costs:

- accept the window — the far stream rarely changes and a late write is tolerable. Say so, and say who agreed
- make the contested thing ONE stream, so the rule is an in-transaction invariant instead of a read
- compensate — let it through and emit a correcting event when the conflict is detected later
- GUARD ROW — one IRevisioned document per boundary, written with UpdateRevision(doc, doc.Version + 1) in the SAME transaction as the append. Costs: every write in the boundary contends on one row. NOTE Store() cannot conflict; the +1 is the mechanism
- RESERVATION ROW — a unique index on (boundary, sequence), inserted (never Store()) beside the append. Costs: a row per write, unbounded, and the sequence is an O(rows) count. Leaves an audit trail
- ADVISORY LOCK — pg_advisory_xact_lock on the boundary key, taken BEFORE the read, on a transaction you own via Marten.Services.SessionOptions.ForTransaction. Costs: serialises the boundary, so contention becomes latency. Buys: the loser is refused by the ORDINARY RULE, so nothing retries
- DCB — FetchForWritingByTags, with Marten maintaining mt_dcb_tag_version. Additive: the event still goes to its own stream with the tag attached. Costs: nothing beyond the current stack

**Read first:** marten/events/dcb (FetchForWritingByTags, the mt_dcb_tag_version side table) and marten/documents/concurrency (UpdateRevision, and why Store() asserts a version already true). Reading another stream is session.Events.FetchLatest<T>(streamKey) on IDocumentSession.Events, not the query session. Worked comparison: reference-implementations/cross-aggregate-invariant/

**Decision:** **Accept the window** — same as `gwt-reserve-1`.

**Because:** Same immutable `capacity`. The interesting half of this scenario is not cross-stream: a released slot's stream ALREADY EXISTS, so re-reserving it is a fetch-and-fold on that stream, not a create — which is what stops the reserve decider being a bare `StartStream` collision (arm 5 of `cross-aggregate-invariant/`) and makes it the book's `ReserveEmailAggregate`, with its `reserved` flag, instead.
**It costs:** The fold has to be right: a `Slot Released` that the fold ignores would make the slot permanently unavailable, and the pool would quietly shrink. Pinned by `gwt-reserve-4` and by nothing else.

## THE READ SIDE — how stale may it be, and what is one row

### `stale-read/allocation/PoolAvailability`

**Subject:** PoolAvailability
**What the model says:** fed by 2 stream types (Pool, Slot), which codegen registers ASYNC, per Marten's own guidance; and pool-desk both displays it and issues a command that feeds it — the user reads their own write
**The question:** How stale may this be, and who agreed to that? The book says to settle this with the subject-matter experts, because it causes bugs that are nearly impossible to reproduce.

Options, with what each costs:

- accept it — Async, and document the window. The book: "if a problem is not a problem, we should not try to fix it with technology just because we can"
- make it immediately consistent — Inline, in the same transaction. Costs the book names: the write side is no longer independently scalable, a projection error can abort the business transaction, and every added projection slows the write
- a (partial) live model over the projection — FetchLatest for the last events, filling the staleness gap in the query. In-memory, so lost on restart

**Read first:** marten/events/projections/ — registration, ProjectionLifecycle, and Marten's own warning about Inline on multi-stream. Tests on an Async view need WaitForNonStaleProjectionDataAsync (Marten.Events.TestingExtensions)

**Decision:** **Accept it — Async — because this row is a HINT with no authority over anything.**

**Because:** It is the one place in this model where staleness is deliberately harmless. The reserve decider never reads it: it reads `Pool` for capacity and the Slot streams for occupancy. A stale row can only make the handler's opening guess wrong, and a wrong guess costs one retry. That is also what makes the read-your-own-write on `pool-desk` acceptable — a reserver who does not yet see their own slot taken and asks again gets a *different* slot, never the same one twice. ANTI-PATTERNS #17 is the rule being obeyed here, not dodged: the invariant is asserted on the event store and the projection is allowed to lag.
**It costs:** The async daemon, and every test that asserts on this view must `WaitForNonStaleProjectionDataAsync` where an Inline view would simply be read. The screen can also under-report availability, so a human may be told a pool is full moments after a release landed; refreshing fixes it and nothing else does.

### `stale-read/allocation/SlotsToIssue`

**Subject:** SlotsToIssue
**What the model says:** fed by 2 stream types (Slot, Grant), which codegen registers ASYNC, per Marten's own guidance
**The question:** How stale may this be, and who agreed to that? The book says to settle this with the subject-matter experts, because it causes bugs that are nearly impossible to reproduce.

Options, with what each costs:

- accept it — Async, and document the window. The book: "if a problem is not a problem, we should not try to fix it with technology just because we can"
- make it immediately consistent — Inline, in the same transaction. Costs the book names: the write side is no longer independently scalable, a projection error can abort the business transaction, and every added projection slows the write
- a (partial) live model over the projection — FetchLatest for the last events, filling the staleness gap in the query. In-memory, so lost on restart

**Read first:** marten/events/projections/ — registration, ProjectionLifecycle, and Marten's own warning about Inline on multi-stream. Tests on an Async view need WaitForNonStaleProjectionDataAsync (Marten.Events.TestingExtensions)

**Decision:** **Make it immediately consistent — INLINE.** A deliberate departure from codegen's multi-stream default and from Marten's own guidance, and the one decision in this file that was changed by measuring rather than by reasoning.

**Because:** Marten's *"register the lookup projection inline and the multi-stream projection async"* is guidance about a view somebody **reads**. A todo View is not that: an automation's liveness depends on it, and UES ch. 32 names the failure exactly — *"entries get lost if the processor was running before the model got updated"*. Async here means a wakeup can arrive before the row exists, the trigger reads an empty list, and the reservation is never executed and never compensated. **Reproduced deterministically** rather than argued: `ExecutionModeTests.CONTROL_an_async_todo_view_silently_loses_the_work` registers these Async, reserves through the real endpoint in in-request mode, and the grant is never issued — a 200 response, a clean log, a held unit, and no work. Inline puts the row in the append's own transaction, so anything woken by `SlotReserved` finds it already committed. This is the kit's standing *"where the kit and the docs disagree, the docs win"* rule meeting its first real exception, and the reason it is an exception is that the docs' sentence is about a different kind of view.
**It costs:** Exactly what the book says Inline costs, and both are real here. The write side is no longer independently scalable, and **an exception in either projection aborts the business transaction that appended the event** — so a bug in a todo list can now refuse a reservation. Accepted, because the alternative is losing work silently, which nothing would report. The alternative fix — keep Async and require a wakeup that gets asked **again** (a subscription's re-delivered page, a clock's next tick) — was rejected because it makes the read-side decision silently constrain the automation decision, and nothing would check that the two still agree.

### `stale-read/allocation/SlotsToRelease`

**Subject:** SlotsToRelease
**What the model says:** fed by 2 stream types (Grant, Slot), which codegen registers ASYNC, per Marten's own guidance
**The question:** How stale may this be, and who agreed to that? The book says to settle this with the subject-matter experts, because it causes bugs that are nearly impossible to reproduce.

Options, with what each costs:

- accept it — Async, and document the window. The book: "if a problem is not a problem, we should not try to fix it with technology just because we can"
- make it immediately consistent — Inline, in the same transaction. Costs the book names: the write side is no longer independently scalable, a projection error can abort the business transaction, and every added projection slows the write
- a (partial) live model over the projection — FetchLatest for the last events, filling the staleness gap in the query. In-memory, so lost on restart

**Read first:** marten/events/projections/ — registration, ProjectionLifecycle, and Marten's own warning about Inline on multi-stream. Tests on an Async view need WaitForNonStaleProjectionDataAsync (Marten.Events.TestingExtensions)

**Decision:** **INLINE** — same reasoning as `SlotsToIssue`, and the two move together.

**Because:** Same hazard, worse in kind rather than in degree: a row lost from the ISSUE list leaves work undone, while a row lost from the RELEASE list leaks a unit of a limited resource **permanently**. This projection is the last thing standing between a failed execution and a pool that has silently shrunk. The two lifecycles are also deliberately not independently settable — measuring one Async while the other is Inline would be comparing two systems rather than two lifecycles.
**It costs:** The same two costs, and the compensating path is the one nobody exercises in production — so it is where a silently-lost row would go unnoticed longest, which is what tips the balance rather than any general preference for Inline.

## AUTOMATIONS — is running it twice safe

### `replay-safety/allocation/issue-grant`

**Subject:** issue-grant
**What the model says:** pattern=automation, so something wakes it without a human
**The question:** Is running this twice safe? A replay, a redelivery and a restarted sweep all do it.

Options, with what each costs:

- idempotent by construction — the todo View no longer selects the row once its own event ticks it off
- dedupe on a value carried by OUR OWN event (a notice id), which is the one place a foreign id legitimately crosses
- guard the trigger so it never re-fires on replay, and accept that a genuine re-run then needs a hand

**Read first:** wolverine/durability (inbox, dead letters) and marten/events/projections/rebuilding; the kit's automation folder measures four wakeup mechanisms

**Decision:** **Idempotent by construction, and the fold is not enough on its own — both guards.**

**Because:** The todo view stops selecting the row once `Grant Issued` or `Grant Refused` ticks it off, which catches the *sequential* duplicate. It does not catch the *simultaneous* one: two runs can both read the row before either appends, and both then legitimately pass the `AlreadyIssued` rule. What stops the second is the Grant stream's own version — `FetchForWriting` captured it, so the second append collides. The `automation/` folder measured this exact pair under a genuine double delivery.
**It costs:** The collision has to be **translated** into `AlreadyIssued`, or a duplicate delivery surfaces as a failed message, a logged stack trace and a Wolverine retry — which is how a passing test once printed what looked like a failure. That translation is hand-written and nothing checks it exists.

### `replay-safety/allocation/release-slot`

**Subject:** release-slot
**What the model says:** pattern=automation, so something wakes it without a human
**The question:** Is running this twice safe? A replay, a redelivery and a restarted sweep all do it.

Options, with what each costs:

- idempotent by construction — the todo View no longer selects the row once its own event ticks it off
- dedupe on a value carried by OUR OWN event (a notice id), which is the one place a foreign id legitimately crosses
- guard the trigger so it never re-fires on replay, and accept that a genuine re-run then needs a hand

**Read first:** wolverine/durability (inbox, dead letters) and marten/events/projections/rebuilding; the kit's automation folder measures four wakeup mechanisms

**Decision:** **Idempotent by construction, both guards** — same as `issue-grant`.

**Because:** `Slot Released` ticks the row off the release list, and the Slot stream's version catches the simultaneous duplicate through `AlreadyReleased`. This one matters more than its twin: a second release hands the *same unit* back twice, so the pool would grow past its own capacity — the limit the whole folder exists to hold would be broken by the compensation meant to protect it.
**It costs:** Same translation, hand-written, unchecked.

## THE STACK BINDING — what a domain type IS in C#

### `type-binding/allocation`

**Subject:** 4 distinct domain type(s) in allocation
**What the model says:** Guid (PoolAvailability.poolId), int (PoolAvailability.capacity), DateTimeOffset (Pool Opened.openedAt), string (SlotsToIssue.status)
**The question:** What is each of these in C#? Every one has an unambiguous proposal, so confirm the table and say what it costs.

Options, with what each costs:

- accept the proposed table — every binding is the obvious one, and the record is where a reviewer can disagree
- override a fractional type: the proposal is decimal for ALL of them, because money is the common case here and binary floating point is wrong for money. A field that is genuinely a measurement should say double and say why
- override a time type: DateTimeOffset carries an offset and DateTime does not, and a stream keyed on a business period cares which
- rename in the MODEL instead, if the domain word is simply wrong — that is a domain fact and goes back to add-slice, not here

**Read first:** no library page decides this. reference/llms/marten/documents/json for how a type is persisted, and marten/events/appending for what a stream key may be

**Decision:**

```type-bindings
Guid           -> Guid
int            -> int
DateTimeOffset -> DateTimeOffset
string         -> string
```

**Because:** Every type this model names is already a C# type, because the model was authored on this stack rather than translated onto it. There is nothing to decide, and the block is recorded anyway so that a later `UUID` or `Double` has a place to land where a reviewer sees it.
**It costs:** Nothing at runtime. But an identity table is **not** the same as no table: with no block at all, `codegen` reports `UNBOUND TYPE`, and KIT-FINDINGS **Z6** says a first pass carrying an unbound type has to be regenerated from scratch — views, folds and GWT tests are `scaffold` and therefore KEPT with the wrong type baked in. Recording it before the first scaffold is what makes that a non-event.
