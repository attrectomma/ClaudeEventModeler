# hour-booking — state of the system

Three models, one system. Render them and look before doing anything:

```
node tools/model.mjs validate diagrams/hour-booking/     # every model + the cross-model rules
node tools/model.mjs map      diagrams/hour-booking/     # regenerate _context-map.drawio
node tools/drawio.mjs render  diagrams/hour-booking/booking.drawio
```

**Each model now renders legibly whole**, which is the point of the split — `tools/crop.mjs` is no
longer needed to read this system.

| Model | Slices | Screens | Width | Owner |
| --- | --- | --- | --- | --- |
| [booking](booking.drawio) | 8 | 3 (one screen, three affordances) | 2900px | frontend + backend |
| [month-closure](month-closure.drawio) | 8 | 4 (three screens) | 2960px | frontend + backend |
| [notifications](notifications.drawio) | 4 | none | 1940px | **backend only** |

`node tools/model.mjs validate diagrams/hour-booking/` →
**0 errors, 0 warnings, 108 notes**, across **3 models / 20 slices / 192 elements** (elements
including GWTs and wireframe cells). See [_context-map.png](_context-map.png) for how the three
relate.

Why three and not the four originally proposed, and what the tooling grew: see
[MODEL-ORGANIZATION.md](../../MODEL-ORGANIZATION.md).

## Done since the split

1. **Screen identity.** `screen=` slugs on all 7 screen cells — `timesheet` ×3,
   `admin-month-review` ×2, `month-closing`, `admin-employee-months` — with the asymmetric rule:
   `displays=` must agree across a slug, `inputs=` may differ.
2. **Native draw.io wireframes** in the UI lane of both models with screens. Screens grew 180×90 →
   180×300, the UI lane 180 → 390, and everything below shifted 210px. 61 bound `field` cells, 7
   `action` buttons read off the real edges. Low fidelity by design.
3. **The `screen` rule family**, all negative-tested: `screen-displays-disagree`, `field-unbound`,
   `field-binds-nothing`, `action-unknown-command`, `wireframe-orphan` (errors);
   `screen-needs-slug`, `screen-label-varies`, `field-not-drawn` (warnings).
4. **The skill rewritten** as an 11-phase ordered walkthrough, and `diagrams/template.drawio`
   brought onto the current grid with a model cell and a wireframe-height UI lane.

## Next session starts here

**The styled design, and codegen.**

1. **Style/tokens skill** → `designs/tokens.css` from a human's words, 2–3 variants to choose from.
2. **Per-screen HTML** → `designs/<screen>.html`, elements tagged `data-em="<field>"`, so the same
   two-directional check that runs against the wireframe can run against the styled design. The
   model gets a `design=` link, never an embedded image. This makes it a **three-way** check:
   `displays=`/`inputs=` ↔ wireframe `binds=` ↔ HTML `data-em`.
3. **Codegen is NOT started**, and its blocker is unchanged — Wolverine/Marten/Alba move faster than
   model knowledge and the local `llms.txt` mirror is still unbuilt.

## Provenance

Phases 0–2 and every business rule are the domain expert's words, quoted in `source=` on the cell.
**Screens and field names were delegated to Claude** and carry `proposed=`. The expert's framing:
*"the entire point here is just building the tooling, not an actual timesheet product"* — this system
is a POC and is throwaway. Sacrificing domain fidelity to drive the kit forward is explicitly
sanctioned.

## Slice status

`book-hours` is **`status="ready"`** — 10 GWTs, no findings of its own, the pilot for the per-slice
gate. Every other slice is `in-design`. One promoted rather than twenty, so `ready` still means
something.

**The 108 notes are all deliberate**, and each is a claim worth disagreeing with rather than noise:
`external-terminal`, `clock-filled`, `derived-attribute`, `terminal-context`,
`conway/slice-crosses-teams`, `system/context-cycle`.

## Domain facts that changed the model, not just added a rule

- **18 hours** is the daily cap.
- **There may be only one `HoursBooked` per day+project.** Booking again is a *Correction*, so
  `BookHours` is not idempotent and the screen must say which action it is offering. A modelling
  fact, not UI polish — and now the reason screen identity needs `displays` and `inputs` treated
  differently.
- **A submitted month is still open** and can still be booked into and corrected. Only closing
  stops editing.

## What the deterministic checker cannot see — do not trust a green run alone

**The system validating clean does not mean it is right.** These are live right now:

1. **Missing edges.** Attribute rules find unsourced *attributes*, never absent *connections*.
   `evt-month-closed-direct` once shipped with zero outgoing edges and nothing went red, because its
   same-labelled twin supplied every attribute. Found by reading, not by the tool.
2. **Union-of-sources is not per-event completeness.** `supplyFor()` unions all upstream events and
   asks only "does some source have this name". Where an attribute comes from event A but the row is
   created by event B, you get a null at runtime and a black arrow on the canvas. **The tool still
   cannot tell you which event creates a view's rows**, so the next one will be just as invisible.
3. **Unsourced-ness does not propagate.** A screen is checked against what its View *declares*, not
   what the View can actually supply.
4. **Edge semantics.** `EmployeeRemovedFromProject -> MyProjects` means *delete the row*; the other
   edges into that view mean *upsert*. The checker reads both as supply. A delete supplies nothing.
5. **The todo-list tick-off edge is counted as supply.** That is how `ZeroFillTodo` once came to be
   sourced from its own output.
6. **Nullability against slice context.** `submittedAt` is well-formed and correctly sourced, and
   always absent on the one slice that displays it. Hence `DateTimeOffset?`.
7. **Roles and authorization** have no representation in the grammar. `AdminSeeded` supplies the
   *data*; the `NotAnAdmin` GWTs state the rule, but nothing structural enforces it.
8. **`derived=` records the inputs, not the formula.** `missingDays=WorkingDayPublished+HoursBooked`
   says where the numbers come from, not that it is a subtraction.
9. **A GWT can be right and useless.** `slice-needs-gwt` fires on an empty slice, but a slice with
   one GWT and nine unwritten rules looks identical to a complete one.
10. **Nothing checks a model is one *flow*.** The size budget and the import rules are structural;
    "one use case along a single timeline" is not something geometry can see.
11. **An import is checked by name and type, not by meaning.** `system/import-field-missing` catches
    a field the publisher does not carry. It cannot catch a field that means something *different* on
    the other side of the boundary — which is precisely what a bounded context makes likely.
12. **The same foreign fact drawn in two models is not cross-checked.** `EmployeeAssignedToProject`
    appears in `booking` and `month-closure` with `origin="genesis seed"`; if the two `fields=` lists
    drifted apart nothing would notice, because neither is the publisher of the other.
