# hour-booking — where the session stopped

Model: [hour-booking.drawio](hour-booking.drawio). Render it and look before doing anything:
`node tools/drawio.mjs render diagrams/hour-booking.drawio`. It is ~7760px wide, so inspect it in
windows with `node tools/crop.mjs <file> <x0> <x1> <out>`.

**Phases 0–5 are done. The information completeness gate PASSES.** Phase 6 (GWTs) is next and has
not started.

`node tools/model.mjs validate diagrams/hour-booking.drawio` →
**0 errors, 11 warnings, 43 notes**, across **19 slices / 48 elements**.
Grammar: 0 violations. Slices: 0 violations. Every warning is `gwt/slice-needs-gwt`.

Phases 0–2 are the domain expert's words — those cells carry `source="<verbatim quote>"`.
**Phases 3–4 (screens, fields) were delegated to Claude**; every invented cell carries
`proposed="claude — invented layout/UI/fields, NOT stated by the domain expert"`. The expert's
framing: *"the entire point here is just building the tooling, not an actual timesheet product"* —
this model is a POC and is throwaway. Judge `proposed=` cells harder.

## What is left: Phase 6

Zero `gwt` cells across 19 slices. Every rule the expert stated lives in `note=`/`source=` prose,
where nothing can test it:

- whole or half hours, **never 0**
- any date in the **open** month — future ("employees may prefill") and past
- corrections carry the **absolute** value; truth = last `HoursCorrected`, else `HoursBooked`
- you cannot correct to 0, so removal is the only way to take a line back
- booking to a project you have left is **rejected and nothing is persisted**
- "closed is closed"
- a rejection sends the employee back to editing
- the reminder repeats **every 3 days** while the month stays open
- zero-fill covers **working days only**
- all admins can see everything

Each implies a rejection (`then="error: ..."`) and not one exists. Against CLAUDE.md's *"Ten or
more per slice is normal"*, a count of zero is the whole remaining distance to implementable.

The per-slice gate means Phase 6 can start on one slice at a time: `book-hours` is not blocked by
anything elsewhere. A slice moves off `status="in-design"` only once it has GWTs and no errors of
its own.

## Decisions taken, and why

**External events are terminal** (expert's ruling). `grammar()` already exempted them from needing
a producer; `completeness()` did not, so the rule was unsatisfiable by construction. Now
`completeness/external-terminal` at info. Checked *before* the clock-filled rule, because an
external timestamp is stamped by the **upstream** clock and arrives as payload — calling it
clock-filled invites `UtcNow` at ingest and silently rewrites a foreign fact.

**`derived=` and `terminal=`** (delegated to Claude; expert asked for whichever answer causes least
future friction). Both deliberately reuse existing shapes — `derived=` parses like `mappings=`,
`terminal=` parses like `fields=`.

- `mappings=` is now strictly a **rename**, and a mapping whose declared types differ warns as
  `mapping-crosses-types`. This catches the exact lie previously shipped: `dayTotal=hours` (a SUM)
  and `month=date` (a `string` from a `DateOnly`).
- `derived="monthStatus=BookingMonthStarted+MonthClosureSubmitted+..."` states a computation and
  is **referentially checked** — each input must be a supplied attribute or the label of a
  connected source. It is not a silencer: naming an unconnected event is an error.
- `terminal="closedBy:actor"` covers what arrives from context. Kinds: `actor`, `generated`,
  `clock`, `const`. Reported as notes, never silent.

This also closed the last known-unsound item: `cmd-book-hours.bookingId` used to pass by matching
the `bookingId` on the Timesheet's `displays=` — *the row being looked at*, when creating a booking
needs a **new** id. Now `terminal="bookingId:generated"`.

**Slices are first-class.** Each has a slice cell (`em="group"` + `slice=` + `pattern=` +
`status=`) drawn as a contiguous band, `pattern=` checked against what the slice contains, and
membership checked geometrically both ways. `status=` turns the gate per-slice. `in-progress` is
advisory, not a lock — git gives no mutual exclusion, so real exclusion is one branch per slice.

**GWT label resolution.** `gwtRules()` used a `label -> element` map, last write wins, so with two
cells labelled `MonthClosed` a correct GWT in `complete-closure` would have failed while the same
shape in `close-month-directly` passed. Scoping to `(slice, label)` — the obvious fix — would have
broken every honest `given=`, which almost always names an event from an *earlier* slice. The three
fields now resolve at their own scopes: `when` slice-only, `then` slice-first-then-global, `given`
global. Regression-tested against the real shape.

## What the deterministic checker still cannot see — do not trust a green run alone

**The gate passing does not mean the model is right.** These are live in this model right now:

1. **Missing edges.** Attribute rules find unsourced *attributes*, never absent *connections*.
   `evt-month-closed-direct` once shipped with zero outgoing edges and nothing went red, because
   its same-labelled twin supplied every attribute. Found by reading, not by the tool.
2. **Union-of-sources is not per-event completeness.** `supplyFor()` unions all upstream events and
   asks only "does some source have this name". Where an attribute comes from event A but the row
   is created by event B, you get a null at runtime and a black arrow on the canvas. **Live:**
   `rm-my-timesheet.projectName` and `rm-admin-employee-month.employeeName` come only from
   `EmployeeAssignedToProject`, while rows are created by `HoursBooked`. Each needs a join, or an
   explicit statement of which event creates the row.
3. **Unsourced-ness does not propagate.** A screen is checked against what its View *declares*, not
   what the View can actually supply.
4. **Edge semantics.** `evt-employee-removed -> rm-my-projects` means *delete the row*; the other
   edges into that view mean *upsert*. The checker reads both as supply. A delete supplies nothing.
5. **The todo-list tick-off edge is counted as supply.** That is how `ZeroFillTodo` once came to be
   sourced from its own output.
6. **Nullability against slice context.** `submittedAt` is well-formed and correctly sourced, and
   always absent on the one slice that displays it. Hence `DateTimeOffset?`.
7. **Roles and authorization** have no representation in the grammar. `AdminSeeded` supplies the
   *data*; nothing enforces *"any admin can"*. That is Phase 6.
8. **`derived=` records the inputs, not the formula.** `missingDays=WorkingDayPublished+HoursBooked`
   says where the numbers come from, not that it is a subtraction. A generator still needs a human
   for the arithmetic.
