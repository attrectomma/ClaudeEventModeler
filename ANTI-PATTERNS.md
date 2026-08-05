# Event Modeling anti-patterns and smells

A carried-forward catalogue of things that go wrong in an event model, met while building this kit.
The useful column is the last one: **whether anything automatic catches it.** Everything marked *no*
needs a human to notice, which is the whole reason this file exists.

| # | Smell | Caught by |
| --- | --- | --- |
| 1 | [Two events can open one stream](#1) | **no** |
| 2 | [Two streams with identical identity](#2) | **no** |
| 3 | [A view whose grain is undeclared](#3) | partly — only when a projection needs it |
| 4 | [`Event → Processor → Event`](#4) | yes — `grammar/automation-reads-view` |
| 5 | [An "automation" with no view and no condition](#5) | yes — `grammar/automation-needs-view` |
| 6 | [A command that crosses swimlanes](#6) | yes — `swimlane/command-crosses-swimlane` |
| 7 | [A rename that is really a computation](#7) | yes — `completeness/mapping-crosses-types` |
| 8 | [A model too wide to read](#8) | yes — `system/model-too-wide` |
| 9 | [A screen that is a repeated label](#9) | yes — `screen/screen-needs-slug` |
| 10 | [A GWT that is right and useless](#10) | **no** |
| 11 | [A state rule enforced at the periphery](#11) | **no** |
| 12 | [A todo row that never completes](#12) | **no** |
| 13 | [A rule added after the slice was built](#13) | yes — `codegen` reports `GWT WITHOUT A TEST` |
| 14 | [An automation nothing ever runs](#14) | **no** — only starting the app and watching a second sweep |

---

## 1. Two events can open one stream <a id="1"></a>

**Live in `hour-booking`. Not fixed — see why below.**

The `Timesheet` stream is keyed `(employeeId, month)` and can be opened by **either** `HoursBooked`
(the employee books something) **or** `ZeroHoursFilled` (the employee left a project having booked
nothing that month). Two possible first events.

**Why it is a smell.** A stream with one guaranteed opening event has a creation moment you can name,
put invariants on, and attach metadata to. Two openers means there is no such moment — every
consumer has to cope with a stream that might begin in either of two states, and the aggregate can
never assume the month exists. Marten surfaces it directly: it needs a `Create` for the first event,
and if you nominate the wrong one, live aggregation fails at runtime on the other path.

**Three resolutions, and what each costs:**

**(a) Emit a creation event from the existing automation — illegal here.** `start-month` already
opens the month with `BookingMonthStarted`. Having its command also emit a `TimesheetOpened` breaks
the little book's rule from ch. 11, enforced as an error: *"A single command should never interact
with multiple swimlanes or aggregates. The moment you do this, you introduce the need for a
transactional boundary."*

**(b) A second automation that opens the stream — the right answer, and a modelling task.**
`BookingMonthStarted → a todo View of months with no timesheet → an automation → OpenTimesheet →
TimesheetOpened`. Structurally clean and it is the standard shape. It requires **inventing five
domain facts** — an event name and its fields, a command, a todo view and its fields, plus the GWTs —
so it is a session with the domain expert, not a refactor. **Do this when the expert is available.**

**(c) Merge the two streams — tempting, and it unwinds something better.** `Timesheet` and
`MonthClosure` are keyed identically (see #2), and merged they would read as one compelling narrative
*and* make "a closed month cannot be booked into" a true in-aggregate invariant instead of needing a
cross-stream `[ReadAggregate]`. But `Timesheet` lives in the `booking` context and `MonthClosure` in
`month-closure`, so one stream would be **written by two contexts** — which breaks *"only an event
crosses a model boundary"* far more seriously than the original smell. Fixing #1 this way would
unwind the multi-model split.

**What was done instead.** No `Create` method at all: a no-arg constructor lets any event open the
stream. Marten's own docs recommend exactly this — *"probably safest to have an empty, default
constructor unless you can guarantee that a certain event type will always be first in the event
stream."* It is correct and it is a workaround; the creation moment still does not exist.

**Worth knowing:** "the first event drawn in the swimlane opens the stream" is a good rule that holds
for 3 of the 4 bands here (`MonthClosure` is genuinely always opened by `BookingMonthStarted`, and the
two single-event streams trivially). It is a useful default, not a safe dependency.

## 2. Two streams with identical identity <a id="2"></a>

`Timesheet` and `MonthClosure` are both keyed `(employeeId, month)`. Two streams whose identity is
the same are usually one stream, because identity is what a stream *is*.

Here it is a consequence of the context split rather than a modelling error: the two contexts are
genuinely separate readable stories, and the price of that is a shared key. But it is worth noticing,
because it is also what makes #1 unfixable by merging, and what forces the closed-month rule to read
across streams.

**The tooling cannot see this** — `identity=` is declared per band, and nothing compares bands across
models. A rule for it would be cheap and is not written.

## 3. A view whose grain is undeclared <a id="3"></a>

A read model's `fields=` say what a row holds and never what a **row is**. `MyTimesheet` is per
booking; `MyProjects` is per (employee, project); `OpenMonths` is per (employee, month). Nothing said
so until a projection needed to group events, at which point Marten rejected the projection at
startup with *"no defined event slicing rules"* — and because that is a startup failure it took the
whole host down and turned 55 individually-failing tests into 55 identical fixture errors.

`identity=` on the read model fixes it. In `hour-booking` **1 of 10 views declares it**; the other
nine fall back to the system key, which the generated projection marks as `GUESSED`. That fallback is
right for the month-scoped views and wrong for at least `MyTimesheet`, `Admins`, `WorkingDays` and
`MonthStartTodo`.

## 4. `Event → Processor → Event` <a id="4"></a>

The classic. An automation is a **Trigger**, a peer of a person at a screen: it *looks at a View* and
*issues a Command*. It never receives an event and never emits one. The View it watches is a **todo
list** — the event puts a row on it, the automation works the row, the resulting event ticks it off.
Skip the view and you lose both the record of pending work and the thing stopping the processor from
working the same row twice.

## 5. An "automation" with no view and no condition <a id="5"></a>

Per the cheat sheet: if there is no view and no conditional logic, it is not an automation at all —
it is just a command that emits several events. Drawing a gear on it adds a moving part and explains
nothing.

## 6. A command that crosses swimlanes <a id="6"></a>

*"Two effects that must happen atomically are not two aggregates — they are one."* An error, not a
warning, because the alternative is a distributed transaction dressed up as a design.

## 7. A rename that is really a computation <a id="7"></a>

`mappings="dayTotal=hours"` claims `dayTotal` **is** `hours`; it is really their sum.
`mappings="month=date"` claims a `string` is a `DateOnly`. Both pass a name match, both are lies a
generator acts on. Use `derived=` for a computation and `terminal=` for something arriving from
context. Only a type mismatch is detectable — a same-typed lie still passes.

## 8. A model too wide to read <a id="8"></a>

*"I aim to capture one business context in each model, so I can read it from left to right without
any visual interruptions."* If you reach for `crop.mjs` to look at a model, it is too big. The
7760px original became three models of 1940–2960px.

## 9. A screen that is a repeated label <a id="9"></a>

`Timesheet` was three cells with `displays=` hand-copied between them and nothing comparing the
copies — the same bug the slice cell fixed for slices. A slug plus one asymmetric rule (`displays=`
must agree, `inputs=` may differ) makes it one screen with three affordances.

## 10. A GWT that is right and useless <a id="10"></a>

`slice-needs-gwt` fires on an empty slice, but a slice with one GWT and nine unwritten rules looks
identical to a complete one. *"Don't save on GWTs"* is advice no checker can enforce. Ask for the
failure cases explicitly, every time.

## 11. A state rule enforced at the periphery <a id="11"></a>

A rule needing accumulated state, put in a validator that cannot see the stream, is a rule that
silently does not hold. "At most 18 hours in a day" checked against an eventually-consistent
projection lets two concurrent bookings both pass.

`enforce=` on the GWT declares where a rule lives, defaulting to `aggregate` because that is the safe
direction. **It cannot be derived**: the obvious heuristic — "no `given=` means the request alone
settles it" — found zero of four real periphery rules in `hour-booking`, because almost every GWT
carries a *context* `given=` like *"the month is open"*.

## 12. A todo row that never completes <a id="12"></a>

An automation's View is a todo list: an event puts a row on it, the automation works the row, the
resulting event ticks it off. The model says all of that — but it never says **what a finished row
looks like**.

`ZeroFillTodo` is one row per (employee, project) still to be zero-filled *to month end*. Deciding a
row is done needs the calendar, and a projection cannot query another view. So rows accumulate: the
work stops happening — each remaining day is refused as already filled — but the row stays pending
forever.

**Resolved for `hour-booking` by asking**, and the answer was not a projection rule at all: a row is
completed by a **person**. `ZeroFillTodo → an admin screen → FinishAdminTodo → AdminFinishedTodo`,
which is an ordinary Command slice, and the tick-off is that event. Worth recording as the general
shape: when "is this row done?" needs judgement or data the projection cannot reach, completion is a
command somebody issues, not a condition somebody computes. The automation and the completion are
**two slices**, and only the second one closes the loop.

Two smaller versions of the same gap, both found on the first automation slice and both still open:

- **A todo view needs state the model does not list.** `fields=` gives what a reader sees; the tick-off
  needs bookkeeping — which days are done, whether the row is still pending — which is the pattern's
  machinery and is invisible on the canvas.
- **`terminal="...:const"` carries no value.** The grammar can say a value arrives as a constant and
  cannot say *which* constant. Here the event's own `source=` supplied it ("0 hours booked per day"),
  which is luck rather than design.

Nothing automatic catches any of this, because every attribute rule passes.

## 13. A rule added after the slice was built <a id="13"></a>

The gate the whole kit rests on is *"the slice's tests are live, not skipped."* A GWT added to a slice
that is **already implemented** passes that gate while having no test at all — because the test file is
`scaffold`: written once, then hand-owned, and regeneration deliberately keeps it. Nothing fails,
nothing is skipped, and the run is green.

This is the ordinary case, not an edge one: it is what happens every time the domain expert answers an
open question about a slice that is already green. Two rules arrived in `fill-zero-hours` exactly that
way.

Now caught. Every generated test carries its rule text as a comment, so `codegen` compares the model's
GWTs against a kept test file and prints `GWT WITHOUT A TEST` with the rules that are missing. It
**reports rather than repairs** — appending into a file somebody else owns is how a generator destroys
hand-written work.

The general lesson is about the `emit` / `scaffold` split itself: a file that is written once and then
owned can go stale against the model silently, and every such file needs its own staleness check.
Tests were the first; they are unlikely to be the last.

## 14. An automation nothing ever runs <a id="14"></a>

The Automation pattern says `Event(s) → View → Trigger → Command → Event(s)` and says nothing about what
wakes the trigger — correctly, because that is transport. The trap is that "automatic" is the entire
claim of the pattern, and **nothing in the grammar, the checker or the test suite notices when it is
false.** `fill-zero-hours` passed six GWTs while the only thing that could ever run it was a human with
`curl`.

**Why a green suite cannot see it.** If the trigger is an HTTP endpoint, the *test seam and the
production mechanism are the same thing*. The tests drive the only caller that exists, so they prove the
sweep works and say nothing about whether anything calls it. Make the trigger a message handler and the
question becomes askable: who sends the message?

Two further versions of the same failure, both found by running the app rather than reading it, and
neither caught by any test:

- **A trigger that returns its report.** Wolverine's rule is *"by returning another type, Wolverine
  treats the return value as a cascaded message to publish"*, and there is no opt-out attribute. Driven
  fire-and-forget there is no requester, so the returned report became an unroutable message —
  `No routes can be determined for Envelope (ZeroFillRun)` — and that failure took the whole outgoing
  batch with it. A fire-and-forget trigger must not return a message-shaped value.
- **A sweep that logs only when it does something.** Then "alive with nothing to do" and "dead" produce
  byte-identical output. Log every sweep.

### The heartbeat is only a clock

The obvious design for a periodic automation is a durable self-rescheduling message: the trigger's
handler schedules its own successor, so the beat survives a restart. **It does not work on this stack**,
and it fails silently. Six attempts, every one with logging that proved the message had been created:

| Attempt | Result |
| --- | --- |
| `bus.ScheduleAsync` inside the handler | no row, no error, one sweep ever |
| `return DeliveryMessage<T>` via `DelayedFor` | "Successfully processed", value dropped |
| `return OutgoingMessages` + `.Delay(...)` | the documented idiom; also dropped |
| schedule from a fresh DI scope | also dropped |
| schedule *before* the sweep, not after | also dropped |
| Wolverine debug logging | `marked as Scheduled` → `scheduled with durable sender … relying on durable inbox scheduling` → `Enqueued for sending` → **nothing** |

The invariant: scheduling from **outside** a message context always persists; scheduling from **inside** a
durable local-queue handler never does. Not a polling delay — `ScheduledJobPollingTime` defaults to 5s and
every node polls the main store from startup.

**The resolution was to stop needing it.** A periodic sweep does not need a durable scheduled message at
all, because *the work is not carried in the message* — it is recomputed from the todo View every time.
The `Pending` rows **are** the durable queue, and they are built from the event store. Kill the process
mid-sweep and the next start reads the same rows and carries on. Durable scheduling earns its keep for
deferred **one-shot** work ("remind me in three days"), where losing the message loses the intent; here
the intent is already in Postgres. So the heartbeat only has to be a clock, and a loop is a clock.

That also removed a limitation the message version had: one loop per process instead of a chain per
startup accumulating across restarts.

**A timer is safe *because* it is absent in tests.** The danger was never the timer, it was a timer in the
*test host*: a sweep firing mid-test appends events into streams other slices assert on, and every GIVEN
becomes a race. `AppFixture` sets `Automation:Heartbeat=false`; tests send the same sweep message to the
same handler, so the production path stays tested and only the clock is missing — and a clock is the one
part of an automation a test must control rather than observe.

What a test *can* assert is that **repeated sweeping is safe**, which is what makes the interval a free
choice. Correctness must not depend on how often the clock ticks.

**A related trap in the demo seed, same shape.** `GenesisData.Populate` is idempotent via
`if (MyProjects.Any()) return;`. Add new genesis data later — a calendar, say — and it never lands on an
existing demo database, because the guard fired on the *old* data. The zero-fill demo looked broken for
exactly this reason: no `WorkingDayPublished` events, so nothing to fill, so silence. `docker compose
down -v` fixes it, and the general point is #13's again: anything written once and then guarded needs a
reason to be reconciled.
