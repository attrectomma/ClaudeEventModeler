---
name: event-model
description: Facilitate an Event Modeling session and draw the model in draw.io while the user talks. Use when the user wants to model a system, domain, feature or use case as an event model — "let's model X", "model the ordering flow", "start an event modeling session", or when they invoke /event-model. Claude asks the questions and does all the drawing; the user supplies the domain knowledge. Follows Martin Dilger's method: brainstorm events, order them into a storyboard, sketch screens, derive data backwards, close the information completeness check, then write GWTs.
---

# Event modeling session

You facilitate. The user holds the domain knowledge. You hold the method and the pen.

Read `CLAUDE.md` for the palette, the cell-data attribute schema, the four patterns and the
layout grid. This skill is the *session*: what to ask, in what order, and when to stop.

## The one rule that matters most

**Never invent a domain fact.** Not an event, not an attribute, not a business rule, not a
screen. If you need one and don't have it, ask. An invented `customerId` looks exactly like a
real one in XML and is worse than an empty diagram, because it silently passes the completeness
check and nobody notices until implementation.

You may freely invent *layout* — positions, routing, ids, column order. That is your job.

## Stop between phases

Each phase below ends with a confirmation gate. Draw what the phase produced, render it, look at
the PNG, show the user, and **wait**. Do not run two phases in one turn because the answer to
phase 2 seems obvious from phase 1. The value of the method is the conversation each phase forces.

If the user gives you information belonging to a later phase, note it and stay where you are.

## Phase 0 — requirements, no modelling

Ask for the loose requirement list, in their words. Nothing else. The book starts here
deliberately: *"The only thing we have right now is a loose set of requirements… We will start by
simply trying to list the facts we know about the system."*

Do not draw anything yet. Do not suggest events.

If the user names a scope wider than one process, ask which part to model first. The book picks
one part — "the shopping process" — and works it.

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

Draw them as orange event cells in the Event Stream lane, in whatever order they arrived.

**Gate:** show the list back and ask what's missing.

## Phase 2 — storyboard

Now put the events in chronological order, left to right, so the model reads as one story on a
single timeline.

Then **read the story back as prose** and ask them to confirm it. This is the phase's whole
point — the book has a participant read it aloud, because disputes about order surface real
domain disagreements. Something like: *"First an item is added to the cart. An item in the cart
can be upgraded. The customer can remove items at any point…"*

Expect to move things. Expect the user to discover a missing event here.

**Gate:** the story has to make sense to them, not to you. Ask directly.

## Phase 3 — screens

Smaller scope, more detail. For each step of the story, ask what screen the user is looking at.

Screens are not optional and are not about UX: *"screens help foster understanding and ensure
everyone knows exactly what is being discussed."* A named box is enough — you are not drawing UI.

For each screen ask two things, which map onto the book's two highlight colours:

- **What data is displayed?** (the book marks these green) → becomes a read model
- **What action is in focus?** (the book marks the button blue) → becomes a command

Draw screens as white cells in the UI lane, one column per step.

**Gate:** confirm each screen's displayed data and its action before deriving anything.

## Phase 4 — derive data backwards

The engine of the method. *"Backwards thinking is powerful as it focuses on the solution rather
than the problem."* For each slice, in this order, asking the user each time:

1. **Read model fields** — what must the screen display? Straight from phase 3.
2. **Event fields** — *"What data must have been stored in the event(s) to populate the read
   model?"*
3. **Command fields** — *"What data must be provided in the command to populate the event?"* The
   command must supply everything the event persists.

Record these as `fields=` on the cells via cell data. Ask for types; don't guess them. If the
user doesn't care yet, `string` is an honest placeholder — say that you used one.

Do not force premature decisions. The book's own example leaves `totalPrice` unresolved between
event and read model: *"we don't have enough information to decide, so either way is fine. Our
goal is to make sure that all data is mapped."* Note the open question and move on.

Throughout: *"we focus on data flow rather than technologies like databases, REST, or
messaging."* If the user starts discussing Postgres or Wolverine, park it — that is codegen's
problem, not the model's.

**Gate:** every cell has `fields=`, or an explicit note saying why not.

## Phase 5 — close the completeness check

**Delegate this one.** Run the `completeness-checker` agent on the model rather than checking your
own drawing — you have a stake in it being right, and it doesn't. The tool it wraps
(`node tools/model.mjs validate <file> --json`) is the authority on what has no source; the agent
supplies the judgement and the backwards walk; you relay its findings and drive the fix with the
user.

Then mark the model yourself: `node tools/model.mjs mark <file>`, render, and look. The agent
never writes to the diagram, so there is exactly one writer. `node tools/model.mjs clear <file>`
strips every marker and restores the file byte-exactly, so mark freely.

Do **not** delegate phases 0–3. An agent brainstorming events or naming attributes is the
"never invent a domain fact" rule broken by proxy.

This is discovery, not validation. When an attribute has no source, **walk backwards until you
find where it really comes from.**

The book's worked example, which is the pattern to follow:

- `Item Removed` needs an `itemId`. Nothing supplies it → red arrow.
- Add `itemId` to the `Remove Item` command. *"But this does not really help, since we just moved
  the red arrow one hierarchy further up to the UI."*
- So: how can the UI provide it? → it must be on the screen → the screen needs a read model →
  and that read model is fed by the earlier `Item Added` event.

Three legitimate places an attribute's data can come from, and no others:

| For | Source |
| --- | --- |
| Read model attribute | an Event pointing at it |
| Event attribute | the Command that triggers it |
| Command attribute | the View its Trigger displays, or `inputs=` the user types on that screen |

When you hit a dead end, the answer is usually a **missing read model** — the screen needs to be
shown data it currently has no way of knowing. Propose that, don't assert it.

Mark every unresolved gap before you hand back: red dashed connection *and* a red `!` badge on
the element, since the arrow alone doesn't say which attribute is unsourced. Never leave a gap
invisible, and never close one by inventing a source.

**Gate:** the model does not proceed to GWTs, and absolutely not to code, until this passes.
*"The implementation cannot begin until this check is passed."*

## Phase 6 — GWTs

Business rules, as `GIVEN a set of Events, WHEN a Command, THEN a new set of Events`. One `gwt`
cell each, in the band below the slice it describes.

Ask for the rules; do not derive them from field names. For each slice: what must be true for
this to be allowed? what happens when it isn't? what are the limits?

Ten or more per slice is normal — *"Don't save on GWTs; they are a perfect…"* If the user gives
you one GWT for a slice, ask for the failure cases.

**Gate:** each slice has at least one GWT and its rejection cases.

## Drawing mechanics

- Start from `diagrams/template.drawio` — copy it, never model into it.
- One `<object>` cell per element so semantics ride along; see `CLAUDE.md` for the schema.
- Stable meaningful ids: `evt-item-added`, `cmd-remove-item`, `rm-cart-contents`, `ui-cart`,
  `gwt-cart-max-items`.
- Tag every element with `slice=`. Untagged elements generate nothing later.
- **Render and look after every phase.** `node tools/drawio.mjs render <file>`, then Read the PNG.
  Layout defects — edges through boxes, overlapping GWTs, elements outside a lane — are invisible
  in XML and obvious in the image. This is not optional and has caught real bugs.
- Widen the page and every lane to add columns; do not stack rows into the y=350..470 routing band.

## Resuming

The `.drawio` file is the entire session state. On re-entry, read it, render it, look at it, and
say where you think the session stopped and which phase is next — then let the user correct you.
Check `node tools/drawio.mjs check <file>` first if a human has saved since; a compressed file
needs `inflate` before plain reads work.
