# hour-booking — state of the model

Model: [hour-booking.drawio](hour-booking.drawio). Render it and look before doing anything:
`node tools/drawio.mjs render diagrams/hour-booking.drawio`. It is ~7760px wide and ~2340px tall,
so inspect it in windows with `node tools/crop.mjs <file> <x0> <x1> <out>`.

**All six phases are done. The model validates clean.**

`node tools/model.mjs validate diagrams/hour-booking.drawio` →
**0 errors, 0 warnings, 43 notes**, across **19 slices / 48 elements / 55 GWTs**.
Grammar 0, completeness 0, slices 0, GWTs 0.

Phases 0–2 and every business rule are the domain expert's words — those cells carry
`source="<verbatim quote>"`. **Phases 3–4 (screens, fields) were delegated to Claude**; every
invented cell carries `proposed=`. The expert's framing: *"the entire point here is just building
the tooling, not an actual timesheet product"* — this model is a POC and is throwaway.

## Still wants the expert, before anyone implements

**Seven invented failure cases.** 48 of the 55 GWTs quote the expert. Seven do not, and are marked
`proposed=` on the cell. Five are the todo-list tick-off on the three automations
(`MonthAlreadyStarted`, `AlreadyFilled`, `AlreadyNotified`), two are not-found guards
(`BookingNotFound` on remove-booking, `ClosureAlreadySubmitted`, `NoClosureSubmitted`). All are
idempotence cases the model implies but nobody stated. Find them with:

```
grep -o 'rule="[^"]*"[^>]*proposed=' diagrams/hour-booking.drawio
```

**Every slice is still `status="in-design"`.** Moving one to `ready` is a claim about your process,
not about the model, so nothing was promoted automatically. `book-hours` is the obvious first
candidate: 10 GWTs, no findings of its own, and the per-slice gate would now let it through.

**The 43 notes are all deliberate**, and each is a claim worth disagreeing with rather than noise:
17 `external-terminal` (an upstream contract nobody has read), 12 `clock-filled`, 8
`derived-attribute`, 6 `terminal-context`.

## Decisions taken, and why

**External events are terminal** (expert's ruling). `grammar()` already exempted them from needing
a producer; `completeness()` did not, so the rule was unsatisfiable by construction. Now
`completeness/external-terminal` at info. Checked *before* the clock-filled rule, because an
external timestamp is stamped by the **upstream** clock and arrives as payload — calling it
clock-filled invites `UtcNow` at ingest and silently rewrites a foreign fact.

**`derived=` and `terminal=`** (delegated to Claude; the expert asked for whichever answer causes
least future friction). Both deliberately reuse existing shapes — `derived=` parses like
`mappings=`, `terminal=` parses like `fields=`.

- `mappings=` is now strictly a **rename**, and one whose declared types differ warns as
  `mapping-crosses-types`. This catches the exact lie previously shipped: `dayTotal=hours` (a SUM)
  and `month=date` (a `string` from a `DateOnly`).
- `derived="monthStatus=BookingMonthStarted+MonthClosureSubmitted+..."` states a computation and
  is **referentially checked** — each input must be a supplied attribute or the label of a
  connected source. Naming an unconnected event is an error, so it is not a silencer.
- `terminal="closedBy:actor"` covers what arrives from context. Kinds: `actor`, `generated`,
  `clock`, `const`. Reported as notes, never silent.

This closed the last known-unsound item: `cmd-book-hours.bookingId` used to pass by matching the
`bookingId` on the Timesheet's `displays=` — *the row being looked at*, when creating a booking
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
global. `close-month-directly` now carries a `then="MonthClosed"` GWT that passes, which confirms
the fix on the real model and not only on the fixture.

## Domain facts that changed the model, not just added a rule

- **18 hours** is the daily cap.
- **There may be only one `HoursBooked` per day+project.** Booking again is a *Correction*, so
  `BookHours` is not idempotent and the screen must say which action it is offering. A modelling
  fact, not UI polish.
- **A submitted month is still open** and can still be booked into and corrected. Only closing
  stops editing.

## What the deterministic checker cannot see — do not trust a green run alone

**The model validating clean does not mean it is right.** These are live right now:

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
   *data*; the `NotAnAdmin` GWTs state the rule, but nothing structural enforces it.
8. **`derived=` records the inputs, not the formula.** `missingDays=WorkingDayPublished+HoursBooked`
   says where the numbers come from, not that it is a subtraction. A generator still needs a human
   for the arithmetic.
9. **A GWT can be right and useless.** `slice-needs-gwt` fires on an empty slice, but a slice with
   one GWT and nine unwritten rules looks identical to a complete one.
