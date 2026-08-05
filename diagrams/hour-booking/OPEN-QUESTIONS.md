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

## Styling: done for one screen, on purpose

`designs/hour-booking/` holds `tokens.css` and `timesheet.html`, checked green by
`node tools/design.mjs check diagrams/hour-booking/`. **One screen and one token variant** — the
`book-hours` slice is the one at `status="ready"`, so its screen went first, and the POC's job is to
reach working generated code once rather than to style four screens. The other three report
`design/design-not-drawn`, a note, and their wireframes stand in.

`tokens.css` has not been through Anthropic's `frontend-design` plugin, which was not installed when
it was written. Installing it (`/plugin`) and re-running `styling` improves the aesthetics without
changing the contract or the checks. See [designs/README.md](../../designs/README.md).

## Codegen: prerequisites done, generation not started

The agreed order, and where it stands:

| | Step | State |
| --- | --- | --- |
| 1 | `llms.txt` mirror for Marten / Wolverine / Alba | **done** — 392 pages, `node tools/docs.mjs sync` |
| 2 | system-level IR | **done** — `node tools/model.mjs compile diagrams/hour-booking/` |
| 3 | contract generation: events, aggregates, projections, **and the failing Alba tests** | next |
| 4 | `book-hours` end to end, one agent, sequential, until `dotnet test` is green | |
| 5 | docker-compose for the human demo, strictly separate from the test infrastructure | |
| 6 | *then* the orchestrator and parallel fan-out | deferred on purpose |

The IR for this system: **16 events, 9 aggregates, 10 views, 4 screens, 17 of 20 slices generating**
(the three `upstream-*` columns only land other people's events, so they generate nothing).

**Generate the Alba tests in step 3, before any implementation, and let them fail.** The GWTs come
from the model, not from the code, so tests built from them cannot be tautological — and it makes the
GWT band's role as the unowned contract between frontend and backend literal.

Two decisions still open, both flagged during the concept review:

- **FluentValidation vs aggregate rules.** A GWT with an empty `given` is *input* validation (hours
  must be whole or half); a GWT whose `given` names events is a *state* decision (a closed month
  cannot be booked into) and belongs on the aggregate, where it can see the stream. Getting this
  wrong puts business rules in validators that cannot enforce them.
- **One Postgres, not N.** Testcontainers per agent would be one container per agent. One instance per
  test assembly with schema isolation is the answer.

Note the skill order is a **dependency, not a pipeline**: styling gates only *frontend* codegen.
[notifications](notifications.drawio) has no screens, so it is backend-only and could go to codegen
today with no design in existence.

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
