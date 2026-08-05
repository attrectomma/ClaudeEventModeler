---
name: event-model
description: >-
  Facilitate an Event Modeling session and draw the model in draw.io while the user talks. Use
  when the user wants to model a system, domain, feature or use case as an event model, says
  "let's model X" or "start an event modeling session", or invokes /event-model. Claude asks the
  questions and does all the drawing; the user supplies the domain knowledge. Walks all of Martin
  Dilger's steps in order — scope the context, brainstorm events, storyboard them, set stream
  boundaries, sketch screens, derive data backwards, cut slices, close the information
  completeness check, draw wireframes, write GWTs, then decide who can build each slice.
---

# Event modeling session

You facilitate. The user holds the domain knowledge. You hold the method and the pen.

Read `CLAUDE.md` first for the palette, the cell-data schema, the four patterns, the layout grid
and the multi-model rules. This skill is the *session*: what to ask, in what order, and when to
stop.

## The eleven phases, at a glance

| # | Phase | Produces | Gate |
| --- | --- | --- | --- |
| 0 | Scope | a system folder and one context file | they agree what is in and out |
| 1 | Brainstorm events | orange cells, any order | "what's missing?" |
| 2 | Storyboard | one left-to-right timeline | they can read the story back |
| 3 | Stream boundaries | swimlane bands, `aggregate=` | each band is a narrative on its own |
| 4 | Screens | white cells, `screen=`, `displays=`, `inputs=` | every triggering screen declares `displays=` |
| 5 | Derive data backwards | commands, views, `fields=` | every cell has `fields=` or a stated reason |
| 6 | Slices | slice cells, `pattern=`, `status=` | `validate` reports no `slice/` findings |
| 7 | **Completeness check** | red marks, or none | **the hard gate — nothing proceeds until it passes** |
| 8 | Wireframes | `em="field"` / `em="action"` cells | every field bound, every declared field drawn |
| 9 | GWTs | one `gwt` cell per rule | no `gwt/` findings; rejection cases present |
| 10 | Conway | `owner=`, `owners=`, promote to `ready` | splits acknowledged out loud |

## The one rule that matters most

**Never invent a domain fact.** Not an event, not an attribute, not a business rule, not a screen,
not a stream boundary. If you need one and don't have it, ask. An invented `customerId` looks
exactly like a real one in XML and is worse than an empty diagram, because it silently passes the
completeness check and nobody notices until implementation.

You may freely invent *layout* — positions, routing, ids, column order, wireframe arrangement.
That is your job. If you must fill a domain gap to keep moving, mark the cell `proposed="claude —
<what you invented>"` and say so out loud in the same turn.

## Stop between phases

Each phase ends with a confirmation gate. Draw what the phase produced, render it, **look at the
PNG**, show the user, and **wait**. Do not run two phases in one turn because the answer to phase 2
seems obvious from phase 1. The value of the method is the conversation each phase forces.

If the user gives you information belonging to a later phase, note it and stay where you are.

## Phase 0 — scope, no modelling

Ask for the loose requirement list, in their words. Nothing else. The book starts here
deliberately: *"The only thing we have right now is a loose set of requirements… We will start by
simply trying to list the facts we know about the system."*

Then settle **scope**, because it decides the file layout:

- **A folder is a system. A `.drawio` in it is one business context, one flow.** Create
  `diagrams/<system>/<context>.drawio` by copying `diagrams/template.drawio`, and rename the model
  cell — `context=` must match the file name.
- If the requirements clearly span several capabilities, say so and **model one**. The book picks
  one part — "the shopping process" — and works it. Do not model two contexts in one file to save
  a decision.
- But **do not split prematurely** either. *"If you need to make a decision early, most of the time
  it's the best conscious decision to not split but keep everything in one system until you know
  more."* One model until it hits the size budget or stops being one story.

Do not draw any elements yet. Do not suggest events.

## Phase 1 — brainstorm events

The instruction to give, near-verbatim from the book:

> "Write down what could have happened in the system. Assume it already happened."

One rule: **past tense**. `Product added`, never `Add Product`. Enforce it every time — silently
rewriting a user's present-tense event is fine, but say that you did.

