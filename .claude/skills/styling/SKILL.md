---
name: styling
description: >-
  Turn an event model's screens into a styled, reviewable HTML/CSS design. Use when the user wants
  to design or restyle the UI of a modelled system, says "let's style X", "design the screens", or
  invokes /styling. Runs AFTER event-model and BEFORE frontend codegen. Delegates aesthetic
  judgement to the frontend-design plugin, supplies the field contract from the model, and closes
  the loop with real screenshots so a human can actually review what was built.
---

# Styling session

The event model says **which fields a screen shows and which actions it offers**. This skill decides
**what it looks like**. Those are different jobs with different rules, which is why they are
different skills — see the three-skill table in `CLAUDE.md`.

You invent freely here. That is the opposite of `event-model`, where inventing a domain fact is the
cardinal sin. What you may **not** invent is a *field* — see the contract below.

## Prerequisites, checked before anything else

1. **The model's completeness check passes.** `node tools/model.mjs validate`
   must be at zero errors. Styling a screen whose fields have no source means redoing the design
   when the model changes. Stop and say so if it fails.
2. **The screens have wireframes.** Phase 8 of `event-model`. The wireframe is the structural
   decision — which fields, grouped how, which action; the design is its styled realisation.
3. **The `frontend-design` plugin is installed.** Check the available skills. If it is missing, tell
   the user to add it with `/plugin` and offer to continue without it — the result will be
   noticeably more generic, and say so rather than pretending otherwise.

## Delegate the aesthetics. Own the contract.

**Invoke `frontend-design` for the visual direction.** It carries what this skill deliberately does
not: the token-system spec, distinctive type pairing, spatial composition, restraint discipline, and
a list of AI-default looks to avoid. Do not re-derive any of that here.

Brief it with the things it cannot know:

- **What the thing is.** *"An internal tool somebody opens every morning and leaves open all
  day"* is a brief. *"A web app"* is not. Ground it in the subject, as that skill asks.
- **The field contract** for each screen (below). These are not suggestions — a page that shows a
  field the model does not declare is a hard error.
- **Density and medium.** Most modelled systems are internal tools: dense, tabular, keyboard-first,
  looked at for hours. That is a very different brief from a marketing page, and the default
  assumption should be the former unless the user says otherwise.

`frontend-design`'s workflow ends in *"critique using screenshots if available"*. They are always
available here — see §4. Use them.

## 1. The contract: read it from the model, never from memory

```
node tools/model.mjs compile <project>/diagrams/<model>.drawio
```

For each `em="screen"` cell, the IR gives you `screen` (the slug), `displays`, `inputs`, and the
Commands it points at. **The unit of design is the slug, not the cell.** One page per slug, at
`<project>/designs/<slug>.html`, found by convention — there is no `design=` attribute, because the
slug already carries the fact.

That matters because a screen appears in every slice that triggers from it, and **the page must
carry all of their affordances**. Where one screen appears in three slices, its single HTML file needs
all three — an add form *and* per-row correct *and* remove. `displays` is identical
across those cells by rule; `inputs` and the commands are the union.

Mark every bound element so the check can see it:

| Attribute | On | Means |
| --- | --- | --- |
| `data-em="hours"` | any element | shows this attribute of `displays=` |
| `data-em-input="hours"` | an input, select, or the control that acts on a row | the user supplies this |
| `data-em-action="BookHours"` | a button | issues this Command |

An element may carry two bindings where that is honest: a table cell *is* the project
(`data-em="projectId"`) and shows its name (`data-em="projectName"` on the span inside).

**The contract is `displays=` / `inputs=` — never how the data will be produced.** A slice's `pattern=`
has several honest implementations, and the read model behind a screen may end up a live fold, a
snapshot, a cross-stream rollup or a SQL table. None of that changes the field list, which is the whole
point of the contract being fields. Two consequences worth designing for anyway, both cheap to add now
and expensive to retrofit:

- **a state for "not there yet".** Some read-model recipes are eventually consistent, so a value can be
  legitimately absent for a moment after a write. A design with no empty / pending treatment forces the
  frontend agent to invent one.
