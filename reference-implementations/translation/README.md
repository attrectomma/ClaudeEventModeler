# `pattern="translation"` — the Translation pattern

```
Event(s) (source system) → View → Automated Trigger → Command → Event(s)
```

The fourth and last of the cheat sheet's patterns. Everything in `../automation/` still applies to the *shape* —
the todo list, the trigger typing nothing, at-least-once, idempotence. What this folder is actually about is the
**boundary**, and its central finding is a subtraction rather than an addition.

Read it with `reference/llms/wolverine/` open, not instead of it.

```
translation/
  stock-feed/       the event model — 2 slices, 2 swimlanes, 0 errors, 0 warnings
  build/            the compiled IR
  generated/        the code: 3 landing mechanisms, no wakeup, 15 tests
```

## Start here: the foreign event is not ours, and we never persist it

**This folder was built twice.** The first version ingested the warehouse's notice as an event on *our own*
stream, folded an array of received notice ids to dedupe it, and then woke a trigger off it with a Marten
subscription. It compiled, it passed 15 tests, it ran correctly against real Postgres, and it was **wrong** —
wrong in the way this whole kit exists to catch, where nothing fails and the design is still broken.

Two questions from a reviewer undid it, and both are answered by `tools/model.mjs` rather than by argument:

**Does the external event have to sit in the same swimlane as our own events?** No. It must sit in *a* swimlane —
`event-outside-swimlane` is an error and it applies to `external` too — but it belongs in **its own foreign
band**. `slice.mjs` puts it in whatever band already exists, and with one band that is ours; accepting that
default is how the first version went wrong.

**Do we persist it?** No, and the validator has said so all along:

```js
// Only bands we WRITE need it. A band holding nothing but imports or foreign events is exempt:
// we never start those streams, we only project from them.
const owned = ir.elements.filter((e) => e.kind === "event" && …)   // NOT "external"
```

Both `band-needs-identity` and `identity-not-on-every-event` filter to `kind === "event"` and exclude externals.
A foreign band is exempt from `identity=` **because there is nothing of ours to key.** Proven, not inferred: this
model's warehouse band declares no `identity=` and validates at 0 errors, 0 warnings.

And the reason it matters is not tidiness. **An event store is append-only.** A foreign schema written into ours
is in our history for ever — every future replay, every future projection, every schema migration has to carry
the warehouse's field names and units. That is exactly the coupling a translation exists to prevent, installed
by the thing meant to prevent it.

## Which collapses the pattern into something simpler

Once nothing of ours appends the notice, the second decision evaporates:

```
foreign notice → transport's DURABLE INBOX → StockTranslator → ApplyStockNotice → decider → StockLevelSet
                 └──────── the View ───────┘  └── the trigger ──┘                            └─ the only thing persisted
```

**For a 1:1 translation, the arrival is the wakeup.** All four of the automation folder's mechanisms — event
forwarding, `ISubscription`, `RaiseSideEffects`, a sweep on a clock — wake a trigger off events *already in our
store*. A translation's trigger event never is one, so the question they answer does not arise. The notice lands
in Wolverine's durable inbox and the trigger is its handler.

**And the inbox is the todo View.** Every notice that has arrived and not yet succeeded is a row in
`wolverine_incoming_envelopes`, with retries, dead-lettering and an at-least-once guarantee nobody wrote. This is
the automation folder's rule doing real work rather than being quoted —

> "it does not require the View to be a materialised projection — a durable inbox is a list of pending work. The
> green box on the diagram is the concept."

— and it is the sharpest case of it in the kit, because here a materialised View is not merely unnecessary but
**impossible**: no Marten projection can fold an event that is never in the store. Ch. 16's author reaches the
same place from the other direction: *"I typically skip the read model definition and directly map the external
event to an automation processor."*

Measured consequences of the subtraction:

| | First version | Now |
| --- | --- | --- |
| event types in our store | 2 — `stock_noticed` **and** `stock_level_set` | **1** — `stock_level_set` |
| documents | `StockLevels`, `StockNoticesToApply` | **`StockLevels`** only |
| async daemon / background thread | yes, for the subscription | **none** |
| decisions to make | landing **and** wakeup | **landing** |
| ways to be silently dead | nothing ingests, nothing wakes | **nothing ingests** |
| a refused notice | logged best-effort, racily | **logged, synchronously, always** |