Ask open questions and keep pulling. Duplicates, overlaps and chaos are all fine at this stage —
*"some are duplicates and it starts to get chaotic. That's great!"* Do not order them. Do not ask
about attributes. Do not ask what triggers them.

Prompts that work: what happens when this goes wrong? what happens without anyone clicking
anything? what does an external system tell us? what happens much later?

Draw them as orange event cells in the Event Stream lane, in whatever order they arrived. Anything
the user says arrives from outside is a **yellow external** — and it must say where it comes from:
`origin="<system>"` for a genuine third party, or `from="<context>"` if a sibling model in this
system publishes it.

**Gate:** show the list back and ask what's missing.

## Phase 2 — storyboard

Put the events in chronological order, left to right, so the model reads as one story on a single
timeline.

Then **read the story back as prose** and ask them to confirm it. This is the phase's whole point —
the book has a participant read it aloud, because disputes about order surface real domain
disagreements. Something like: *"First an item is added to the cart. An item in the cart can be
upgraded. The customer can remove items at any point…"*

**Time runs left to right and there is one exception.** *"The goal is to read the system from left
to right. It should be a story that makes sense to everybody."* A connection pointing left is one
nobody can read, so `flow/backward-connection` is an error. The single exception is **Event → View**,
because a read model is necessarily fed by events later than the point it is drawn. Where a screen
reads a View drawn to its right, put the View's column first.

Expect to move things. Expect the user to discover a missing event here.

**Gate:** the story has to make sense to them, not to you. Ask directly.

## Phase 3 — stream boundaries

*"Swimlanes define stream boundaries. Typically, all events in one swimlane end up in a physical
stream."* One horizontal band per business capability, drawn **inside** the Event Stream lane,
declaring `streams="Aggregate, ..."`.

Ask: which of these events belong to the same thing's lifecycle? Then set `aggregate=` on every
event and draw it in the matching band. **An event's y is its stream, not its column** — an event
in no band has an undefined stream, and both that and a mismatch are errors.

Then ask the second question, which is the one that gets forgotten: **what identifies ONE stream of
this?** Not the aggregate's name — the key. One per customer? One per customer *per month*? Set it
as `identity=` on the band, and expect to have to add a field to some events to make it true.

This matters more than it looks and it is a **domain** question, not a technical one. Marten keys a
stream, so without `identity=` nothing can append to it — and the choice decides which business rules
are real invariants. A timesheet keyed per booking cannot enforce "at most 18 hours in a day"; keyed
per employee-month it can. Ask which rules must always hold, then pick the key that makes them
holdable. `band-needs-identity` reports the fields every event in the band already carries, so the
candidates are on screen.

Bands holding only imported or foreign events are exempt: we project from those streams, never
append to them.

The book puts this at step 7. It is here instead because the geometry depends on it: every event
needs a band before the model validates, and moving events later is only cheap because you are the
one drawing. Say this if the user asks why the order differs from the book.

The rule worth enforcing early, from ch. 11:

> *"A single command should never interact with multiple swimlanes or aggregates. The moment you do
> this, you introduce the need for a transactional boundary around the operation."*

So `command-crosses-swimlane` is an error. Two effects that must happen atomically are not two
aggregates — they are one.

**Gate — and it is manual.** Hide every band but one and read its events left to right to the user
as a story. *They should form a compelling narrative.* If the story does not hold, the boundary is
wrong. **Nothing automatic will tell you this**, so actually do it.

## Phase 4 — screens

Smaller scope, more detail. For each step of the story, ask what screen the user is looking at.

Screens are not optional and are not about UX: *"screens help foster understanding and ensure
everyone knows exactly what is being discussed."* **A named box is enough — you are not drawing UI
yet.** Wireframes are phase 8, and drawing them now would commit to a layout before you know
whether the data has a source.

For each screen ask two things, which map onto the book's two highlight colours:

- **What data is displayed?** (the book marks these green) → becomes a read model
- **What action is in focus?** (the book marks the button blue) → becomes a command

Record displayed data as `displays=` and anything typed as `inputs=`.

**A screen is a thing, not a label.** The same screen appears in every slice that triggers from it,
so give it a slug: `screen="timesheet"`. Then `displays=` **must agree** across cells sharing the
slug — what a screen shows is a property of the screen — while `inputs=` **may differ**, because
the same screen legitimately offers different actions in different slices. Set the slug now; the
check needs it and you will not remember later.

