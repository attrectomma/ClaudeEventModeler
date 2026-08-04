# hour-booking — where the session stopped

Model: [hour-booking.drawio](hour-booking.drawio). Render it and look before doing anything:
`node tools/drawio.mjs render diagrams/hour-booking.drawio`. It is ~7760px wide, so inspect it in
windows with `node tools/crop.mjs <file> <x0> <x1> <out>`.

**Phases 0–4 are done and confirmed. Phase 5 still FAILS, but every remaining error is a tooling
decision — there are no open domain questions.** Phase 6 (GWTs) has not started.

`node tools/model.mjs validate diagrams/hour-booking.drawio` →
**11 errors, 11 warnings, 27 notes**, across **19 slices / 48 elements**.
Grammar is clean: **0 violations**, all four patterns legal.

Phases 0–2 are the domain expert's words — those cells carry `source="<verbatim quote>"`.
**Phases 3–4 (screens, fields) were delegated to Claude**; every invented cell carries
`proposed="claude — invented layout/UI/fields, NOT stated by the domain expert"`. The expert's
stated framing: *"the entire point here is just building the tooling, not an actual timesheet
product"* — this model is a POC and is throwaway. Judge `proposed=` cells harder.

## Domain questions — all four answered, all four applied

1. **Admins** → seeded with a genesis event. `AdminSeeded` (`em="external"`, because it is
   authored at deployment, outside any slice) feeds an `Admins` view, which the `AdminNotifier`
   automation reads as a second view. `NotifyAdmins`/`AdminsNotified` now carry `adminId`, so
   "notify the admins" finally has a recipient list. *"All admins can see everything"* is
   authorization — that belongs in a GWT, not a data-supply edge, and is Phase 6 work.
2. **Who gets reminded** → a new `start-month` automation. `MonthStartTodo` (from
   `EmployeeAssignedToProject`) → `MonthStarter` → `StartBookingMonth` → **`BookingMonthStarted`**.
   This fixed three things at once, not just the reminder:
   - `OpenMonths` rows now come from the month starting, not from booking activity, so an
     employee who booked **nothing** is still reminded — precisely the person the reminder is for.
   - `month` is no longer derived from a booking's `date`, so the `month=date` mapping is gone.
     That was a real bug: an employee with zero bookings could not submit a closure at all.
   - `monthStatus` no longer needs an *absence* to mean "Open" — Open now has an event behind it.
     It is still a fold, but every state in the fold is now reachable from a real event.
3. **Working calendar** → `WorkingDayPublished` (`em="external"`, one event per working day, from
   a Hungarian Google calendar carrying public holidays and working Saturdays) feeds a
   `WorkingDays` view. `ZeroFillProcessor` reads it as a second view, which resolves the day
   expansion **and** breaks the circular sourcing — `FillZeroHours.date` now comes from the
   calendar rather than from the zero-fill's own output.
4. **Upstream contract** → the expert confirmed a real `EmployeeAssignedToProject` would likely
   carry only `employeeId` and `projectId`, and that **simplifying freely is fine for a POC**.
   `employeeName`/`projectName` stay, and `completeness/external-terminal` notes keep the
   simplification visible rather than silent.

## The only thing still blocking the gate: two tooling rulings

No domain input needed. All 11 errors are here.

**A. `derived=` — a fold/aggregate vocabulary distinct from `mappings=` (5 errors)**

`mappings=` is a **rename**: the checker substitutes one name for another and looks it up
(`const wanted = e.mappings[f.name] ?? f.name`). It is currently being used as a silencer for
things that are not renames, and a generator reading the IR would emit an assignment where a
computation belongs:

| Still red | What it actually is |
| --- | --- |
| `MyTimesheet.monthStatus`, `MyMonthStatus.monthStatus`, `AdminEmployeeMonth.monthStatus` | a fold over which closure events occurred |
| `MyMonthStatus.missingDays` | a count: working days minus booked days |
| `OpenMonths.closingDate` | a calendar fact — last day of `month` |