That last row is the one worth dwelling on. In the first version the refusal happened inside a materialised todo
View's status comparison, so a stale notice was refused with **no log line anywhere** — found only by running the
app — and the ingest-time warning added to fix it could not be made reliable, because it compared against a
sequence that an asynchronous projection had not caught up with. Verified both ways by hand. Removing the
persisted event removed the race with it: the refusal now happens in the decider, inside its own transaction, and
the trigger logs the outcome. Both refusals are visible in a live run:

```
translated notice …0009 for product …0001: onHand 33, sequence 9.
REFUSED notice …0009 …: AlreadyApplied. … at-least-once, so this is the normal case rather than an error in the caller.
REFUSED notice …0002 …: StaleNotice. … sequence 2, and we have already accepted 9.
```

### What still has to come from somewhere, and does

Persisting the foreign event was buying two real things. Both are cheaper elsewhere:

| Was provided by the persisted event | Now |
| --- | --- |
| a durable record of what they said | the transport's inbox already holds it, with dead-lettering. It is **pruned**, which is the right lifetime for a message and the wrong one for history — so nothing permanent depends on it |
| dedupe across redeliveries | the `noticeId` carried on **our own** event, folded by the decider. One correlation value is not their schema, and it is the only place a foreign id legitimately crosses |

### And a rule came off the model

The model used to carry *"a notice nothing ever delivered cannot be applied"* → `NoticeNotReceived`. It was only
expressible while the notice was being persisted, because it asked **"is their event in our history?"** — a
question we should never be able to answer. Once the notice stopped being persisted the rule had nothing to check.

Worth recording as its own finding: a wrong implementation choice had propagated *back into the domain model* as
a business rule. That is the direction of contamination to watch for, because the rule validated, generated a
test, and passed.

## The one decision that is genuinely this pattern's own

Three landing mechanisms, selected by `Feed:Landing`, all satisfying the same GWTs. In a real project you pick
one and delete the rest.

| | Mechanism | Arrival | Durable without our code | Needs a cursor of ours | Can deliver out of order | Extra infra |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | HTTP webhook | they call us | **no** | no | **yes** | none |
| **B** | external database table | they INSERT, Wolverine polls | **yes** | no | **yes** | a table in our DB |
| **C** | poll their API on a clock | we call them | n/a — theirs | **yes** | **no** | none |

**The decision rule is not "which is easiest to build". It is: who is responsible for a notice that goes missing,
and is there anything left to re-read?**

- **A** makes the far side responsible and leaves us nothing to recover from. A failed POST exists nowhere on our
  side; recovery is entirely their retry policy, which is unknowable from our code. For a feed documented as
  notifying us *"whenever a change occurs"* and never re-sending, that is the argument against it however
  convenient it is.
- **B** needs no cooperation beyond an `INSERT` and is the only one durable without us writing durability code —
  rows sit there until Wolverine has them, the inbox holds them until the handler succeeds, failures go to
  ordinary dead-letter storage, and an advisory lock stops two nodes double-reading. For a legacy black box with
  no messaging of its own, this is what the Wolverine docs are written for.
- **C** is the only option when the far side pushes nothing, and the only one needing a **high-water mark of its
  own** — a row we own, that can be wrong, and whose *side* of the ingest decides the failure mode. Ours advances
  **after**, so a crash re-reads notices we already hold and the dedupe discards them.

**Not built: a broker listener** (Rabbit/Kafka/SQS with `DefaultIncomingMessage<T>`, plus an envelope mapper if
their headers matter). It is the most likely production shape and it is **not measured here** — it needs a broker
container and its only new code is that mapping. Stated rather than quietly omitted. Everything on our side of
the listener transfers from B unchanged.

### The landing mechanism decides whether a hazard exists at all

Found while writing demo data, not while writing tests. A stale notice needs a sequence *lower* than one already
accepted — but that field is also the poll's cursor, so **a cursor-ordered pull feed cannot deliver out of order
by construction.** Reading in cursor order is what makes it a cursor.

So `StaleNotice` guards a hazard only *some* landing mechanisms have, and you cannot know whether you need it
without knowing how the notice lands. The rule stays regardless: the landing mechanism is a choice somebody may
change later, and the rule is what makes changing it safe.

## What was measured

`dotnet build`: 0 warnings. `dotnet test`: **15 passed, 0 failed, 0 skipped**, stable across repeated runs.
Regeneration afterwards keeps every filled scaffold and the suite stays green.

A live run with nobody calling anything — four notices sitting on the far side, fetched, translated:

```
translated notice …0001 for product …0001: onHand 42, sequence 1.
translated notice …0002 for product …0002: onHand 7,  sequence 2.
translated notice …0003 for product …0003: onHand 0,  sequence 3.
translated notice …0004 for product …0001: onHand 40, sequence 4.
warehouse poll: 4 notice(s) after sequence 0; checkpoint now 4.
warehouse poll: nothing after sequence 4.      ← ×4, and saying so is the point
```

And the state afterwards, which is the assertion the whole folder turns on:

```
 type            | count          product | on_hand | seq
-----------------+-------         --------+---------+-----
 stock_level_set |     4          0001    | 40      | 4
                                  0002    | 7       | 2
(no stock_noticed. none.)         0003    | 0       | 3
```

Documents present: `mt_doc_stocklevels`, `mt_doc_feedcheckpoint`, and Wolverine's own `mt_doc_envelope` /
`mt_doc_deadletterevent`. **No todo-list document** — the inbox is doing that job.

### The generated suite cannot see a disconnected feed

Nothing in the model or the generated code makes an arrival happen. Every model-derived test hands the notice to
the translator itself by putting the message on the bus — the production path, correctly — so a feed wired to
nothing at all leaves the suite green. Only the five hand-written `LandingMechanismTests` boot a host and let the
infrastructure deliver, and `WithNoMechanismNothingEverLands` is the control that makes the other four mean
anything.

**This is one failure mode, and it used to be two.** The first version could also be dead because nothing woke
the trigger — measured then at **11 of 15 tests still passing with the subscription disabled**, including the
Given/Then written specifically to catch it, because a generated test can only drive the trigger itself. Removing
the append removed that entire class of failure: there is no separate wakeup left to be missing.

### Isolating the read side went from testable to structural

`StockLevels` folds `StockLevelSet` and nothing else. In the first version, adding `Apply(StockNoticed …)` to its
projection was a one-line mutation that broke exactly 2 of 15 tests while 13 kept passing — a real, breakable
guarantee held up by two isolation tests.

Now the same mistake is **impossible**: the projection cannot fold an event that is never in the store. The model
still specifies the Given/Then, and the test is kept — it would fail loudly the moment somebody decided to start
recording arrivals, which is exactly the change it should stand guard over.

## `identity=` on a todo View decides what the automation works

Kept because the lesson outlived the answer. The first version materialised the todo View with
`identity="productId"`, so a burst of notices for one product **collapsed to one decision** — the newest level
won and the intermediate ones were never applied. With the inbox as the View there is one entry per message, so
every notice is translated in turn.

| The feed reports | Collapsing a burst is | Because |
| --- | --- | --- |
| **levels** ("there are 40") | fine, even desirable | a newer notice *replaces* an older one |
| **deltas** ("plus three") | **a bug** — lost stock | every notice must be applied |

Same drawing, same green box, opposite requirement. Measured both ways: 3 events for 4 notices when collapsed,
4 when not.

## Findings against the kit

Section **T** of `KIT-FINDINGS.md` carries these with the actionable ones flagged.