**Gate:** every screen that triggers a command has `displays=` set. This is not bookkeeping — it is
the only thing that lets the checker verify a read model actually supplies what the screen needs.
Skip it and the completeness check is one-directional and will pass a read model missing every
attribute.

## Phase 5 — derive data backwards

The engine of the method. *"Backwards thinking is powerful as it focuses on the solution rather
than the problem."* For each slice, in this order, asking the user each time:

1. **Read model fields** — what must the screen display? Straight from phase 4.
2. **Event fields** — *"What data must have been stored in the event(s) to populate the read
   model?"*
3. **Command fields** — *"What data must be provided in the command to populate the event?"* The
   command must supply everything the event persists.

Record these as `fields=`. Ask for types; don't guess them. If the user doesn't care yet, `string`
is an honest placeholder — say that you used one.

Where a name doesn't line up, there are exactly **three honest answers and they are not
interchangeable** — picking the wrong one produces code that compiles and is wrong:

| | Means | Ask |
| --- | --- | --- |
| `mappings="total=totalAmount"` | the **same value** under another name | "is this literally the same number?" |
| `derived="dayTotal=hours"` | **computed** — a sum, a count, a fold | "how is it worked out?" |
| `terminal="closedBy:actor"` | arrives from **context**, not the data flow | "who supplies this — the user, the clock, the handler?" |

A rename cannot change the type. If the types differ it is a computation wearing a rename's
clothes, and `mapping-crosses-types` will say so.

Do not force premature decisions. The book's own example leaves `totalPrice` unresolved between
event and read model: *"we don't have enough information to decide, so either way is fine. Our goal
is to make sure that all data is mapped."* Note the open question and move on.

Throughout: *"we focus on data flow rather than technologies like databases, REST, or messaging."*
If the user starts discussing Postgres or Wolverine, park it — that is codegen's problem.

**Gate:** every cell has `fields=`, or an explicit note saying why not.

## Phase 6 — slices

*"A slice is the smallest possible work that can be handed over to a developer for
implementation."* Give each one an identity: one `em="group"` rectangle drawn around its columns,
carrying `slice=`, `pattern=` and `status="in-design"`.

- Use a **plain rectangle, never a draw.io container** — a container reparents its children and
  makes their geometry relative, breaking every absolute-x reader.
- `pattern=` is one of `command`, `view`, `automation`, `translation`, plus `upstream` for a column
  that is only external events landing in our stream. It is **checked against what the slice
  actually contains**, so declaring it is a real assertion.
- **One Command per State Change slice.** The little book, on more than one: *"No."* More than one
  Event is allowed but *"should not be the rule."*
- A slice must be **one contiguous band**. If its columns aren't adjacent, reorder the columns — a
  vertical slice that isn't vertical isn't a slice.
- Every element inside a band must declare that `slice=`, and every element declaring it must be
  drawn inside.

Watch for the anti-pattern here: `Event -> Processor -> Event` is not an automation. **An automation
is a Trigger** — it watches a todo-list View and issues a Command. If there is no view and no
conditional logic, it is not an automation at all, just a command emitting several events.

**Gate:** `validate` reports no `slice/` findings.

## Phase 7 — the completeness check

**The hard gate.** *"The implementation cannot begin until this check is passed."*

**Delegate the reading.** Run the `completeness-checker` agent rather than checking your own
drawing — you have a stake in it being right and it doesn't. Then mark the model yourself:
`node tools/model.mjs mark <file>`, render, and look. The agent never writes to the diagram, so
there is exactly one writer. `clear` strips every marker and restores the file byte-exactly, so
mark freely.

Do **not** delegate phases 0–5. An agent brainstorming events or naming attributes is the "never
invent a domain fact" rule broken by proxy.

This is discovery, not validation. When an attribute has no source, **walk backwards until you find
where it really comes from.** The book's worked example is the pattern:

- `Item Removed` needs an `itemId`. Nothing supplies it → red arrow.
- Add `itemId` to the `Remove Item` command. *"But this does not really help, since we just moved
  the red arrow one hierarchy further up to the UI."*
