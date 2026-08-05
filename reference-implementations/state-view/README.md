# State view — one green box, six Marten recipes

`Event(s) → View` is the whole contract of a view slice. It says a read model is derived from those events
and from nothing else. It does **not** say the view is a projection, does not say which kind, and does not
say a document exists at all.

```
campaigns/     the model — 9 slices, 28 elements, 0 errors / 0 warnings / 26 notes, 2880px
generated/     five views, six recipes. 21 tests, stable across repeated runs
```

Five view slices over **two stream types**, so that the recipes can be compared against one model. The write
side — four command slices — exists only to produce the events; it is the thinnest legal implementation of
each, and it refers to `../state-change/` rather than re-deriving anything.

| view | `identity=` | recipe | lifecycle | one row is |
| --- | --- | --- | --- | --- |
| `MessageStatus` | `messageId` | **self-aggregating snapshot**, *and the same fold read live* | Inline | one stream |
| `DeliveryLog` | `messageId, recipient` | **`EventProjection`** — one event, many rows | Inline | one recipient of one message |
| `CampaignDashboard` | `campaignId` | **`MultiStreamProjection`** across **two stream types** | **Async** | one campaign |
| `SenderMonthly` | `senderId, month` | **`MultiStreamProjection`** across **many streams of one type** | Inline | one sender in one month |
| `MessageMetrics` | `messageId` | **`FlatTableProjection`** — a SQL table, not a document | Inline | one message |

**Every one of those five was scaffolded by the generator as a single- or multi-stream projection registered
Inline, and four of the five ended up somewhere else.** That is not a generator defect. `identity=` narrows
the choice and cannot settle it, so the generator emits the default and the choice is a hand edit that
regeneration keeps — see *The seam that made this possible* below.

`MessageStatus` and `MessageMetrics` deliberately share a grain. The drawing for the two is identical and
nothing in the model distinguishes them; one is a JSONB document you load by id, the other is columns you
answer with `GROUP BY`. **The duplication is the comparison.**

---

## What each recipe is actually for

Not a ranking. The question each answers is different, and picking by familiarity rather than by the question
is the failure this folder exists to prevent.

**Live aggregation and a snapshot are the same fold, one line apart.** This surprised me and it is the most
useful thing here. Putting the `Apply` methods on the record itself rather than on a separate
`SingleStreamProjection` class means `Projections.Snapshot<T>(Inline)` stores it and
`session.Events.AggregateStreamAsync<T>(id)` folds it live — same type, same code, and
`TheStoredSnapshotAndTheLiveFoldAreTheSameValue` asserts they are equal by value on a stream carrying every
event type. So "live vs projected" is not an architectural fork; it is a registration line, reversible, and
what differs is the read API. Choose on read volume: live costs a fold per read and can never be stale, a
snapshot costs a row per write and a rebuild whenever the fold changes.

**`EventProjection` is the only recipe that is not an aggregation.** Every other one folds many events into
one row; this takes one event and writes many. One `MessageQueued` with three recipients produces three
`DeliveryLog` documents. No `Identity<T>` can express that — Identity maps an event to exactly one row.

The model said so before any code existed: `identity="messageId, recipient"` on a view fed only by an event
whose grain is `messageId`. **A view finer-grained than every event feeding it is the tell for this recipe.**

**Two multi-stream projections, two different problems.** Worth separating because the phrase covers both:

- `CampaignDashboard` spans **two stream types**. The difficulty is that two of its five events don't carry
  the key.
- `SenderMonthly` spans **many streams of one type**. Every event is the same type from the same kind of
  stream; the difficulty is that one row spans an unbounded number of them.

**The flat table is for questions answered across rows.** "Delivery rate per campaign" is a `GROUP BY`; a
document store answers it by loading every row into memory. There is no `MessageMetrics` C# type, and that
is not an omission — the read model *is* the table, and a class mirroring it would be a second place the
same schema lives. The test reads it in SQL, which is how any consumer would.

---

## The findings

Everything below was produced by compiling and running, not by reading. Each is something that compiles
clean, passes a green suite, and is wrong.

### 1. Keying on event metadata keys on the APPEND time, not the business time

`SenderMonthly` is keyed `senderId + month`, and `month` is not a field of any event — it comes from
`IEvent.Timestamp`. That is what `Identity<IEvent<T>>` is for, and it works.

Then the app was run by hand. The seed data carries `queuedAt = 2026-01-15` in every payload. The row came
out keyed **`2026-08`**, because `IEvent.Timestamp` is stamped by Marten *when the event is written* and
ignores the payload entirely.

