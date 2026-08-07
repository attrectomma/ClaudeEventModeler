# `pattern="automation"` — an Automation slice

```
Event(s) → View → Automated Trigger → Command → Event(s)
```

**Two columns.** An automation is a **Trigger** — a peer of a person at a screen. It *looks at a View*
and *issues a Command*. It never receives an event and never emits one.

## First: is it actually an automation?

Two tests, and a brief that fails either one describes something else:

- **Is there a View?** Something must accumulate the state the trigger decides from.
- **Is there conditional logic?** The trigger has to be able to decide *not* to act.

*"If there is no view and no conditional logic, it is not an automation at all — it is just a command
that emits several events."* Say that, and offer to draw the command slice instead.

`Event → Processor → Event` is the classic anti-pattern and `no-event-to-event` /
`automation-needs-view` catch the drawn form of it. But a brief can describe the anti-pattern in prose
— "when X happens, do Y" — and be transcribed into a legal-looking drawing. Ask what the View is
before you draw.

## A complete brief

- **which event** puts a row on the todo list
- **the View** — the todo list itself, and its fields
- **the condition** the trigger applies: which rows are work, which are not
- **the command** it issues, and its fields
- **the event(s)** the command persists
- **what ticks the row off** — how the View stops offering work already done
- (implementation, for the record) **what wakes it**

## The gap list

### What ticks the row off — the one that gets forgotten

The View an automation watches is a **todo list**: the event puts a row on it, the automation works the
row and issues a command, and the resulting event **ticks the row off**. Skip that last step and you
lose both the record of pending work and the thing that stops the processor working the same row twice.

ANTI-PATTERNS.md #12 is a todo row that never completes, and nothing catches it — the model validates,
the projection compiles, and the automation reprocesses the same row forever. Ask it explicitly, and
draw the edge: the automation's own output event feeds the View. **That edge is completion, not
supply** — it is not there to provide a field.

### The automation types nothing

An automation has no screen and no keyboard. Every field of its command must come from the **todo-list
View** it watches. So if the command needs something the View does not carry, the answer is a field on
the View — which means a field on an event feeding it — not `inputs=` and not an invented source.

`terminal=` is still legitimate for `clock`, `generated` and `const`. `actor` is not: there is no
authenticated principal behind an automation.

### The condition

Ask what makes a row *work*. This becomes a GWT, and the failure case matters more than the happy path:
what happens when the trigger runs and there is nothing to do? That must be a legal, logged, no-op —
not an error.

## Layout

Two columns, one slice band spanning both:

| Column | Holds |
| --- | --- |
| left | the todo-list View (`em="readmodel"`) and the automation (`em="automation"`, purple) |
| right | the Command and the Event(s) it persists |

The events feeding the View sit to the left of both. The tick-off edge runs from the output event back
to the View, which is the `Event → View` exception and therefore legal.

## Implementation — the choice is real, and the model does not make it

`pattern="automation"` reads as *"this slice reacts to accumulated state without a human"*. It says
nothing about what wakes the trigger, and — this is the part easy to get wrong — **it does not require
the View to be a materialised projection.** A subscription's checkpoint is a record of what has been
worked; a durable inbox is a list of pending work. The green box is the concept.

Four mechanisms, all built and measured in `reference-implementations/automation/`:

| When | Implementation |
| --- | --- |
| the trigger event is **ours**, and cheap + immediate wins | event forwarding → a doorbell handler |
| ours, and **losing one is unacceptable** | Marten `ISubscription` — durable checkpoint |
| the trigger event is **foreign** — we never append it | sweep a todo View on a clock |
| there is **no event at all** — the trigger is *time* | sweep |
| "is there work?" genuinely means "did this row change" | projection `RaiseSideEffects` — async-only by default, but `EnableSideEffectsOnInlineProjections` allows Inline |

This is `codegen`'s decision, not the model's. But it is worth **capturing the user's answer if they
volunteer one**, in `OPEN-QUESTIONS.md` or the slice cell's `note=` — because nothing catches a wrong
choice. The model validates, the code compiles, the suite is green, and the slice is still built on the
wrong mechanism. That sentence is the only artifact that will carry the reasoning.

The kit generalised "a sweep on a clock" into the only correct automation once, from a sample of one
model whose automations happened to be foreign- or time-triggered. Do not repeat it by assuming the
mechanism from the pattern.

## Two facts worth passing on with the slice

**The trigger is a message handler, not an HTTP endpoint.** If the trigger *is* an endpoint, the test
seam and the production mechanism are the same thing — so "nothing ever wakes this in production" is
invisible to a green suite, which is exactly how one shipped once.

**No test can prove an automation runs by itself.** Two runs with nobody calling anything is the proof;
one is not, because a mechanism that fires at startup and then dies produces exactly one and reads as
success. ANTI-PATTERNS.md #14. Say this when handing the slice to `codegen`.