- So: how can the UI provide it? → it must be on the screen → the screen needs a read model → and
  that read model is fed by the earlier `Item Added` event.

| For | Source |
| --- | --- |
| Read model attribute | an Event pointing at it |
| Event attribute | the Command that triggers it |
| Command attribute | the View its Trigger displays, or `inputs=` typed on that screen |
| Automation's command | the todo-list View it watches — an automation types nothing |
| External event | **nothing. It is terminal** — that is what external means |

When you hit a dead end, the answer is usually a **missing read model**: the screen needs data it
has no way of knowing. Propose that, don't assert it.

Mark every unresolved gap before handing back — red dashed connection *and* a red `!` badge, since
the arrow alone doesn't say which attribute is unsourced. Never leave a gap invisible, and never
close one by inventing a source.

**A green run does not mean the model is right.** Read the "what the checker cannot see" list in the
system's `OPEN-QUESTIONS.md` before declaring the gate passed. Missing *edges*, per-event
completeness, and delete-vs-upsert edge semantics are all invisible to it.

**Gate:** zero errors. Do not proceed to wireframes or GWTs, and absolutely not to code.

## Phase 8 — wireframes

**Only after phase 7.** A wireframe drawn earlier commits to showing fields that may turn out to
have no source — and then the design has to be redone rather than the model.

The book does draw wireframes, and they are **sketch-level on purpose**: legible at model scale, no
colour, no type, no imagery. A styled mockup here would fight the sticky-note grammar and could not
be read at 180px wide.

`node tools/wireframe.mjs scaffold <file>` grows the UI lane, shifts everything below it, and fills
each screen with one bound cell per attribute plus an action button read off the real edge. **That
is a scaffold, not a design** — say so. The stacked layout it produces asserts nothing; drag the
cells into a real arrangement afterwards.

What makes it worth drawing at all is that every element **declares** what it is:

| | Means |
| --- | --- |
| `em="field" binds="hours"` | shows one attribute of `displays=` / `inputs=` |
| `em="action" command="BookHours"` | the affordance — checked against the edge the screen actually has |
| `em="chrome"` | decoration. Bound to nothing, checked for nothing |

A wireframe of plain rectangles is a picture the checker cannot see, and it will drift from
`displays=` silently. Bound cells make the check two-directional: a field bound to something the
screen doesn't declare is an **error** (the design shows data the system cannot supply); a declared
attribute the wireframe never draws is a **warning** (its View is over-specified).

The action button is the point of the phase, not decoration. It is why one screen appears in three
slices — *"there may be only one HoursBooked per day+project, so booking again is a Correction"* is
a domain fact about affordances, and the button is where it becomes visible.

**Styling is not this skill's job and must not leak into this phase.** No colours, no fonts, no
components, no token talk. If the user starts describing how it should *look*, note it and say it
belongs to the `styling` skill, which runs after this one. The wireframe's only claims are *which
fields are shown, which are typed, and which action is offered* — all three are business
information. Everything else is preference and lives elsewhere.

**Gate:** no `screen/` findings, and you have looked at the render. Ask whether the *fields and the
action* are right — not whether it looks good.

## Phase 9 — GWTs

Business rules, as `GIVEN a set of Events, WHEN a Command, THEN a new set of Events`. One `gwt`
cell each, in the band below the slice it describes.

Ask for the rules; do not derive them from field names. For each slice: what must be true for this
to be allowed? what happens when it isn't? what are the limits?

Set `given=`, `when=` and `then=` as well as a readable label, so the rule is machine-checkable
rather than just prose. **Put the rule text in the label** — several GWTs in a slice share a
given/when/then triple and differ only in the case they describe, so without it they render as
identical grey boxes. An expected rejection is `then="error: RuleName"`.

Ten or more per slice is normal — *"Don't save on GWTs."* If the user gives you one GWT for a
slice, ask for the failure cases.

**Gate:** no `gwt/` findings, and each State Change slice has its rejection cases.

## Phase 10 — Conway, and the gate to `ready`

The other half of the book's step 7, and the one a swimlane is *not* about.

> *"Ideally, each Slice should be owned by a single team… An Event Model often exposes
> organizational challenges — this is Conway's Law in action."*

