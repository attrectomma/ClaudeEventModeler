# hour-booking — state of the model

Model: [hour-booking.drawio](hour-booking.drawio). Render it and look before doing anything:
`node tools/drawio.mjs render diagrams/hour-booking.drawio`. It is ~7760px wide and ~2340px tall,
so inspect it in windows with `node tools/crop.mjs <file> <x0> <x1> <out>`.

**Phases 0–6 are done and the model validates clean. Step 7 — swimlanes / team boundaries — is
next, and is NOT done.**

`node tools/model.mjs validate diagrams/hour-booking.drawio` →
**0 errors, 0 warnings, 44 notes**, across **19 slices / 49 elements / 55 GWTs**.
Grammar 0, completeness 0, slices 0, GWTs 0.

## Next session starts here

**Step 7 — Define Swimlanes.** The skill's six phases compress Dilger's eight steps, and step 7 is
the one genuinely skipped. It is not lane cosmetics: it is *system and team boundaries*.

> *"Ideally, each Slice should be owned by a single team… What if the UI and backend are owned by
> different teams? … An Event Model often exposes organizational challenges — this is Conway's Law
> in action."* — Understanding EventSourcing, ch. 43

This matters now because front-end team agents and skills are about to be added to the kit.
Nothing in the model currently says which slices are UI work, which are backend, or where one is
split across both. The scaffolding already exists — the slice cell carries `pattern=` and
`status=`, so an `owner=` / `swimlane=` attribute is a small addition with a real check behind it:
a slice owned by two teams should have to say so out loud rather than being discovered during
implementation.

Also queued for discussion, before any code generation:

- **Figma MCP** and what is realistically doable design-wise for the UI. The screens are named
  boxes on purpose (the method says a named box is enough), but `displays=` / `inputs=` are exactly
  the seam a design tool or a front-end agent would attach to.
- **Codegen is explicitly NOT started.** When it does start, the blocker named in CLAUDE.md
  arrives: Wolverine/Marten/Alba move faster than model knowledge, and the local `llms.txt` mirror
  is still unbuilt.

Sequencing suggestion: do step 7 *before* the front-end agents arrive. Team ownership decided on a
model that already exists is a conversation; discovered during implementation it is a rewrite.

Phases 0–2 and every business rule are the domain expert's words — those cells carry
`source="<verbatim quote>"`. **Phases 3–4 (screens, fields) were delegated to Claude**; every
invented cell carries `proposed=`. The expert's framing: *"the entire point here is just building
the tooling, not an actual timesheet product"* — this model is a POC and is throwaway.

## Slice status

`book-hours` is **`status="ready"`** — 10 GWTs, no findings of its own, the pilot for the per-slice
gate. Every other slice is `in-design`. One promoted rather than eleven, so `ready` still means
something.

**The 44 notes are all deliberate**, and each is a claim worth disagreeing with rather than noise:
`external-terminal` (genesis-seeded data), `clock-filled`, `derived-attribute`, `terminal-context`.
A note is the tool saying *"the handler is expected to supply this"* — which is exactly the sort of
claim a reader should be able to reject.

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
   is created by event B, you get a null at runtime and a black arrow on the canvas. Both live
   cases are now fixed — `projectName` was deleted from `MyTimesheet` (the screens read
   `MyProjects` instead) and `employeeName` was moved onto `BookingMonthStarted`, the event that
   creates the row. **The blind spot itself remains**: the tool still cannot tell you which event
   creates a view's rows, so the next one will be just as invisible.
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