For a backfill, an import, or a replay, that is simply the wrong month. Nothing says so: it compiles, the
tests pass — `row.Month.ShouldBe($"{UtcNow:yyyy-MM}")` passes *because* it is append time — and the report
is wrong. **This recipe answers "messages appended in month M".** If the question is "messages *sent* in
month M", the month must come from `e.Data.QueuedAt`, the payload field the model already declares, and then
no envelope is needed at all.

Kept as-is, because demonstrating metadata keying is the point of that file and the trap is worth more
written down than avoided.

### 2. A custom grouper's safety depends on a registration line in another file

The docs warn that if a `MessageQueued` and a `MessageDelivered` for the same message land in the **same
batch**, a grouper that only queries its lookup table finds no row yet, drops the outcome event, and raises
nothing. So the grouper here scans the batch's own events first.

Removing that scan and re-running: **the test still passed.** Not because the docs are wrong, but because
`MessageCampaignLinkProjection` is registered `Inline`, so its row is committed in the append's own
transaction and is already there when the daemon groups the page. Switching that one line to `Async`
reproduced the failure exactly as described:

```
Shouldly.ShouldAssertException : row.Delivered should be 1 but was 0
```

Measured, all four combinations:

| lookup lifecycle | batch scan | same-batch outcome |
| --- | --- | --- |
| Inline | off | counted |
| Inline | on | counted |
| **Async** | **off** | **silently lost** — `Delivered == 0`, nothing thrown, nothing logged |
| Async | on | counted |

Both protections are kept. Not because they are both needed *here*, but because the batch scan makes the
grouper correct **independently of a registration line in a different file**, and the failure mode is a
number that is quietly wrong.

**The lookup itself is not on the event model, deliberately.** Nobody reads it, no screen displays it, it
answers no business question. It is a mechanism — the index that lets an outcome event find its campaign —
and putting it on the model would be modelling the implementation. `AnOutcomeEventThatCarriesNoCampaignIdStillLandsOnTheRightCampaign`
asserts it exists anyway, because a reader who finds an unexplained document type deserves to find a test
naming it.

### 3. `EventProjection` does not clean up after itself, and forgetting is silent

Because an `EventProjection` writes through ad-hoc `ops.Store` calls, Marten cannot infer which document
type it produces and **will not clear the table on a rebuild**. The rows that *are* regenerated get upserted
over and look correct, so nothing complains — until an INSERT-only bulk-copy rebuild hits a duplicate key.
Every aggregation recipe gets this for free from its declared view type.

`Options.DeleteViewTypeOnTeardown<DeliveryLog>()` fixes it, and
`ARebuildOfAnEventProjectionClearsRowsNoEventProduces` makes it observable: it plants a row no event
produces, rebuilds, and asserts the row is gone *and* the real one is back. Deleting the constructor line
makes that test fail — verified, not assumed.

### 4. `FlatTableProjection` cannot hold a derived column, and the model is not wrong

The model declares `recipientCount` on `MessageMetrics`, derived by counting `recipients`.
`FlatTableProjection.Map` takes a **member**, and `x.Recipients.Length` is not one; the declarative API has
no compute step. So the column is not there.

This is a real gap between a model and a recipe, and neither is at fault: the model says what a row holds,
this recipe cannot hold all of it. The honest options are to answer the count from `DeliveryLog` or
`MessageStatus` (done here), or to drop to `EventProjection` + `QueueSqlCommand` — Marten's own documented
escape hatch for what the declarative API cannot express, and effectively a **seventh** recipe, at the cost
of writing the upsert SQL by hand.

The other half of the flat table is a safety property rather than a limitation: an event that populates less
than every non-primary-key column generates an **UPDATE-only** function, so `MessageDelivered` cannot create
a half-filled row. Confirmed in the app's own startup log —
`mt_upsert_message_metrics_messagedelivered($1)`, one parameter, versus four for the queue event. It also
means the stream **must** start with the full-mapping event, which this model guarantees because
`MessageQueued` opens every Message stream.

### 5. Four namespaces and one signature the docs get wrong or never state

Every one cost a compile. The mirror removes most of the guessing, not all of it — reflection over the
assembly settled all five in about a minute each.

| Believed from the docs | Actually |
| --- | --- |
| `IEventGrouping<T>` sits with `IAggregateGrouper<T>` | `JasperFx.Events.Grouping`, while `IAggregateGrouper` is `Marten.Events.Aggregation` |
| `IAggregateGrouper.Group` takes `IReadOnlyList<IEvent>` (the docs say so explicitly) | `IEnumerable<IEvent>` |
| `SchemaNameSource` is a Weasel type | `Marten.Events.Projections.Flattened`, next to `FlatTableProjection` |
| `SnapshotLifecycle` sits with `ProjectionLifecycle` | `Marten.Events.Projections`, while `ProjectionLifecycle` is `JasperFx.Events.Projections` — two enums for one idea, in two assemblies |
| `WaitForNonStaleProjectionDataAsync` is an `IDocumentStore` member | an extension in `Marten.Events.TestingExtensions`. Every doc page calls it bare, with no `using` shown |