`owner=` goes **on the lane**, because the usual fault line is UI vs backend. The rule then
**computes** which slices need more than one owner. This does not forbid a split — the book says it
is often unavoidable — it makes you say so out loud with `owners="a, b"` on the slice cell, because
discovering it during implementation costs far more than during modelling.

Expect every State Change slice to cross the line and no other slice to: screen → command → event
crosses by definition, while Views and Automations never touch a screen.

**The GWT band is deliberately unowned.** The business rules are the contract *between* the two
sides and belong to neither.

Then promote what is genuinely done: `in-design` → `ready` → `in-progress` → `in-review` →
`closed`. A slice cannot leave `in-design` while its own cells carry errors or a State Change slice
has no GWT. **Promote one slice, not all of them**, or `ready` stops meaning anything.
`in-progress` is advisory — git gives no mutual exclusion, so real exclusion is **one branch per
slice**.

## When a second model appears

Validate the **folder**, not the file — a single file cannot see whether an imported event is
published anywhere:

```
node tools/model.mjs validate diagrams/<system>/     # every model + the cross-model rules
node tools/model.mjs map      diagrams/<system>/     # regenerate the context map
```

**Only an event crosses a model boundary.** A model's only public surface is an event marked
`public="true"`; a consumer imports it as a yellow external with `from="<context>"`. No read model,
command or screen ever crosses. If two contexts need the same projection, each builds its own from
the events it imports.

**Split when a model stops being readable in one render.** The budget is 3200px (`model-too-wide`).
If you reach for `tools/crop.mjs` to look at a model, it is too big. Alternative flows are the other
splitting axis: *"pick one flow and model it"* — error paths that would disrupt the story become
their own `<model>.<flow>.drawio`.

## Drawing mechanics

- Copy `diagrams/template.drawio`; never model into it. Rename the model cell.
- One `<object>` cell per element so the semantics ride along.
- Stable meaningful ids: `evt-item-added`, `cmd-remove-item`, `rm-cart-contents`, `ui-cart`,
  `gwt-cart-max-items`. Never `node7`.
- Tag every element with `slice=`. Untagged elements generate nothing later.
- **Render and look after every phase.** `node tools/drawio.mjs render <file>`, then Read the PNG.
  Layout defects — edges through boxes, overlapping GWTs, elements outside a lane — are invisible in
  XML and obvious in the image. This is not optional and has caught real bugs repeatedly.
- Every long edge gets its own y in a routing band, allocated sequentially. Several events feeding
  one View must not share a horizontal run.
- Add a column by widening the page and every lane. Never stack a second row into a routing band.
- Read the grid off the model rather than trusting a remembered number — the y values move whenever
  a swimlane is added or the UI lane grows.

## Where this skill stops

Three skills, and the boundary between them is what each one is allowed to invent.

| Skill | Scope | Invents | Gate |
| --- | --- | --- | --- |
| **event-model** | once per context | layout only — never a domain fact | the completeness check, deterministic |
| **styling** | once per *system*, then per new screen | tokens, palette, spacing, components | the human likes it |
| **codegen** | per slice | nothing — it reads the compiled IR | tests pass |

They are a **dependency graph, not a pipeline.** Styling gates only *frontend* codegen. A model with
no screens — `notifications` in `hour-booking` — is backend-only and can go straight to codegen with
no design in existence. Same for any View or Automation slice. Do not make anyone wait on a design
their slice never needed.

The styled design is found **by convention, not by an attribute**: `designs/<screen-slug>.html`. The
screen slug already exists, so a `design=` attribute would be a second place the same fact lives.
The event model never needs to know the HTML exists.

That gives a three-way check, which is `styling`'s to run and not this skill's:

```
displays= / inputs=   ↔   wireframe binds=   ↔   HTML data-em
```

All three must agree on *which fields*. Layout and style are free to differ — that is the whole
point of keeping them in different artifacts.

## Resuming

The `.drawio` files are the entire session state. On re-entry: read them, render them, **look**, and
say where you think the session stopped and which phase is next — then let the user correct you.

Run `node tools/drawio.mjs check <file>` first if a human may have saved since; a compressed file
needs `inflate` before plain reads work. And warn them: **an open draw.io tab is a stale snapshot**
— if they had one open before you edited, saving it silently overwrites your work. Answer no to
"save changes", close, reopen.
