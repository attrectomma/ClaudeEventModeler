# hour-booking — where the session stopped

Model: [hour-booking.drawio](hour-booking.drawio). Render it and look before doing anything:
C:ReposAttrectoClaudeEventModelerdiagramshour-booking.drawio -> C:ReposAttrectoClaudeEventModelerdiagramshour-booking.png
C:ReposAttrectoClaudeEventModelerdiagramshour-booking.png. It is ~7760px wide and ~2340px tall,
so inspect it in windows with .

**All six phases are done. The model validates clean.**

Event Model — 19 slice(s), 103 element(s)

   INFO  [completeness/external-terminal] ProjectCreated.projectId enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] ProjectCreated.projectName enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeAssignedToProject.employeeId enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeAssignedToProject.employeeName enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeAssignedToProject.projectId enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeAssignedToProject.projectName enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeAssignedToProject.assignedAt enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/terminal-context] StartBookingMonth.month comes from clock, not from the data flow. Confirm the handler supplies it.
   INFO  [completeness/clock-filled] BookingMonthStarted.startedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/clock-filled] HoursBooked.bookedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/derived-attribute] MyTimesheet.monthStatus is computed from BookingMonthStarted + MonthClosureSubmitted + MonthClosureRejected + MonthClosed, not carried.
   INFO  [completeness/derived-attribute] MyTimesheet.dayTotal is computed from hours, not carried.
   INFO  [completeness/clock-filled] HoursCorrected.correctedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/clock-filled] BookingRemoved.removedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/external-terminal] EmployeeRemovedFromProject.employeeId enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeRemovedFromProject.projectId enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeRemovedFromProject.effectiveFrom enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] EmployeeRemovedFromProject.removedAt enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] WorkingDayPublished.date enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] WorkingDayPublished.month enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/terminal-context] FillZeroHours.bookingId comes from generated, not from the data flow. Confirm the handler supplies it.
   INFO  [completeness/terminal-context] FillZeroHours.hours comes from const, not from the data flow. Confirm the handler supplies it.
   INFO  [completeness/clock-filled] ZeroHoursFilled.filledAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/derived-attribute] MyMonthStatus.monthStatus is computed from BookingMonthStarted + MonthClosureSubmitted + MonthClosureRejected + MonthClosed, not carried.
   INFO  [completeness/derived-attribute] MyMonthStatus.dayTotal is computed from hours, not carried.
   INFO  [completeness/derived-attribute] MyMonthStatus.projectTotals is computed from hours, not carried.
   INFO  [completeness/derived-attribute] MyMonthStatus.missingDays is computed from WorkingDayPublished + HoursBooked, not carried.
   INFO  [completeness/clock-filled] MonthClosureSubmitted.submittedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/external-terminal] AdminSeeded.adminId enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] AdminSeeded.adminName enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/external-terminal] AdminSeeded.seededAt enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.
   INFO  [completeness/clock-filled] AdminsNotified.notifiedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/derived-attribute] AdminEmployeeMonth.monthStatus is computed from BookingMonthStarted + MonthClosureSubmitted + MonthClosureRejected + MonthClosed, not carried.
   INFO  [completeness/derived-attribute] AdminEmployeeMonth.projectTotals is computed from hours, not carried.
   INFO  [completeness/derived-attribute] AdminEmployeeMonth.dayTotals is computed from hours, not carried.
   INFO  [completeness/terminal-context] CompleteMonthClosure.closedBy comes from actor, not from the data flow. Confirm the handler supplies it.
   INFO  [completeness/clock-filled] MonthClosed.closedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/terminal-context] RejectMonthClosure.rejectedBy comes from actor, not from the data flow. Confirm the handler supplies it.
   INFO  [completeness/clock-filled] MonthClosureRejected.rejectedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/terminal-context] CloseMonthDirectly.closedBy comes from actor, not from the data flow. Confirm the handler supplies it.
   INFO  [completeness/clock-filled] MonthClosed.closedAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.
   INFO  [completeness/derived-attribute] OpenMonths.closingDate is computed from month, not carried.
   INFO  [completeness/clock-filled] ClosingReminderSent.sentAt has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.

0 error(s), 0 warning(s), 43 note(s) →
**0 errors, 0 warnings, 43 notes**, across **19 slices / 48 elements / 55 GWTs**.
Grammar 0, completeness 0, slices 0, GWTs 0.

Phases 0–2 and every business rule are the domain expert's words — those cells carry
. **Phases 3–4 (screens, fields) were delegated to Claude**; every
invented cell carries . The expert's framing: *"the entire point here is just building
the tooling, not an actual timesheet product"* — this model is a POC and is throwaway.

## Still wants the expert, before anyone implements

**Seven invented failure cases.** 48 of the 55 GWTs quote the expert. Seven do not, and are marked
 on the cell. They are all idempotence or not-found cases that the model implies but
nobody stated — five are the todo-list tick-off on the three automations, two are
-style guards. Read them before trusting them:

\
**Every slice is still .** Moving one to  is a claim about your process,
not about the model, so nothing was moved automatically.  is the obvious first
candidate: 10 GWTs, no findings of its own, and the per-slice gate would now let it through.

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