| Currently passing, but the same lie | |
| --- | --- |
| `MyTimesheet.dayTotal=hours`, `MyMonthStatus.dayTotal=hours`, `projectTotals=hours`, `AdminEmployeeMonth.projectTotals=hours`, `dayTotals=hours` | SUMs, not renames |
| `OpenMonths.lastRemindedAt=sentAt` | **a genuine rename. Keep as `mappings=`.** |

Proposed: `derived="monthStatus=fold(BookingMonthStarted->Open, MonthClosureSubmitted->Submitted,
MonthClosureRejected->Open, MonthClosed->Closed)"`, checkable the way GWTs are — every event named
must exist and must be an upstream source of that view. That is referential integrity, not a
silencer. Cheap partial win available today: warn when a mapping crosses declared types
(`missingDays:int <- date:DateOnly` would have fired).

**B. `actor=` / generated-terminal (6 errors)**

| Still red | What it actually is |
| --- | --- |
| `CompleteMonthClosure.closedBy`, `CloseMonthDirectly.closedBy`, `RejectMonthClosure.rejectedBy` | the authenticated principal — ambient, like the clock |
| `FillZeroHours.bookingId` | generated per zero-fill |
| `FillZeroHours.hours` | the constant `0` |
| `StartBookingMonth.month` | the clock, at month rollover |

Proposed: an `actor=` marker treated as terminal the way `inputs=` is, rather than a name-based
`*By` exemption, which would misfire. **Decide `employeeId` at the same time**: it is exactly the
same kind of ambient fact but is laundered through `displays=` on the Timesheet screens, so the
checker currently *rewards* the dishonest treatment and *punishes* the honest one.

## Known-unsound, left standing deliberately

- `cmd-book-hours.bookingId` **passes for the wrong reason.** Sourced from the Timesheet's
  `displays=`, where `bookingId` means *the row I am looking at* — but booking new hours needs a
  *new* id. Same name, opposite meaning. `cmd-correct-hours`/`cmd-remove-booking` are correct:
  they take it from `inputs=` (the user picked a row). Same class as ruling B.

## Fixed: the Phase 6 blocker

**Duplicate labels no longer break the GWT checker.**  used a label -> element map,
last write wins, so // silently resolved to whichever same-named cell sat
later in the file. The three fields now resolve at their own scopes —  slice-only, slice-first-then-global,  global. Scoping  to the slice, which was the obvious fix,
would have broken every honest GWT, since a given= almost always names an event from an earlier
slice. Regression-tested against the real shape: two cells sharing a label, the duplicate later in
the file.

**Slices are now first-class.** Each has a slice cell ( +  +  +
) drawn as a contiguous band. The columns were reordered so every slice is contiguous —
,  and  previously had gaps in the middle of them. See
CLAUDE.md for the vocabulary and the per-slice gate.

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
   sourced from its own output (now fixed by giving the automation the `WorkingDays` view).
6. **Nullability against slice context.** `submittedAt` is well-formed and correctly sourced, and
   always absent on the one slice that displays it. Now `DateTimeOffset?`.
7. **Roles and authorization** have no representation in the grammar — `AdminSeeded` supplies the
   *data*, but nothing enforces *"any admin can"*. That is Phase 6.

## Phase 6 has not started

Zero `gwt` cells across 18 slices. Every rule the expert stated lives in `note=`/`source=` prose,
where nothing can test it — whole/half hours never 0, any date in the *open* month, corrections
carry the absolute value, "you cannot correct to 0", "closed is closed", rejection sends them back
to editing, the reminder repeats every 3 days, zero-fill covers working days only, all admins see
everything. Each implies a rejection (`then="error: ..."`) and not one exists. Against CLAUDE.md's
*"Ten or more per slice is normal"*, an actual count of zero is the largest single distance
between this model and implementable.
