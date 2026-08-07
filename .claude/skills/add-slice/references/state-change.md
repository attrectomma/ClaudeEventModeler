# `pattern="state-change"` — a State Change slice

```
Trigger (a screen) → Command → Event(s)
```

The little book: *"State Change Slices are the only way to bring information into the system."* One
column. Every one of these crosses the UI/backend line, and no other pattern does.

## A complete brief

If the brief covers all of this, ask nothing:

- the **screen** — its slug, which fields the user **types**, which are only **shown**
- the **button** label, and the **command** it issues (imperative)
- the **event** it persists (past tense), and its fields
- **which stream** the event belongs to, and **what identifies one stream** of it
- for each field the command does not carry: is it **computed** (from what), a **rename** (of what),
  or supplied by **context** (handler / clock / actor)?
- at least one **rejection** — what makes this illegal, and what the error is called
- one **worked example** of any calculation, as concrete values

## The gap list — what to ask when it is missing

**Which swimlane, and what keys one stream.** The expensive one, and it is a *domain* question, not a
technical detail. Marten keys a stream, so without `identity=` nothing can append. And the choice
decides which rules are real invariants:

| Entries keyed by | *"at most N per day"* is |
| --- | --- |
| `entryId` | not an invariant — a check against an eventually-consistent projection, and two concurrent writes can both pass |
| `subjectId, period` | a true aggregate invariant, enforced inside the transaction |

Ask which rules must *always* hold, then pick the key that makes them holdable. Expect the ripple:
choosing `subjectId, period` means **every event in that band needs `period`**, including ones that
already exist (`identity-not-on-every-event`). That is the normal cost of the decision, not a mistake.

If the slice lands in an **existing** band, the key is already decided — check the new event carries
every name in it, and add them if not.

**The rejection cases.** A brief almost never volunteers these and `slice-needs-gwt` only warns. Ask:
what must be true for this to be allowed? what happens when it isn't? what are the limits? Ten or more
GWTs per slice is normal — *"Don't save on GWTs."*

**`enforce=` on each GWT.** `periphery` (FluentValidation, rejected before any stream is read) or
`aggregate` (default, needs accumulated state). **Declared, not derived** — the obvious heuristic "no
`given=` means the request alone settles it" fails on real models, because almost every GWT carries a
*context* `given=`. The default is the safe one: a state rule placed in a validator cannot enforce
itself.

**Whether a `Guid` in the command is an input or a new id.** A screen that *displays* a `bookingId` is
showing the row being looked at; creating a booking needs a **new** one. Same name, opposite meaning,
and a name-match cannot tell them apart. That is `terminal="bookingId:generated"`, not a source.

## Rules that are not negotiable

**One Command per slice.** The little book, on more than one: *"No."* More than one Event is allowed
but *"should not be the rule."* If the brief describes two commands, it is two slices — say so and ask
which to draw first.

**Events are past tense, commands imperative.** Silently rewrite a present-tense event and say that
you did.

**One command, one swimlane.** *"A single command should never interact with multiple swimlanes or
aggregates. The moment you do this, you introduce the need for a transactional boundary around the
operation."* `command-crosses-swimlane` is an error. Two effects that must happen atomically are not
two aggregates — they are one. Reading another stream to decide is fine; writing it is not.

**A rejection is `then="error: RuleName"`.** The rule name becomes the ProblemDetails `Title`, which is
what Wolverine.HTTP already produces for FluentValidation failures — so the same assertion holds
whether the rule was caught at the periphery or in the decider.

## The formula's home

`derived="d=a+b+c"` says d is computed from a, b and c. It does not say how, and there is nowhere on a
cell that does. Put the formula in a GWT as concrete values:

```
label:  "d is the sum of a, b and c"
when:   "Send(a=2, b=3, c=4)"
then:   "XRecorded(d=9)"
```

This is the only form that survives into a generated test. When a brief says "by rule X", ask for one
worked example and say that the GWT is now where rule X lives.

## Reusing a screen

The same screen appears in every slice that triggers from it. `displays=` **must agree** across cells
sharing the slug — copy it exactly. `inputs=` **may differ**, and that asymmetry is load-bearing:
*"there may be only one entry per day+category, so adding again is a Correction"* is a domain fact
about affordances, and it is why one screen legitimately offers three different buttons.

If this slice's screen needs to show something no View supplies, that is `undisplayable-data` and the
answer is almost always a **missing read model** — propose a `state-view` slice, do not invent a source.

## Conway

Screen → command → event crosses the UI/backend line by definition, so a command slice is
`owners="backend-agent, frontend-agent"`. Acknowledge the split rather than letting
`conway/slice-crosses-teams` compute it as an unacknowledged warning.

## Implementation — state it, do not choose it in the model

`pattern="state-change"` is a contract. The recipe is a codegen decision with real consequences: the
Wolverine aggregate handler workflow vs. explicit `FetchForWriting`, an HTTP endpoint vs. a message
handler, `StartStream` for a slice that creates the stream. Note it in `OPEN-QUESTIONS.md` if the user
raises it; it belongs to `codegen`, measured in `reference-implementations/state-change/`.

One thing the model *does* owe the implementer beyond the drawing: `identity=`, and `enforce=` on every
GWT. Both are domain answers, and without them the implementer guesses.
