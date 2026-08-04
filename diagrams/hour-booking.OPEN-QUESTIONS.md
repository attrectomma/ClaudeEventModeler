# hour-booking — where the session stopped

Model: [hour-booking.drawio](hour-booking.drawio). Render it and look before doing anything:
`node tools/drawio.mjs render diagrams/hour-booking.drawio`. It is ~6160px wide, so use
`node tools/crop.mjs` to inspect it in windows.

**Phases 0–4 are done and confirmed by the domain expert. Phase 5 FAILS. Phase 6 (GWTs) has not
started — the model contains zero `gwt` cells.**

`node tools/model.mjs validate diagrams/hour-booking.drawio` → **18 errors, 10 warnings, 12 notes**.
Grammar is clean: 0 violations, all four patterns legal.

Phases 0–2 (events, storyboard) are entirely the expert's words — every such cell carries
`source="<verbatim quote>"`. **Phases 3–4 (screens, fields) were delegated to Claude** and every
invented cell carries `proposed="claude — invented layout/UI/fields, NOT stated by the domain
expert"`. The expert's stated reason: this is a POC proving the kit works, and is throwaway.
Judge `proposed=` cells harder — an invented attribute with no source may not belong at all.

## Blocking the gate — needs the domain expert, nobody else

1. **Where does the set of admins come from?** The expert said *"Any admin can complete the
   closing"*. There is no `AdminAppointed` event, no admin roster view, nothing. Three slices
   (`complete-closure`, `reject-closure`, `close-month-directly`) and the `notify-admins`
   automation have no implementable authorization, and "notify the admins" has no recipient list.
2. **Who should get a closing reminder?** `rm-open-months` can only get a row from `HoursBooked`,
   so an employee who booked *nothing* never gets reminded — precisely the person the reminder
   exists for. Is the set "everyone assigned to a project during that month"?
3. **Is there a working calendar?** Two dead ends need one: `rm-my-month-status.missingDays`, and
   the day expansion behind *"fill the remainder of the month with 0 hours per day"*. Does
   zero-fill write every calendar day, or only working days (weekends, holidays, part-time)?
   Nothing in the model supplies working days — adding a field only moves the red arrow to a
   system nobody asked. `missingDays` may simply be invented; it carries `proposed=`.
4. **Does the upstream `EmployeeAssignedToProject` really carry `employeeName` and
   `projectName`?** Both were added here because `MyProjects` and `AdminEmployeeMonth` needed
   them — a contract reverse-engineered from our own wishes. Has anyone read the real schema?

## Tooling gaps found — decisions, not bugs to blind-fix

- **External events can never pass completeness.** `grammar()` exempts `external` from
  `event-needs-producer` (model.mjs ~line 198); `completeness()` lumps it in with `event` and
  looks for an upstream Command it can never have (~line 290). 9 of the 18 errors are this. They
  should be terminal, like screen `inputs=` and clock-filled timestamps.
- **`assignedAt` / `removedAt` on external events are wrongly excused as `clock-filled`.** They
  are stamped by the *upstream* clock and arrive as payload. Believing that note at
  implementation time means `UtcNow` at ingest — silently rewriting a foreign fact.
- **`mappings=` is a rename and is being used as a silencer.** `dayTotal=hours` is a SUM;
  `month=date` is a type-crossing truncation. A generator reading the IR emits an assignment
  where a fold belongs. Wants a separate `derived=` vocabulary, checkable the way GWTs are
  (every event named must exist and must be an upstream source).
  Consequence that is a real bug, not style: `month` reaches `cmd-submit-month-closure` via
  `rm-my-timesheet`, so **an employee with zero bookings cannot submit a closure at all** — for
  exactly the month the reminder is nagging them about.
- **`monthStatus`** (3 views) is a fold over event *presence*; its "Open" value is the *absence*
  of any closure event, so no rename can ever reach it. Needs `derived=`, not `mappings=`.
- **`closedBy` / `rejectedBy`** (3 commands) are the authenticated principal — ambient, like the
  clock. Wants an `actor=` terminal marker rather than name-based magic. Note `employeeId` is the
  same kind of fact but is laundered through `displays=` on the Timesheet screens, so the checker
  currently *rewards* the dishonest treatment and *punishes* the honest one. Decide both together.
- **Duplicate labels break the GWT checker.** Two cells are labelled `MonthClosed`
  (`evt-month-closed`, `evt-month-closed-direct`). `gwtRules()` builds `byLabel` with
  last-write-wins in document order, so the first GWT written with `then="MonthClosed"` in the
  `complete-closure` slice will get a spurious `gwt-then-not-emitted`. Fix before Phase 6: key by
  `(slice, label)`, or give the cells distinguishable labels.

## Known-unsound, left standing deliberately

- `cmd-book-hours.bookingId` **passes for the wrong reason.** It is sourced from the Timesheet's
  `displays=`, where `bookingId` means *the row I am looking at* — but booking new hours needs a
  *new* id. Same name, opposite meaning. `cmd-correct-hours` / `cmd-remove-booking` are correct:
  they take `bookingId` from `inputs=` (the user picked a row).
- `FillZeroHours.bookingId` and `.hours` are red on purpose. `bookingId` is generated per
  zero-fill; `hours` is the constant 0. Both are the same terminal class as `closedBy`.
- `rm-open-months.closingDate` is red on purpose — it is a calendar fact derived from `month`,
  and the previous `closingDate=date` mapping asserted "the closing date is the date of some
  booking", which is false.

## What the deterministic checker cannot see — do not trust a green run alone

1. **Missing edges.** Attribute rules find unsourced *attributes*, never absent *connections*.
   `evt-month-closed-direct` shipped with zero outgoing edges and nothing went red, because its
   same-labelled twin already supplied every attribute. Found by reading, not by the tool. Fixed.
2. **Union-of-sources is not per-event completeness.** `supplyFor()` unions all upstream events
   and asks only "does some source have this name". Where an attribute comes from event A but the
   row is created by event B, you get a null at runtime and a black arrow on the canvas. Live
   cases: `rm-my-timesheet.projectName` and `rm-admin-employee-month.employeeName` (both only from
   `EmployeeAssignedToProject`; rows are created by `HoursBooked`). Each needs a join, or an
   explicit statement of which event creates the row.
3. **Unsourced-ness does not propagate.** A screen is checked against what its View *declares*,
   not what the View can actually supply. `rm-my-timesheet.monthStatus` is red, yet all three
   Timesheet screens display `monthStatus` with no finding.
4. **Edge semantics.** `evt-employee-removed -> rm-my-projects` means *delete the row*; the other
   edges into that view mean *upsert*. The checker reads both as supply. A delete supplies nothing.
5. **The todo-list tick-off edge is counted as supply.** That is how `ZeroFillTodo` came to be
   sourced from its own output.
6. **Nullability against slice context.** `submittedAt` is well-formed and correctly sourced, and
   always absent on the one slice that displays it. Now `DateTimeOffset?`.
7. **Roles and authorization** have no representation in the grammar at all — see question 1.

## Phase 6 has not started

Zero `gwt` cells across 15 slices. Every rule the expert actually stated currently lives in
`note=` / `source=` prose, where nothing can test it — whole/half hours never 0, any date in the
*open* month, corrections carry the absolute value, "you cannot correct to 0", "closed is closed",
rejection sends them back to editing, the reminder repeats every 3 days. Each implies a rejection
(`then="error: ..."`) and not one exists. Against CLAUDE.md's *"Ten or more per slice is normal"*,
an actual count of zero is the largest single distance between this model and implementable.
