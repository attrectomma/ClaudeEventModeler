# `pattern="upstream"` — external events landing in our stream

```
Event(s), authored elsewhere
```

**Not one of the cheat sheet's four patterns.** It is the one shape that is none of them and is still a
column: foreign or imported events arriving in our event store, with no command of ours triggering them
and no view of ours necessarily reading them yet.

It exists so that a column of arriving facts can be drawn honestly rather than being given a fake
producer to keep the checker quiet.

## A complete brief

- the **event label(s)**
- **where each comes from** — a sibling model in this system, or a genuinely foreign system
- the **fields we consume** — not necessarily everything the publisher sends
- **which stream** they land in

That is all. There is no command, no screen, no GWT.

## The gap list

**Where it comes from**, and the two answers are checked differently:

| | Means | Checked |
| --- | --- | --- |
| `from="fulfilment"` | published by a sibling model in this system | **yes** — must exist there, be `public="true"`, and its `fields=` must cover what we consume |
| `origin="Stripe"` | a genuine third party | no — a claim on record, unverifiable |

`external-unattributed` is a note when neither is set. Always resolve it: "an event arrives from
somewhere" is not information anybody can act on. Do not pick `origin=` to silence a failing `from=`.

**Which stream.** An event's y is its stream, so it still needs `aggregate=` matching a swimlane band —
`event-outside-swimlane` and `event-wrong-swimlane` are both errors. If it needs a new band, that band
is **exempt from `band-needs-identity`**: we project from these streams, never append to them, so
nothing needs a key to write to.

**Only the fields we actually use.** An import is a contract, and consuming a field the publisher does
not carry is `import-field-missing`. Consuming *fewer* fields than are published is correct and normal —
list what this model needs, not everything on offer.

## What this pattern is exempt from, and why

| Rule | Why it does not apply |
| --- | --- |
| `event-needs-producer` | there is no command of ours. That is the definition |
| `completeness/unsourced-attribute` | reported as the note `external-terminal` — an external event is **terminal**. We have neither control over it nor knowledge of what produced it |
| `band-needs-identity` | only if the band holds nothing we write |
| `slice-needs-gwt` | warns on State Change slices only |

The exemptions are the reason the pattern exists. Without it, the honest drawing — events with no
upstream — looks like four errors, and the temptation is to invent a command that produces them.

## What it is not

**Not a translation.** `upstream` is arrival only. The moment something of ours reacts — a View, a
trigger, a command — it is `automation` or `translation`, and `slice-pattern-mismatch` will say so
because those require a command and a view.

**Not a substitute for a view slice.** Arriving events generate event records and nothing else. Reading
them is a separate `state-view` slice, and that is usually the next thing the user wants. Say so, and offer
it — but as a second invocation. One slice at a time.

## Layout

Yellow (`em="external"`, `#fff2cc` / `#d6b656`), in the Event Stream lane, inside a swimlane band. One
column, however many events land in it.

**Several externals stacked in one column feeding the same View cannot all run straight up** — the lower
ones would cut through the ones above. Send them out the left edge and up a corridor at
`columnX − 30 − 12n`. This is the pattern where that arises most, because a column of arrivals is
exactly the stacked case.
