# `pattern="automation"` — four ways to wake a trigger, one model

```
Event(s) → View (a todo list) → Automated Trigger → Command → Event(s)
```

**This folder had no README until 2026-08-11, which was a gap rather than a style choice.** CLAUDE.md cites it
four times — *"built and measured against one shared model in `reference-implementations/automation/` — read
that before writing one"* — so an agent was sent to a folder with no entry point and had to find its way to
`SendEmailWakeup.cs` unaided. Found by sweeping BP12's question: *nothing measures the distance between these
folders and the tooling that reads them.*

```
automation/
  email-outbox/     the event model — 2 slices, 0 errors, 0 warnings
  build/            the compiled IR
  generated/        the code: FOUR wakeup mechanisms behind one switch, 19 tests
```

## The whole content is in one file

`generated/src/EmailOutbox/Automation/SendEmailWakeup.cs` — 300 lines, and the reason it is one file is that
**the choice is the subject.** All four mechanisms are built, selected by configuration, and the file carries
the decision table plus what each one costs:

| Mechanism | Wakes on | Costs |
| --- | --- | --- |
| **event forwarding** → a doorbell handler | our own event, in its own transaction | ~1s, no daemon, one class. A delivery that never happens is **lost** — no record of intent outside the moment |
| **Marten `ISubscription`** | our own event, durably | a checkpoint, so a host that was down catches up. Ordered, coalesced per event *page*. Costs the async daemon |
| **projection `RaiseSideEffects`** | the row changing | fires already knowing there is work. The only one that reaches INTO the read model. Needs `EnableSideEffectsOnInlineProjections` to run on an `Inline` projection |
| **a clock-driven sweep** | the passage of time | the only option when the trigger event is foreign-and-never-ingested, or when there is no event at all. Recomputes from the todo View every run, so the pending rows *are* the durable queue |

**Ask two questions, in this order: is the trigger event ours to append, and can you afford to lose one?** The
second usually decides it, and it is not the same question as "does ordering matter".

## What the folder proves that reading cannot

- **A green suite says nothing about whether an automation runs.** Every test drives the trigger directly, so
  "nothing wakes this in production" is invisible. Only starting the app finds it, and **two runs with nobody
  calling anything is the proof — one is not**, because a mechanism that fires at startup and then dies
  produces exactly one and reads as success.
- **The trigger takes `IQuerySession`, not `IDocumentSession`**, so "a trigger never appends" is a compile
  error rather than a review comment.
- **The trigger returns `Task`, never its run report.** Wolverine treats a returned value as a cascading
  message with no opt-out, so a report returned fire-and-forget is unroutable and takes the whole outgoing
  batch down.
- **Durable self-rescheduling does not work on this stack** and fails silently — six attempts, each with
  logging proving the message was created, ending `Enqueued for sending` → nothing. It turned out not to be
  needed: a sweep recomputes its work from the View every time, so those rows are the queue.

## Where this folder's architecture decisions are recorded

```architect-record-elsewhere
The `replay-safety` question is answered by FOUR built wakeup mechanisms against one shared model —
event forwarding, `ISubscription`, `RaiseSideEffects`, and a clock-driven sweep — with the durability
and ordering cost of each stated in the table above and in SendEmailWakeup.cs. Choosing one is the
decision; all four are here so the choice can be compared rather than argued.
```

## Running it

```bash
node tools/model.mjs validate reference-implementations/automation/email-outbox/email-outbox.drawio
node tools/codegen.mjs      reference-implementations/automation/email-outbox \
                            --project reference-implementations/automation --out generated

cd reference-implementations/automation/generated
dotnet test                                    # all 19
```