| | Finding |
| --- | --- |
| **1** | ***FIXED 2026-08-09, and this folder is the thing it was measured against.*** **The generator emitted no seam for the arrival of a foreign event** — not a handler, not a hook, not a report — so no production path existed by which one reached the system, and *"nothing ever delivers one"* was invisible to a green suite: the exact parallel of *"nothing ever wakes this"*. `codegen` now scaffolds `Landing/Ingest<Event>Handler.cs` on a **durable local queue**, one per foreign event, and reports `INGEST NOT WIRED` until its body is filled in. **The files in this folder are still hand-written and are left that way deliberately** — they predate the generator and are the record of what having no seam cost. What is still not generated, and is the reason the transport files below remain interesting, is **which transport sits in front of that queue**. |
| **2** | **`slice.mjs swimlane` appends the band at the END of the XML, so it paints over every event drawn in it.** mxGraph renders in document order and a band has an opaque fill. Moving the external event into the newly added band made it **vanish from the render** while validating at 0 errors. Caught only by rendering and looking — which is what that rule is for. One-line fix: insert the band before the elements. |
| **2b** | **`VIEW WITH NO REGISTRATION` cannot tell "forgot" from "deliberately not a projection".** Regenerating this finished folder reports the missing `StockNoticesToApply` registration and recommends adding a projection class that no longer exists. The omission is the design — and it contradicts the kit's own doctrine that a View need not be materialised. Wants the `joins="none"` treatment: warn on the unacknowledged case, note the acknowledged one. A report that cries wolf stops being read. |
| **3** | **The generated harness disables every landing mechanism.** `AppFixture` calls `DisableAllExternalWolverineTransports()` unconditionally, in an `emit` file. A translation's landing mechanism *is* an external transport, so the harness the generator provides can never test the arrival half of the pattern. |
| **4** | **`SeedData`'s scaffolded instruction is wrong for this pattern, twice over.** "Append the foreign events onto whatever streams the model says they land in" is the thing that must not happen: it puts a foreign schema in our history, *and* it makes the landing mechanisms untestable, since "a notice arrived" cannot be asserted when one is already there. Confirms and sharpens B5. |
| **5** | **`GenesisData` can take no dependency** — `Program.cs` is emit and constructs it with `new`. A translation's demo data belongs on the **far side**, which needs the container. Ours lives in `WarehouseDemoData`, reached through the one DI seam `RegisterServices` offers. Seeding our own stream instead would make a broken feed look identical to a working one. |
| **6** | **There is no landing hook in `Program.cs`**, so the arrival is routed through the wakeup scaffold's hooks — two decisions, one set of seams. |
| **7** | **A foreign key that is not our key has no notation.** `mappings=` is a rename, `derived=` is computed, `terminal=` is context. A foreign `sku:string` becoming our `productId:Guid` is none of the three: it is a lookup in a correspondence table, and a translation's whole job is exactly that. Dodged here by sharing the product id and renaming only `quantity` → `onHand`. |
| **8** | **A GT hint is written for a view slice** — it says "assert the read model", but on an automation or translation the GT's `then=` must name an event. The *restriction* is right and should stay; only the hint is wrong. |
| **9** | **An implementation choice propagated back into the model as a business rule.** `NoticeNotReceived` existed only because the foreign event was being persisted. It validated, generated a test, and passed. Nothing catches this, and it is the most uncomfortable finding here. |

### RETRACTED

- **"The write-side fold omits the foreign event."** Filed as a generator bug in the first pass, on the grounds
  that `TranslateStockNoticeState` was scaffolded with `Apply(StockLevelSet)` only. **The generator was right and
  the finding was wrong.** Filtering the fold to events the system *owns* is exactly correct; the foreign event
  is not one, and hand-adding a fold for it was the error.
- **"The wakeup decision table needs a foreign-but-ingested row"** (KIT-FINDINGS B4). Its premise — that the
  external event is drawn in our own band, so something of ours appends it — reads the model's *default layout*
  as a *requirement*, and the identity rules contradict it outright. A translation needs no row in that table.

### Two API facts the mirror does not carry

- **`ListenForMessagesFromExternalDatabaseTable` is on `Wolverine.RDBMS.Transport.ExternalDbTransportExtensions`.**
  The doc page documenting the feature names no namespace. Found by grepping the NuGet package's own `.xml` doc
  file — **a faster tiebreaker than the `dotnet run probe.cs` reflection app `CLAUDE.md` recommends**: the `.xml`
  ships beside every `.dll` under `~/.nuget/packages` with fully-qualified names. It lists only *documented*
  members, so absence proves nothing — `PollingInterval` is absent and compiles fine — but a hit is definitive.
- **`SendMessageThroughExternalTable(IHost, qualifiedTableName, message, ct)`** — "Testing helper to publish a
  message to an externally controlled message table". In **no** documentation page. Without it, mechanism B could
  only be tested by hand-writing SQL against a table whose conventions are Wolverine's.

## What held up

- **`slice.mjs` built the whole translation shape** — external, view, automation, command, event, four edges, two
  columns, View correctly under the processor — then added a second swimlane with the full downward cascade.
- **`AUTOMATION NOT WOKEN` fired for a translation slice** and named the file, confirming B1's fix on independent
  ground, then **cleared itself** once the decision was recorded.
- **0 errors and 0 warnings on the model** at every stage, including with a foreign band declaring no `identity=`.
- **Regeneration is idempotent** and kept every filled scaffold, including the deliberately-emptied ones.
- **The scaffold/emit split earned its keep twice.** Both of this folder's real read-side decisions — deleting a
  projection registration, and emptying the wakeup — are edits inside `scaffold` files that regeneration keeps.
  Had the registrations still been inline in `Program.cs`, which is `emit`, both would have been silently
  reinstated.

## Where this folder's architecture decisions are recorded

```architect-record-elsewhere
The `replay-safety` question and how a foreign event arrives are answered by FOUR built landing
mechanisms — a webhook, a table the far side INSERTs into, a broker listener, and a poll with a
high-water mark — with at-least-once and ordering costs stated per mechanism.
```
