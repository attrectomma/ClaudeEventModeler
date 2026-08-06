# Organizing many event models

**Status: built.** The rules are in `CLAUDE.md`; this file keeps the research and the reasoning
behind them, learned by splitting one real monolithic model. `tools/model.mjs` grew a `system` rule
family and a folder-aware `validate`.

One thing changed on contact with the actual edges — the split came out as **three** contexts, not
the four proposed. See "A worked split" below; it is the most useful finding in this document.

## What the sources actually say

Almost nothing online addresses this. The eventmodeling.org cheat sheet and the canonical
"What is Event Modeling" article both describe building *one* model and say nothing about scope,
size, or multiple models. The single substantial source is Dilger, *Understanding EventSourcing*,
ch. 18 "Structuring an Event Model", with ch. 15 supplying the cross-boundary mechanics.

**Many small models, not one big one.**

> *"It is perfectly fine to have more than one model on a board. In fact, this is the rule rather
> than the exception for me. I prefer having many smaller models over one large model, as it allows
> more flexibility when adjustments are necessary."* — ch. 18

**The size test is readability, not a count.**

> *"The size of your model depends on your personal preference. I aim to capture one business
> context in each model, so I can read it from left to right without any visual interruptions."*

**Each model names itself.** Dilger uses *"a pink sticky note placed on the left side of each model
to properly name it"* — he calls it the Model Context.

**One flow per model. Alternative flows are separate models.**

> *"In Event Modeling, we focus on one use case at a time along a single timeline… Not all software
> follows a linear timeline — we have conditions and loops to consider. How do we model them? The
> short answer: we don't. Instead, pick one flow and model it."*
>
> *"We could add this rule to the current model, but it would disrupt the flow. Most of the time,
> it's easier to define a dedicated model for this."*
>
> *"If there are alternative flows for a certain slice, I place a marker below the slice with a
> link to a different model on the board."*

**Chapters group slices inside a model.** Blue arrows in two layers (chapter / sub-chapter), placed
directly above the model, learned from Adam Dymitruk. *"A chapter defines kind of a context for a
given slice."* The little book maps this to tooling: *"A Slice typically becomes a Ticket. A chapter
( blue arrow ) typically is an Epic."*

**Contexts are not services.**

> *"Very often, bounded contexts immediately get translated to the technical side and correlated
> with something like microservices. That's a big mistake… You can have many different contexts
> within one system."* — ch. 12

**Crossing a system boundary goes through an external event, via the Automation pattern.** Ch. 15:
you never let another system rebuild your state from your internal events.

> *"We certainly do not want the order system to have to rebuild the cart from scratch using all the
> low-level events from the cart internals… The external event should contain all the information
> necessary to process the order."*
>
> *"external events should not be sparse; they should contain all the data a system needs to act and
> make decisions."*

The mechanism is a read model, an automation processor that translates, and a command that emits the
external event into its own swimlane — i.e. the **Translation pattern** the kit already has.

## The signals that say "split this"

These are the four that showed up on the model this kit was built against — a monolith that grew to
**7760px wide** and could not be read in a single render. `tools/crop.mjs` exists precisely because you
had to inspect it in windows, which is the literal opposite of *"read it from left to right without any
visual interruptions."*

Three more signals, all structural:

**One swimlane is a junk drawer.** Four bands each named a single aggregate. The fifth declared five at
once — every piece of reference data that had to exist somewhere. Five aggregates in one band is not a
stream boundary; it is everything that didn't fit the story.

**The contexts are interleaved along the timeline.** Reading the 19 slices in x-order, reference-data
slices sat at x=2960 and x=4560 — in the middle of two unrelated stories. Interleaving is what you get
when several stories are forced onto one timeline.

**51 unverifiable notes.** Every `external-terminal` note says "this arrives from outside and nothing can
check it." Some of that is genuinely true. Much of it was only true because the *producing context was
not modelled* — splitting turns those into checkable imports.

## The architecture

Four levels. Only two of them are files.

| Level | Is | Lives in |
| --- | --- | --- |
| **System** | a product / deployable whole | **the project folder** — one kit copy, one project, one system |
| **Model** | one business context, one flow | one `.drawio` file in `<project>/diagrams/` |
| **Chapter** | a group of slices inside a model | an attribute (deferred — see below) |
| **Slice** | the unit of work; one branch, one ticket | a slice cell, as today |

### Folder structure

