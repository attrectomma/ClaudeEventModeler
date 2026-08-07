# `pattern="state-view"` — a State View slice

```
Event(s) → View
```

That is the whole contract. The little book: *"State View Slices are the only way to get information
out of the system."* One column, no command, no event of its own.

## A complete brief

- **which events** feed it — by label, and they must already exist in the model
- **what one row is** — the grain
- its **fields**, and for each: carried by an event, computed from what, or renamed from what
- **which screen reads it**, and whether that screen's `displays=` changes

## The gap list

### What is ONE ROW — the defining question

`fields=` say what a row *holds* and never what a row **is**. Ask it directly and in the user's terms:
one per message? one per recipient of a message? one per campaign? one per sender per month? One row
for the whole system?

Then write it as `identity=` on the read model. This is the single most valuable thing this reference
exists to extract, for three reasons:

1. **It is not derivable.** Where `identity=` is missing the generator falls back to the system key and
   stamps the projection `GUESSED`, because silently grouping the wrong rows together is worse than
   saying so. On the worked model only 1 of 10 views declared it — see ANTI-PATTERNS.md #3.
2. **It decides which of six Marten recipes is right.** `Event(s) → View` does not say the view is a
   `SingleStreamProjection` and does not say a document exists at all — a live aggregation and a flat
   SQL table both satisfy the drawing. See CLAUDE.md's recipe table, and
   `reference-implementations/state-view/` where all six are built and measured against one model.
3. **A view's document id is not the stream id.** A rolled-up view is keyed by its own `identity=` —
   `(messageId, recipient)`, `(senderId, month)` — and neither is a stream key. One field means that
   field's type; a composite means `string`. Getting this wrong did not produce a subtly wrong read
   model, it produced code that would not compile.

A useful tell to offer back: **a view finer-grained than every event feeding it** — `identity="messageId,
recipient"` fed only by an event whose grain is `messageId` — cannot be an aggregation at all. One event,
many rows. The model says so before any code exists.

### If the grain includes a time bucket, whose clock?

Ask this whenever `identity=` names a month, week or day that no event carries a field for. It is
ANTI-PATTERNS.md #15 and it is silent:

`Identity<IEvent<T>>` is the natural way to reach a period when no event has one, but `IEvent.Timestamp`
is stamped when the event is **appended** and ignores the payload. So the view answers *"appended in
month M"* while every reader assumes *"happened in month M"*. They agree exactly until something is
backfilled, imported, corrected late, or replayed into a fresh store.

If the events carry a business timestamp — and a model declaring `queuedAt` does — the answer is the
payload's clock. Metadata keying is right only when the question genuinely is about the write. Record
the intended source in the cell's `note=`: `derived="month=MessageQueued"` is true and too weak to say
*which* of that event's two clocks was meant.

### Where the fields come from

Three forms, and the checker verifies each input is really supplied upstream:

| Brief | Attribute |
| --- | --- |
| "shows the subject" — carried by an event | nothing; the name matches |
| "counts the deliveries" | `derived="delivered=MessageDelivered"` — a fold over event **presence** |
| "one row per recipient, from the recipients list" | `derived="recipient=recipients"` |
| "status is Open until it is closed" | `derived="status=CampaignOpened+CampaignClosed"` |

That last form is the one no rename could ever reach: a fold whose "Open" value is the *absence* of a
closure event. `derived=` inputs may be an attribute an upstream source supplies **or the label of an
upstream source itself** — but naming an event that is not connected is an error. A derivation cannot
invent its inputs, so draw the edge.

## Placement — this pattern is usually an insert, not an append

If a screen that already exists is to read this View, the View's column must go **left of that screen's
column**. Put it to the right and the View → Screen feed points left, which is not the `Event → View`
exception and is `flow/backward-connection`, an error.

The events feeding it are then to the *left* of the View, so those edges run forward. That is the
arrangement to aim for: *"where a screen reads a View drawn to its right, put the View's column first."*

Inserting shifts every column to the right by 320 and moves every routing point. Say what you moved.

## The ripple this pattern causes

A View exists to be read, so adding one usually changes a screen:

- the consuming screen's `displays=` grows — and `displays=` must agree across **every** cell sharing
  that slug, so cells in other slices need the same edit
- those slices go back to `in-design` (see the skill's step 6)
- and if the screen already has a wireframe, a declared attribute nobody draws is `field-not-drawn`, a
  warning: its View is over-specified until someone draws the field

## GWTs

Normally none, and `slice-needs-gwt` only warns on State Change slices for exactly that reason. A GWT on
a view slice reads *GIVEN these events, THEN the view shows this* — worth writing when the fold is
non-obvious, which for a `derived=` over event presence it usually is.

## One read model per UI component

Dilger's rule of thumb, and the warning attached to it: *"the more Read Models you have, the more your
slice becomes coupled to various aspects of the system. A high number of Read Models can often indicate
suboptimal modeling of the information flow."*

The specific smell to push back on: *"We'll need the customer status in many slices; let's build a
Customer Status Read Model so it's reusable."* That is denormalising for reuse, and it leaks
implementation detail into the model. A View belongs to the thing that reads it.

## Implementation — state it, do not choose it in the model

codegen registers a single-stream view `Inline` and a multi-stream one `Async`, following the library:
Marten has NO default — ProjectionLifecycle is a required argument — and its multi-stream page says outright: "Register the lookup projection inline and the multi-stream projection async".
Neither is a law —
`RaiseSideEffects` no longer forces `Async` outright — side effects are processed only during async processing **by default**, and running them on an `Inline` projection needs `opts.Events.EnableSideEffectsOnInlineProjections = true`. Every step away from `Inline` costs the async daemon and
tests that must **wait** where they used to assert. That is `codegen`'s decision, made from
`reference/llms/marten/` and measured in `reference-implementations/state-view/` — not a model attribute.