### 6. A modelling gap the implementation could not avoid inventing past

`RecordOutcome` takes an `outcome` string. The model declares rules for `delivered` and `bounced` and
**none for anything else**, and an endpoint has to do something. It refuses with `UnknownOutcome` — a rule
name that exists in the code and nowhere in the model, which is exactly the invention this kit exists to
prevent.

It is recorded here rather than quietly added to the model, because adding it is the domain expert's call.
It should become a GWT with `enforce="periphery"`. `CloseCampaign`'s `NotOpened` is the same shape: the model
gives a rule for closing a *closed* campaign and none for closing one that was never opened.

---

## The seam that made this possible

The read-side registrations used to be inline in `Program.cs`, which is `emit()` and therefore overwritten —
so **every read-side decision an implementer made was lost on the next regeneration.** Four of the five
views here needed one.

Two generator changes, both derived from this model rather than assumed:

**`Views/ViewRegistrations.cs` is now `scaffold()`**, with `Register(StoreOptions)` and
`ConfigureStore(marten)`. `Program.cs` calls both and stays total and idempotent. The second hook exists
because `AddAsyncDaemon` is registered on the Marten *chain* rather than on `StoreOptions` — without it,
"Async" could not be chosen from a scaffold at all. It is the same shape as the automation folder's
`Configure*` hooks, for the same reason.

**A view's document id is no longer assumed to be the stream id.** It was, and the generated code did not
compile: `DeliveryLog` is keyed `(messageId, recipient)` and `SenderMonthly` `(senderId, month)`, neither of
which is a stream key. The rule now mirrors the one already used for `StreamIdentity` — a single-field
`identity=` is that field's type, a composite is `string` — and `Identity<T>` stops interpolating a lone Guid
into a string, which was the actual compile error. Verified no regression: the other two folders' view files
regenerate byte-identical, and both suites still pass (10 and 15).

One more, found by the build rather than by this model: a command record with a nullable field emitted
`CS8669`, because the `<auto-generated>` banner makes the compiler demand an explicit `#nullable enable`
even though the csproj sets it. Emitted now only when a field actually needs it.

---

## Running it

```bash
cd generated && dotnet build && dotnet test        # 21 tests, Testcontainers Postgres
```

**And run it, because a green suite cannot tell you an async projection is processing.** With
`AddAsyncDaemon` missing, `CampaignDashboard` would be permanently empty and Marten would only log a warning
at startup — the same failure shape the automation folder documents. Booting the app is what proves it:

```bash
docker run -d --name campaigns-demo -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=campaigns \
  -p 5433:5432 postgres:16-alpine
ASPNETCORE_ENVIRONMENT=Development dotnet run --project src/Campaigns   # env VAR, not --environment
```

What the log then shows, with nobody calling anything:

```
Started HighWaterAgent for database postgresql://localhost/campaigns/campaigns
Started projection agent CampaignDashboard:All
Shard 'CampaignDashboard:All': Executed updates for Event range of 'Identity: CampaignDashboard:All', 0 to 5
```

and all five views populated from `GenesisData` — including the flat table, whose migration only runs in a
real host:

```
 nm                 | st   | q | d | b
 January newsletter | Open | 2 | 1 | 1
```

That last query is also how finding #1 was found. Query the documents with **camelCase** keys —
`data->>'name'`, not `data->>'Name'` — because `Program.cs` sets `Casing.CamelCase`. PascalCase returns a
row of nulls, which reads exactly like a projection that ran and folded nothing.

## Status

Model built and validated at zero errors. Six recipes implemented, **21 tests passing**, stable across
repeated runs, and the two tests carrying the load-bearing claims — the `EventProjection` teardown and the
grouper's batch scan — were each **verified to fail** when the thing they test is removed. The app has been
run by hand and the async daemon observed processing unaided.

What is **not** settled: whether the generator should try to infer a recipe at all. It currently infers the
lifecycle-neutral default and reports nothing, which means a view left on the wrong recipe is invisible.
A check that a view whose `identity=` is finer-grained than every event feeding it *cannot* be an
aggregation would have caught `DeliveryLog` mechanically — that is derivable, and it is not built.

A claim without a measurement behind it does not belong in this file.