```
<project>/                            <- the system IS the project, and its own git repo
  inbox/                              <- raw input; the phase-0 baseline
  diagrams/
    ordering.drawio
    fulfilment.drawio
    notifications.drawio
    ordering.errors.drawio            <- alternative flow of ordering.drawio
    _context-map.drawio               <- GENERATED, never hand-edited
```

The kit keeps `templates/template.drawio` and its own `tools/fixtures/`; neither is a model of
anyone's system.

**There is no `<system>` folder level.** There was, when one repo held every system. Once a kit copy
serves exactly one project, that level only ever repeated the project's own name —
`acme-shop/diagrams/acme-shop/` — so it was dropped. A project that genuinely grows a second
independently-deployable system gets a second project folder and a second kit copy, which is the
same answer the book gives for when to split anything.

**No manifest file.** No `system.yml`, no index. The kit's founding bet is that the diagram is the
single source of truth; a manifest would be a second place facts live and a second thing to keep in
sync. Every fact sits on a cell, and anything system-wide is *derived*.

**Alternative flows are named `<model>.<flow>.drawio`** so they sort adjacent to their parent and the
parent is obvious from the name.

### The model cell

Same precedent as the slice cell: identity is a cell, not a string. This is Dilger's pink Model
Context note, and it renders as one.

```xml
<object id="model-ordering" label="Ordering&#10;<system> · context"
        em="model" context="ordering" system="<system>">
  <mxCell style="fillColor=#f8cecc;strokeColor=#b85450;..." vertex="1" parent="1">
    <mxGeometry x="-260" y="40" width="180" height="90" as="geometry" />
  </mxCell>
</object>
```

It declares **identity only**. Imports and exports are derived from the cells, not restated here —
otherwise there are two places to keep in sync, which is the thing the whole kit avoids.

### How models reference each other

One rule, and it reuses grammar the kit already has:

> **A model's only public surface is an event marked public. A model imports it as a yellow external
> event declaring where it came from.**

Nothing else crosses. No model may point at another model's read model, command, screen or
unmarked event.

On the producing side:

```xml
<object id="evt-employee-assigned" label="EmployeeAssignedToProject" em="event"
        aggregate="Membership" public="true" ... />
```

On the consuming side, two cases — both yellow, and the difference is whether anything can check it:

| | Means | Checked |
| --- | --- | --- |
| `from="reference-data"` | published by a sibling model in this system | **yes** — the label must exist there, be `public="true"`, and its `fields=` must cover what we consume |
| `origin="SAP Payroll"` | a genuine third party | no — a note, exactly as today |

That second row is what the 51 `external-terminal` notes become. The first row is new checking power
the model does not have today: **cross-model completeness**. An import that names an event nobody
publishes is an error, and it is invisible right now because the producing side isn't in the file.

**Within one system, direct event consumption is allowed but must be declared.** Dilger is explicit
that a context is not a service and that you should *"not split but keep everything in one system
until you know more."* Forcing full ch. 15 translation between two contexts of one deployable would
be ceremony. So the kit does what it already does for Conway: it does not forbid the coupling, it
makes you say it out loud. An undeclared cross-model reference is an **error**; a declared one is a
**note** on the context map. Full translation (read model → automation → command → external event)
becomes required only when the boundary is a real system boundary.

### Size budget: one readable render

The book gives a criterion, not a number: read it left to right without visual interruption. This kit
already has a hard-won practice that says the same thing operationally — **always render and look** —
and a tool that exists only because the current model defeats it.

So: **a model must be legible in a single render. If you need `crop.mjs`, it is too big.**

As a warning threshold, ~3200px wide (≈10 columns, ≈8 slices). That number is a starting point to
tune from the first few real renders, not a law. Above it, `model.mjs` says so; it never blocks,
because a genuinely linear ten-slice story is a legitimate thing to have.

Expect models of **4–8 slices**. The four contexts below land in that range.

### Chapters: defined, deliberately not built

Chapters and multiple models solve the same problem — too many slices to read at once — at different
scales. If models stay at 4–8 slices, chapters are unnecessary, and Dilger's own preference is
*"many smaller models over one large model."*

So: reserve `chapter=` / `subchapter=` on the slice cell, build no tooling, and **prefer splitting**.
Reach for chapters only when a context is genuinely one readable story that still has a lot of
slices. The Jira mapping (chapter = epic, slice = ticket) is the reason to keep the names.