- **a state for "no rows".** A view's `identity=` says what one row is; a screen showing a list of them
  needs to look right at zero.

## 2. One token set per system

`<project>/designs/tokens.css`. Every screen imports it and **nothing else defines colour or type**.
Keep it to what `frontend-design` specifies: 4–6 named colours, two type roles, one spacing scale,
and one signature element where boldness is spent.

**One variant, not three, unless the user asks.** Options are cheap to render and expensive to
choose between; the POC's job is to reach working code, not to hold a design review.

## 3. One screen at a time, starting with a `ready` slice

Do not style every screen because they are all listed. Style the screen belonging to the slice that
is furthest along — `status="ready"` if one exists — and get it through codegen before styling the
next. One slice all the way down beats one phase all the way across, which is the same thin-slice
argument the rest of the kit is built on.

`design/design-not-drawn` is a **note**, not a failure. Screens without a page are not yet styled and
their wireframe stands in.

## 4. Render and look. This is not optional.

**A human cannot read a stylesheet and picture the result, and neither can you.** The same rule that
governs the model governs the design.

```
node tools/design.mjs sheet --widths 1440,390 --height <fits the tallest>
```

Then **Read the contact sheet PNG** and fix what you see. Three artifacts, three readers:

- `_shots/contact-sheet-<viewport>.png` — every screen at 1:1. This is the one you look at.
- `_shots/<screen>-<viewport>.png` — one per screen per viewport, so a finding can name the one that
  broke.
- `index.html` — for the human, with live iframes and full-size links. A screenshot cannot be
  hovered, tabbed through or resized, so hand this over as well, never instead.

**Shoot mobile as well as desktop where the project asks for it.** `project.json`'s `mobile` decides,
it defaults to **false**, and `--mobile` turns it on for one run without editing anything. Do not add
`--widths 1440,390` by reflex on a project that has switched mobile off — that is overriding a decision
somebody made, and the whole point of the setting is that it is theirs.

**When it IS on, look at both.** A single desktop screenshot hides half the problems, and
responsive layout is where CSS silently fails. When this skill was first exercised, the desktop view
was fine and the mobile view had content running off the right edge, cut off — invisible in the CSS
and unmissable in the image.

A defect worth knowing: **restructuring a table into stacked label/value rows on mobile does not work
by setting `tr`/`td` to `block`** — the table box stays wider than the viewport and the rows spill.
For a dense internal tool, staying a real table and dropping secondary columns is more robust and
much less CSS.

## 5. Check the design against the model

```
node tools/design.mjs check
```

This is the third leg of the three-way check —
`displays=`/`inputs=` ↔ wireframe `binds=` ↔ HTML `data-em`. `model.mjs` already checks the first
two against each other; this checks the styled page, which is the leg nothing could see before.

| | Severity | Means |
| --- | --- | --- |
| `design-unknown-field` | **error** | the page shows data the system cannot supply |
| `design-unknown-action` | **error** | the button and the model disagree |
| `design-orphan-page` | **error** | a page no screen slug points at |
| `design-field-missing` | warn | declared but never shown — its View is over-specified |
| `design-input-missing` | warn | the user must type it and the page does not ask. A dead command |
| `design-action-missing` | warn | the model says this screen offers it; the page does not |
| `design-not-drawn` | note | not styled yet |
| `design-ahead-of-wireframe` | note | the page shows a declared field the wireframe omits |

**Gate:** zero errors, zero warnings, and you have looked at the render. Then ask the human — hand
them `index.html`, not a description.

## What this skill must not do

- **Do not touch the `.drawio`.** If the design needs a field the model does not declare, that is a
  *modelling* change: go back to `event-model`, add it to `displays=`, and give it a View. Adding it
  to the HTML and moving on is how a design starts lying about what the system can do.
- **Do not add a `design=` attribute.** Convention, not configuration.
- **Do not restyle the wireframe.** It stays low-fidelity grey on purpose: legible at model scale,
  impossible to mistake for the design, and not competing with the sticky-note palette.
- **Do not generate framework code.** The HTML/CSS is the design artifact and the reference for
  codegen, not the shipped component.
