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
| 15 | [A view keyed on a time bucket the events do not carry](#15) | **no** |
| 16 | [A screen state that only a click can reach](#16) | now — `ui-journey`, if somebody runs it |

---

## 1. Two events can open one stream <a id="1"></a>

A stream keyed `(subject, period)` where **either** of two events can be the first one — in the worked
case, one written when the subject acted and one written when the system filled in for them, and neither
guaranteed to come first.

**Why it is a smell.** A stream with one guaranteed opening event has a creation moment you can name,
put invariants on, and attach metadata to. Two openers means there is no such moment — every
consumer has to cope with a stream that might begin in either of two states, and the aggregate can
never assume the period exists. Marten surfaces it directly: it needs a `Create` for the first event,
and if you nominate the wrong one, live aggregation fails at runtime on the other path.

**Three resolutions, and what each costs:**

**(a) Emit a creation event from an existing command — usually illegal.** If some other slice already
opens a *neighbouring* stream, having its command also emit the creation event for this one breaks the
little book's rule from ch. 11, enforced here as an error: *"A single command should never interact
with multiple swimlanes or aggregates. The moment you do this, you introduce the need for a
transactional boundary."*

**(b) A dedicated automation that opens the stream — the right answer, and a modelling task.**
`<upstream event> → a todo View of subjects with no stream → an automation → Open… → …Opened`.
Structurally clean and it is the standard shape. It requires **inventing five domain facts** — an event
name and its fields, a command, a todo view and its fields, plus the GWTs — so it is a session with the
domain expert, not a refactor.

**(c) Merge the two streams — tempting, and it can unwind something better.** Where two streams are
keyed identically (see #2), merging them would read as one narrative *and* turn a cross-stream check into
a true in-aggregate invariant. But if the two live in **different contexts**, one stream would then be
written by two contexts — which breaks *"only an event crosses a model boundary"* far more seriously than
the original smell, and unwinds the multi-model split.

**What was done instead.** No `Create` method at all: a no-arg constructor lets any event open the
stream. Marten's own docs recommend exactly this — *"probably safest to have an empty, default
constructor unless you can guarantee that a certain event type will always be first in the event
stream."* It is correct and it is a workaround; the creation moment still does not exist.

**Worth knowing:** "the first event drawn in the swimlane opens the stream" is a good default that held
for 3 of 4 bands in the worked model — the exception being exactly the band above. A useful default, not
a safe dependency.

## 2. Two streams with identical identity <a id="2"></a>

Two streams both keyed `(subject, period)`. Two streams whose identity is
the same are usually one stream, because identity is what a stream *is*.

It can be a consequence of a context split rather than a modelling error: two contexts are genuinely
separate readable stories, and the price of that is a shared key. But it is worth noticing, because it is
also what makes #1 unfixable by merging, and what forces a rule about one stream's state to be read
across from the other.

**The tooling cannot see this** — `identity=` is declared per band, and nothing compares bands across
models. A rule for it would be cheap and is not written.

## 3. A view whose grain is undeclared <a id="3"></a>

A read model's `fields=` say what a row holds and never what a **row is**. One view is per line item,
another per (subject, category), a third per (subject, period) — and nothing says so until a projection
needs to group events, at which point Marten rejects the projection at startup with *"no defined event
slicing rules"*. Because that is a *startup* failure it takes the whole host down, which turned 55
individually-failing tests into 55 identical fixture errors.

`identity=` on the read model fixes it. In the worked model **1 of 10 views declared it**; the other nine
fell back to the system key, which the generated projection stamps `GUESSED`. That fallback was right for
the period-scoped views and wrong for four of the rest — silently, because every attribute rule passes
either way.

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
worked model started at 7760px and became three of 1940–2960px.

## 9. A screen that is a repeated label <a id="9"></a>

One screen was three separate cells with `displays=` hand-copied between them and nothing comparing the
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
settles it" — found zero of four real periphery rules in the worked model, because almost every GWT
carries a *context* `given=` like *"the period is still open"*.

## 12. A todo row that never completes <a id="12"></a>

An automation's View is a todo list: an event puts a row on it, the automation works the row, the
resulting event ticks it off. The model says all of that — but it never says **what a finished row
looks like**.

In the worked case a row was "one (subject, category) still to be filled in to period end". Deciding
whether a row is *done* needed a second view — the calendar of eligible days — and **a projection cannot
query another view**. So rows accumulated: the work stopped happening, because each remaining item was
refused as already done, but the row stayed pending forever.

**Resolved by asking**, and the answer was not a projection rule at all: a row is completed by a
**person**. `<todo view> → an admin screen → Finish… → …Finished`, which is an ordinary Command slice,
and the completion is that event. Worth recording as the general
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
false.** One slice passed six GWTs while the only thing that could ever run it was a human with `curl`.

**There is more than one right implementation, and choosing by habit is its own version of this bug.**
Event forwarding, a Marten subscription, projection `RaiseSideEffects` (async-only by default, Inline via
`EnableSideEffectsOnInlineProjections`) and a clock-driven sweep are all
valid; which is correct depends on whether the trigger event is ours, whether ordering matters, and
whether the trigger is an event at all rather than the passage of time. The kit briefly asserted that a
sweep was the only correct answer — generalised from a single model whose automations were all
foreign- or time-triggered, which is a property of that model, not of the pattern. **A sample of one
model is not a pattern.** The decision table lives in CLAUDE.md; what belongs here is that no tool can
check it, so the slice has to say which choice it made and why.

**Why a green suite cannot see it.** If the trigger is an HTTP endpoint, the *test seam and the
production mechanism are the same thing*. The tests drive the only caller that exists, so they prove the
sweep works and say nothing about whether anything calls it. Make the trigger a message handler and the
question becomes askable: who sends the message?

Two further versions of the same failure, both found by running the app rather than reading it, and
neither caught by any test:

- **A trigger that returns its report.** Wolverine's rule is *"by returning another type, Wolverine
  treats the return value as a cascaded message to publish"*, and there is no opt-out attribute. Driven
  fire-and-forget there is no requester, so the returned report became an unroutable message —
  `No routes can be determined for Envelope (<the report type>)` — and that failure took the whole outgoing
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

**A related trap in the demo seed, same shape.** Development seed data (Marten `IInitialData`) must be
idempotent, because `Populate` runs on every startup — so it is usually guarded with "if any row of view X
exists, return". Add *new* seed data later and it never lands on an existing demo database, because the
guard fires on the *old* data. An automation demo looked broken for exactly this reason: the events it
selects work from were never seeded, so there was nothing to do, so silence. `docker compose down -v`
fixes it; the general point is #13's again — anything written once and then guarded needs a reason to be
reconciled.

---

## 15. A view keyed on a time bucket the events do not carry <a id="15"></a>

A read model whose grain is "per sender per month", "per account per day", "per campaign per week" — where
the period is **not a field of any event feeding it**. Marten makes this easy: `Identity<IEvent<T>>` reaches
the envelope, and `e.Timestamp` gives you a month.

**Why it is a smell.** `IEvent.Timestamp` is stamped when the event is **appended**, and it ignores the
payload entirely. So the view answers *"appended in month M"* while every reader will assume *"happened in
month M"*. The two agree exactly as long as nothing is ever backfilled, imported, corrected late, or
replayed into a fresh store — and the day one of those happens, a report silently moves rows into the wrong
period. It cannot be spotted from the outside: the row exists, the count is a plausible number, and the
tests pass, because a test written the same day appends and asserts within the same month.

Found by running the app rather than by any test: seed data carrying `queuedAt = 2026-01-15` produced a row
keyed `2026-08`. See `reference-implementations/state-view/`, finding #1.

**The fix is almost always to use the payload.** If the events carry a business timestamp — and a model that
declares `queuedAt` does — key on `e.Data.QueuedAt` and the envelope is not needed at all. Metadata keying is
right only when the question genuinely is about the write, such as an ingest-throughput report.

**What the model can do about it.** `identity=` on the read model is where the grain is declared, and a name
in it that no feeding event supplies is exactly this situation. The kit already records it as
`derived="month=<Event>"` — "computed from that event" — which is true and too weak to distinguish *which*
of the event's two clocks was meant. Stating the intended source in the cell's `note=` costs nothing and is
the only place a reader can find out.

**Caught by:** *no*. `derived=` accepts it, the generator emits it, the projection compiles, the suite is
green. Only a backfill, or someone reading the note, reveals it.

---

## 16. A screen state that only a click can reach <a id="16"></a>

A page 2, a sort order, an open modal, a rejected form, an in-flight button. Every check the kit had over the
UI looked at **one screen at rest**: `model.mjs` holds `displays=` to the wireframe, `design.mjs check` holds
both to the React port, `review.mjs` puts the built screen beside the design. All three are useful and none
of them can press a button.

**Why it is a smell rather than a gap in tooling.** The states you cannot reach without clicking are exactly
the states where the app's *behaviour* lives, so a screen whose interesting states are all click-only has all
of its risk in the one place nothing was looking. Three measured consequences, and every one survived a green
suite:

- **The pager never reached the URL.** Shots of `/` and `/?page=2` came back **identical**, so a page could not
  be linked, bookmarked or refreshed. 32 tests green, no design page could have shown it.
- **An empty screen and a broken one were byte-identical.** A wrong nginx `proxy_pass` prefix makes the API
  answer 404, and a 404 body is not a paged result — so the list renders empty with no error. A missing
  `ASPNETCORE_ENVIRONMENT` that leaves the seed unapplied looks exactly the same.
- **A state was silently not being rendered at all**, and its screenshot was taken anyway. The shot looked
  fine, of the wrong thing. Hence the rule that followed: **a screenshot is evidence for a human and never for
  the suite — assert first, then shoot.**

**Now caught, conditionally.** `ui-journey` walks the workflow in a real browser and reports a spec that fakes
its backend, skips its navigation, or names a selector the model does not declare. The condition matters and is
the honest part of this entry: **nothing schedules it and nothing gates on it.** It starts containers and costs
minutes, so `codegen` prints `NO UI JOURNEY` once two claimed slices have screens and stops there. A smell whose
detector is opt-in is still a smell — and the sub-smell to watch for is a `frontend-agent` report that lists
click-only states as unverified and treats *"a journey could cover this"* as though it had.