### Alternative flows

A slice may carry `flows="ordering.errors"`, rendering as Dilger's marker below the slice, linked to
the sibling file. The error cases that are cheap stay as GWTs — the book says so explicitly; the ones
that would *"disrupt the flow"* become their own model.

## A worked split, and what the edge list changed

### A tidy-looking proposal did not survive the edge list

The first proposal was four contexts, one of them a `reference-data` model holding everything upstream.
Enumerating every edge that would cross those boundaries turned up exactly **three that were not events** —
each one a View reaching into another context.

Under *"only an event crosses"* those are illegal, and the honest fix is the one ch. 15 gives: the consumer
imports the *events* and builds its own projection. But then the reference-data context had no consumer of
its own left — it became a model with no views, no commands and no screens, just genesis events. That is an
integration surface, not a story you can read left to right, so it fails the one test the book actually
gives for a model.

**Dissolving it removed all three problems at once.** Each upstream event is drawn in the context that
consumes it, which is exactly what `em="external"` already meant. Where two contexts need the same
foreign fact, both draw it — and that is not duplication: they are two contexts independently consuming an
outside fact, which is what `origin=` records.

The general lesson: **enumerate the crossing edges before committing to a boundary.** A context that only
ever *publishes* is an integration surface wearing a model's clothes, and the tell is that nothing inside it
reads anything.

### What the split produced

19 slices in one 7760px model became 20 slices in three models of 1940–2960px — all under the 3200px
budget and each legible in a single render. The extra slice is the `upstream-*` column each model needs
for its imports.

Three slices merged along the way: what had been drawn as three adjacent view columns was really one view
slice, which is what made it non-contiguous in spirit if not in geometry.

**One of the three models came out single-owner**, which is the Conway payoff: a whole context one agent
can build end to end, because it has no screens.

### The cycle the map found

Two of the three models each imported the other's events — one needed the other's status events for a
field, the other needed the first's line-item events for its totals. Legal (a projection may read many
streams) and reported as `system/context-cycle`, because it is exactly the shape that means a boundary
might be in the wrong place. Left as-is: those two really were distinct lifecycles observing each other.

## What the tooling grew

1. **`validate` takes a system folder.** Per-model rules run unchanged; `compile`, `mark` and
   `clear` still take one file.
2. **A `system` rule family.** Errors: `unpublished-import`, `unknown-source-model`, `self-import`,
   `import-field-missing`, `slice-name-collision`, `model-cell-duplicated`. Warnings:
   `model-too-wide`, `model-needs-cell`, `model-context-mismatch`, `import-field-type`. Notes:
   `unconsumed-export`, `external-unattributed`, `context-cycle`.
3. **`em="model"` is not an element.** Left in `elements` the model cell reported as unsliced and
   `laneOf()` tried to place a note belonging to no lane.
4. **A generated context map** — `model.mjs map <dir>/` writes `_context-map.drawio` from the real
   publish/import edges. This is what a Miro board gives free and a folder does not: seeing every
   model and how they relate. Generated, so it cannot drift. The leading `_` keeps it out of
   `validate`.
5. **`crop.mjs` is no longer load-bearing.** It stays for the odd wide model, but three models that
   each render legibly whole is the point.

All six error rules were negative-tested by deliberately breaking a copy of the system: un-publishing
an imported event, importing a field the publisher does not carry, pointing `from=` at a model that
does not exist, and reusing a slice name across two models. A check that has never been seen to fail
is not a check.

## Open questions

1. **Are those three contexts right?** They fall out of the aggregates and swimlanes, but stream
   boundaries were themselves a modelling decision. The book's validation test still applies: read
   each model's events left to right to someone from the business and see if the story holds.
2. **Is a folder one system or several?** If one context ever became a separate deployable, its imports
   become full ch. 15 translations rather than declared direct consumption.
3. **Nothing checks that a model is one *flow*.** The size budget and the import rules are
   structural; "one use case along a single timeline" is not something geometry can see.
4. **`upstream-*` slices are a layout device, not a slice.** Each model needs one column to land its
   imports, declared `pattern="upstream"`. It carries no work, so as a *ticket* it is empty — which
   is worth revisiting when slices start becoming branches.
5. **Alternative flows are specified and unbuilt.** `flows=` on a slice cell, rendering as Dilger's
   marker with a link to the sibling file. Nothing in the model needs one yet.
