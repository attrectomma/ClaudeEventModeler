# Reference implementations

Worked implementations of the Event Modeling **patterns**, kept and carried forward. They exist to be read
by a coding agent — or a human — before implementing a slice of that shape, so that the choices already
paid for are not rediscovered.

This is deliberately **not** a domain. Names carry no business claims, and there is nothing here a domain
expert has to stand behind. The archived POC that these replaced was a half-finished domain, and being
half-finished is what made it dangerous: it read as a reference example while asserting things nobody
agreed to.

```
reference-implementations/
  automation/
    email-outbox/          the event model — ONE model, shared by every implementation below
    generated/             what tools/codegen.mjs emits from it, unedited
    src/, tests/           the implementations
```

---

## Why the automation pattern first

Because it is where the kit was most wrong, and the error is instructive.

The Automation pattern is `Event(s) → View → Automated Trigger → Command → Event(s)`. Having built exactly
one automation — on a model whose triggers were all *foreign* events or the *passage of time* — the kit
concluded that a clock-driven sweep of a materialised todo View was the only correct implementation, and
wrote that into its own guidance. **That was a sampling error.** A sample of one model is not a pattern.

The correction matters more than the mistake:

> **The model constrains the contract, not the mechanism.**
>
> `Event(s) → View → Trigger → Command` says the trigger decides from **accumulated state** rather than
> from one event's payload, and that it **issues a command** rather than appending one. It says nothing
> about what wakes the trigger, and it does **not** require the View to be a materialised projection.
> A subscription's checkpoint is a record of what has been worked. A durable inbox is a list of pending
> work. The green box on the diagram is the concept.

`PrepareEmail → EmailPrepared → [subscription] → SendEmail → EmailSent` is an automation. It is drawn
`EmailPrepared → EmailsToSend → EmailProcessor → SendEmail`, and no `EmailsToSend` document has to exist
for that drawing to be honest.

## The decision table

Reasoned, not yet measured — the whole point of the implementations below is to test it.

| When | Implementation | Why |
| --- | --- | --- |
| the trigger event is **ours**, appended in our own transaction | **event forwarding → handler** | immediate, outbox-durable, no polling. The common case. |
| ours, and **ordering or replay** matters | **Marten `ISubscription`** | ordered, durable checkpoint, runs in the async daemon |
| ours, and the decision is a function of **the view row** | **projection `RaiseSideEffects`** | fires exactly when the row changes |
| the trigger event is **foreign** — we never append it | **sweep a todo View on a clock** | there is no transaction of ours to hook |
| there is **no event at all** — the trigger is *time* | **sweep** | nothing to subscribe to |

**Nothing checks this.** No rule family, no compiler, no test can tell you the choice was wrong — so a
slice has to say which row it was in and why.

## The four, and what each has to answer

All four satisfy the *same* GWTs from the *same* model. What differs is only how `EmailProcessor` is woken.

| | Implementation | The questions it has to answer |
| --- | --- | --- |
| **A** | event forwarding → handler | How late is it? Does the outbox make it durable without a daemon? Does `ExecuteAndWaitAsync` make it synchronously testable? |
| **B** | Marten `ISubscription` | What does the async daemon cost in tests? Is ordering real? What happens on replay? |
| **C** | projection `RaiseSideEffects` | Does it fire with `Inline` projections, and at what cost? If not, it runs `Async` — and then what does a test look like? Does its own output event re-enter the projection? |
| **D** | sweep on a clock | The baseline. What does polling cost when a doorbell would have done? |

**Status: the model is built and validated; the implementations are not written yet.** Findings will be
recorded here per implementation, and a claim without a measurement behind it does not belong in this file.

## Known problem this folder is meant to settle

**`tools/codegen.mjs` still hard-codes one answer.** For any slice with `pattern="automation"` past
`in-design`, it emits `AutomationHeartbeat` plus its registration — the sweep, unconditionally. The docs
now describe a choice; the generator does not offer one.

The fix is *not* a new cell attribute. By the argument above, how a trigger is woken is not a domain fact,
so it does not belong on the model — which leaves two candidates:

1. the generator emits **no** waking mechanism, marks the hole, and the decision table in
   `.claude/agents/backend-agent.md` tells the implementer how to choose
2. the generator emits the trigger and the mechanism is selected by configuration

Option 1 is probably right for the kit and option 2 is what this folder needs in order to compare them
side by side. Settling that is part of the exercise, not a prerequisite for it.
