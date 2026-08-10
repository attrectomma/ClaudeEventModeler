# Kit findings — what is still open

**This file is the to-do list. It is meant to stay short.** Everything already fixed is in
[KIT-HISTORY.md](KIT-HISTORY.md) — the lab notebook, one section per run, kept because in this kit the
*reasoning* is the artifact and most findings are of the form *"this compiled, passed, and was wrong."*

Nothing here is scheduled. The kit is used by picking one of these up.

**Finding IDs are stable and never reused.** Code and skills cite them as *"KIT-FINDINGS AD11"* from about
twenty places; an ID lives in whichever of the two files matches its status, so the citation resolves with:

```
grep -n "AD11" KIT-FINDINGS.md KIT-HISTORY.md
```

An ID that moves from here to the archive has been fixed — that is the only direction it ever travels.

| | |
| --- | --- |
| **BROKEN** | produces wrong output today |
| **GAP** | a capability that does not exist |
| **NOISE** | a false positive, or cosmetic |
| **OPEN** | a question nobody has answered |

---

## 1. Wrong output, silently — fix these first

These pass every check the kit has. That is what makes them the top of the list.

### V10 — the completeness check cannot tell a SUPPLY edge from a TICK-OFF edge, so a todo View can be "sourced" by its own output · **BROKEN**

**A todo View passed the completeness check while being fed, for two of its fields, by the automation's own
completion event.** `SessionsToPrice` declares `driverId` and `pricePerKwh`. Its drawn feeds were
`Charging Stopped` — which carries **neither** — and `Session Priced`, which carries both and *is the event
the automation appends when it finishes the row*. The check is name-based, both names resolved, zero errors.

**A row fed only by its own completion could never be built in the first place.** The automation cannot issue
its command without `driverId`, so it can never emit `Session Priced`, so the field is never supplied — a
circular source the check reads as a satisfied one. Found by the implementing agent, which needed the value
and discovered nothing supplies it; confirmed on the model, where `Charging Started` (carrying both) had no
edge at all. Fixed in Voltway by drawing the missing edge.

**The notation to fix it with is already on the canvas.** Dilger draws the tick-off edge dashed — *"to
indicate that this is not part of the Flow but just updating the data of the Read Model"* — and CLAUDE.md
records that convention as understood but **not adopted**. Voltway's `Session Priced → SessionsToPrice` edge
is *already drawn dashed grey*, by eye, carrying no meaning. Adopting it as notation turns a cosmetic reader
aid into the check: **an edge marked as a tick-off supplies nothing**, and a field whose only source is one
is unsourced.

That upgrades the earlier judgement. The kit had filed the dashed line under "cosmetic, and a real reader aid
on a busy automation slice"; it is the missing half of the completeness check on every automation and
translation slice in the kit, which is the pattern family where the source of a field is hardest to see.

**Suspect every automation and translation slice already built**, not just this one — the check has never been
able to see the difference, so nothing that passed proves anything here.

### V13 — `GWT WITHOUT A TEST` matches by RULE NAME, so a new scenario for an existing rule is invisible · **BROKEN**

Two GWTs legitimately share a rule name — the same refusal reached by two different histories — and the kit
already depends on that elsewhere: deduping the generated rejection constants **by rule name** was the fix
for a CS0102 collision. But the coverage report matches the model's rules against the kept test file **by
that same name**, so once one scenario for a rule has a test, **every later scenario for it reports as
covered**.

Measured: `gwt-cj-5` was added to Voltway — a genuinely new scenario, and the one the whole `withdrawnBy`
change exists to make expressible — under the existing rule name `ManuallyWithdrawnBayStaysOut`. `codegen`
reported nothing. The scenario has no test and the report says the slice is fully covered.

**This is the same class as the report it sits next to and worse in one way:** `TESTS STILL SKIPPED ON A
CLAIMED SLICE` at least fires on a state the model can see. Here the model *grew* and the report went quiet.
The fix is to match on the GWT's **cell id** as well as its rule name — the id is already stable and unique
by construction, and it is what every other report in the kit names when it points at a cell.

Until it is fixed: **after adding a GWT to an implemented slice, check whether its rule name is already
used** before trusting a silent run.

### V14 — a stray `Voltway.exe` makes MSBuild fail at the COPY step, hiding every real compile error behind it · **ENVIRONMENTAL, worth knowing**

An agent that runs the app to prove an automation fires must stop it. One did not, and the leftover host held
`bin/Debug/net10.0/<System>.exe`. Every subsequent build then failed with `MSB3021`/`MSB3027` — *"the process
cannot access the file… locked by: Voltway (4664)"* — **after compiling the app project and before compiling
the tests**. So a genuine 20-error ripple in the test project reported as **2 errors**, both about copying a
file, and the summary line said `2 Error(s)` where the truth was 22.

The tell is `MSB3021` / `MSB3027` / `MSB3026` rather than a `CS` code. `Get-Process -Name <System>` then
`Stop-Process -Force`, and rebuild before believing any error count. Related to the standing rule that a build
in a shared tree is not a measurement — this is the single-agent version of it.

### V12 — the emitted retry budget is a system-wide ceiling on concurrent writers, and nobody has decided it · **BROKEN**

`Program.cs` emits `opts.OnException<...>().RetryTimes(3)` — **four attempts in total**. On a contended stream
each round lets exactly **one** writer commit, so the budget is not a margin, it is a hard limit on how many
callers may append to one stream at the same instant. Probed against a real suite:

```
writers=2 landed=2   writers=3 landed=3   writers=4 landed=4
writers=5 landed=4   writers=6 landed=4   writers=8 landed=6
```

**Above four simultaneous appends to one stream, work is silently lost as a 500.** Deterministic, not flaky.

**The damage is worst where the slice has no contended rule at all**, which is the opposite of where anyone
would look. `report-fault` has no rejection that depends on accumulated state — `architect.mjs` correctly
scaffolded no race file for it — but its stream is the Bay stream, **shared with the charging context**, so a
fault report races a hold, a charge start, a pricing and auto-withdraw. What a lost race costs there is not a
duplicate: it is *a real fault report the duty manager believes they filed*, on a bay that auto-withdraw takes
out of service at two open faults.

So the number is not a Wolverine tuning detail. It is a **system-scoped consistency decision** — how many
concurrent writers a stream must tolerate before a caller is told to try again — and it belongs in
`ARCHITECTURE.md` beside the rest of them. `architect.mjs` does not derive the question, and
`contended-invariant` currently says only *"the stream key contains the contested thing"*, which is true and
insufficient: it establishes that the loser is refused **correctly**, not that the loser is refused a
**survivable** number of times.

`Program.cs` is `emit`, so this cannot be fixed by hand in a project — it is the generator's, and the fix is
a cooldown (`RetryWithCooldown`) rather than a larger integer, since the failure mode is a thundering herd on
one row.

### V11 — the scaffolded race test RE-STAGES the mechanism instead of calling it, so it is blind to every mutation inside it · **BROKEN**

`architect.mjs tests` scaffolds a deterministic race test that opens two sessions and stages the append
**itself** — `session.Events.StartStream(claim, …)` — rather than invoking the slice's own guard. So it
proves *"`StartStream` collides"*, which is a fact about Marten, and proves **nothing about the code that
ships**.

Measured on `commission-bay`: mutant M5 replaced the claim's `StartStream` with `Append`, turning the guard
into no guard, and the scaffolded `ExactlyOneWriterWins` **stayed green**, as did all six sequential GWTs.
The only thing left standing between that and a broken invariant was an HTTP race, which the database may
serialise anyway.

**And it reaches backwards into a slice already called done.** `register-driver` has the same shape —
verified, not inferred: its race test stages `session.Events.StartStream(claim, …)` directly and never calls
`RegisterDriverMechanism`. Both of its uniqueness guards are therefore unpinned by the test written to pin
them.

The fix has been demonstrated: the implementing agent added `ExactlyOneMechanismCallerWins`, which drives
`CommissionBayMechanism.CommissionAsync` and uses the mechanism's own `afterRead` seam as the barrier, and
it fails against M5. **The scaffold should call the slice's guard through a seam, not reproduce it** — which
means the generator needs the mechanism to expose one, and that is the part not yet designed.

**PARTLY MITIGATED, and the mitigation names where the fault actually was: the INSTRUCTION.** The scaffold
said *"the same race with the guard in place"* and handed over a
`RaceAsync(n, (i, session) => { read, check, stage })` example — which reads as *copy what the mechanism
does into the callback*, and two slices did exactly that. `architect.mjs` now tells the implementer to call
the slice's own path, to **add a seam** to the mechanism if there is nowhere to put the barrier, and gives
the check that the test is real: *break the guard on purpose and watch this test go red*. **That removes the
invitation, not the possibility** — the generator still cannot write the call, because it does not know the
mechanism's name or shape. **`register-driver`'s existing race test is still the broken shape and is still
owed a retrofit.**

This is the same family as **V1** (a race test that passes for a non-reason) and **V8** (a race scaffold
generated from a non-contended GWT). Three findings now say the concurrency scaffolding produces tests that
look like proof and are not, which makes it the weakest generated artifact in the kit.

### Z5 — two labels that PascalCase to one identifier: one is silently dropped, and reported as `kept` · **BROKEN**

`Stock Level Set` and `StockLevelSet` become the same C# identifier. The second file overwrites the first
and the run reports it as `kept (already filled in)`, so the count looks healthy. **The report actively
lies here**, which is worse than the collision. → [detail](KIT-HISTORY.md)

### V9 — `architect` and `codegen` disagree about what "multi-stream" MEANS, so four Async views were never questioned · **BROKEN**

Two tools, two definitions, and the gap between them is silent:

| | decides multi-stream by |
| --- | --- |
| `codegen.mjs` (`isMultiStream`) | one feeding stream **and** `identity=` equal to that stream's key → single. **Otherwise multi** |
| `architect.mjs` (`const multi`) | `streamTypes.length > 1` — the count of feeding aggregate types |

A view fed by **one** stream but keyed by something **other than that stream's key** is multi-stream to the
generator and single-stream to the architect. `codegen` registers it **Async**; `architect` never raises
`stale-read` for it; nobody ever decides whether that staleness is acceptable.

**Measured on Voltway — four views, every one of them Async and unquestioned:**

```
CardDirectory          architect: single   codegen: ASYNC   never asked
ChargePointDirectory   architect: single   codegen: ASYNC   never asked
OpenSessions           architect: single   codegen: ASYNC   never asked
SessionsToPrice        architect: single   codegen: ASYNC   never asked
```

**Two of those are the correspondence lookups a translation resolves every foreign notice through**, so the
unasked question is *"can a charge arrive before the bay that produced it has projected?"* — which is
exactly the question the record should have forced. The implementing agents hit it anyway and answered it
in code; the record is silent.

**Wanted:** one definition, shared. `isMultiStream` already exists in `codegen.mjs` and is the correct one —
it is what actually decides the registration. `architect.mjs` should import it rather than re-derive a
weaker test. The general lesson is the kit's own: **two copies of a rule are two rules.**

### T1b — the ingest seam promised a retry that does not exist by default · **BROKEN** · ***comment FIXED, policy still not emitted***

The T1 fix — a foreign event arriving as a message on a durable local queue — shipped with a scaffold
comment saying the envelope is *"persisted on arrival, **retried if this throws**, and dead-lettered if it
keeps throwing."* **The middle clause is false as generated.** Wolverine moves a message to the dead letter
queue when it *"exhausts all its configured retry/requeue slots"*, and a project with no policy configured
has none — so the **first** throw dead-letters.

**Found by implementing `translate-charge-start`**, whose translator refuses a notice it cannot resolve on
the assumption that the queue will retry it. `ARCHITECTURE.md` had inherited the same false claim —
*"the durable queue retries it, so nothing is lost"* — and the slice had to add
`RetryWithCooldown` in its `<Slice>Wakeup.ConfigureWolverine` to make the record true.

**Why this matters more than a wrong comment:** for an at-least-once feed that never re-sends, a transient
database blip loses a notice permanently, and the suite stays green because a test hands the notice to the
handler directly and never exercises a failure. It is the same shape as T4.

**`RetryWithCooldown` specifically**, not any other policy: the docs state only *"Retry"* and *"Retry With
Cooldown"* are applied automatically to an inline `InvokeAsync`. Anything else works in production and does
nothing in the suite — the worst possible split.

**Wanted:** `codegen.mjs` should EMIT a retry policy for ingest rather than describing one. The comment now
tells the truth and points at the fix, which is the smaller half.

### V7 — the concurrency retry does NOT apply to an HTTP endpoint, and every generated one says it does · **BROKEN**

**`Program.cs` carries `opts.OnException<ConcurrencyException>().RetryTimes(3)`, and every generated
state-change endpoint carries a comment saying the collision "reaches the retry policy in Program.cs".
That is a MESSAGE-pipeline policy. A Wolverine.HTTP endpoint never enters that pipeline.**

So on a concurrent duplicate, a generated HTTP state-change slice throws
`EventStreamUnexpectedMaxEventIdException` straight out to the caller — **a 500, not the ordinary
business refusal the kit claims.** Every HTTP state-change slice this kit has ever generated has this.

**Verified BEHAVIOURALLY, and the first evidence offered for it was worthless.** The claim was originally
supported by *"the generated HTTP endpoint has no try/catch"*. **That proves nothing** — dumping all 27
generated files with `codegen write` shows **zero catch blocks anywhere, message handlers included**.
Wolverine's retry lives in the message *executor* around the generated code, not inside it, so its absence
from a generated method is expected in both cases. Recorded because it is exactly the kind of
plausible-looking evidence that survives review.

The decisive test is behavioural: a probe endpoint in the **default scaffolded shape** (decider IS the
endpoint, `[WriteAggregate]` as middleware), raced by two callers released together against one hold.

```
JasperFx.Events.EventStreamUnexpectedMaxEventIdException
  at Marten...DocumentSessionBase.SaveChangesAsync
  at Internal.Generated.WolverineHandlers.POST_charging_probeInlineCancel.Handle(HttpContext)
  at Microsoft.AspNetCore.Routing.EndpointRoutingMiddleware...
```

**The exception leaves the endpoint and reaches the client.** No retry engaged. (The `Polly` frame further
down is Marten's own batch resiliency, not Wolverine's policy.)

The docs corroborate rather than prove: `wolverine/guide/handlers/error-handling.md` says *"When using
`IMessageBus.InvokeAsync()` to execute a message inline, only the 'Retry' and 'Retry With Cooldown' error
policies are applied **automatically**"*, and neither `guide/http/policies.md` nor
`guide/http/exception-handling.md` documents any retry — only an `OnException` convention that **swallows**.

**Why KIT-FINDINGS BM6 did not catch it:** that finding verified the retry on `automation/`, where commands
arrive by `InvokeAsync`. The HTTP path was never the tested one.

**Why `hold-bay` looked fine:** it owns its transaction for the advisory lock and retries *inside its own
mechanism*, so it never depended on the policy. The first slice to use the plain aggregate handler workflow
over HTTP is the first that could expose this.

**The fix used in `cancel-hold`** is a 5-line endpoint that invokes the decider through the bus, putting it
back on the message path where the retry is real. Same route, same body, same status codes — the wire is
unchanged.

**And the cheaper fix is wrong, with a test to prove it.** Translating the collision to a rule name via
Wolverine.HTTP's `OnException` convention is tempting and produces a lie: **a version conflict does not mean
the business rule failed.** Voltway's Bay stream is shared with the estate context, so a fault report or a
service job appending concurrently also collides — and the translation would refuse a perfectly live hold
with `NoLiveHold`. `AnUnrelatedConcurrentAppendDoesNotRefuseTheCancel` is red under a translation and green
under a retry, because a retry **re-reads** instead of guessing.

**Wanted:** `codegen.mjs` should emit the mediator hop for HTTP state-change slices, or stop claiming the
retry applies. Right now the comment is the most confidently wrong sentence the generator produces.

### V8 — the concurrency scaffold is generated from the wrong GWT · **BROKEN**

`architect.mjs tests` picks a slice's contended GWT and writes its rule name into the scaffold's header and
its suggested assertion. On `cancel-hold` it picked **`NotTheHolder`**, which is **not contended at all** —
Ben is refused whether or not Ada is cancelling at the same instant. The genuinely simultaneous case is the
holder cancelling twice, and its refusal is `NoLiveHold`.

The scaffold's suggested assertion (`Title == "NotTheHolder"`) would therefore have been **wrong**, and a
test written to it passes while pinning nothing. Contention is a property of *whether two callers can both
reach the rule*, not of the rule being a rejection — and the tool currently uses the second.

### V6 — adding a same-stream precondition HIDES a cross-stream rule from the classifier · **BROKEN**

`architect.mjs` classifies each GWT into one question family. A rejection whose GIVEN names another
stream is `cross-stream-rule`; one whose GIVEN is on the command's own stream is
`contended-invariant`. **A GWT with both gets classified as the second, and the cross-stream question
stops being asked.**

**Measured on Voltway.** `gwt-hb-3` — *one live hold per driver, network-wide* — began as
`given="Bay Held(bayId=$Bay7, driverId=$Ada)" when="HoldBay(bayId=$Bay3, driverId=$Ada)"` and was
correctly raised as `cross-stream-rule`. It is the sharpest question in the system and its answer is an
advisory lock, the most expensive mechanism built here. Implementation then found a missing rule
(*a bay that was never commissioned cannot be held*), so the GIVEN gained
`Bay Commissioned(bayId=$Bay3)` — a precondition on the command's **own** stream. On the next run the
tool reported the cross-stream answer as `ANSWER TO A QUESTION NOBODY ASKS`.

**The rule did not change. The driver still holds `$Bay7` while commanding on `$Bay3`.** Only the
classification did.

**Why it matters more than a bookkeeping slip:** had the model been written with that precondition from
the start — which is the natural way to write it — the cross-stream question would **never have been
asked**, the advisory lock would never have been chosen, and the invariant would have shipped as a
best-effort check two concurrent writers both pass. The failure is silent and lands on the single
hardest decision in the system.

**Wanted:** classify a GWT into **every** family it belongs to rather than the first that matches, and
let one rule carry two questions. The orphan report is the only reason this was caught at all, so it is
doing its job — but it fires *after* the answer exists, and a model written this way from the start
produces no orphan and no question.

**A SECOND, WORSE INSTANCE — and here nothing reported anything.** `register-driver`'s
`EmailAlreadyRegistered` and `CardAlreadyRegistered` are unique-across-**all** Driver streams. The tool
filed both as `contended-invariant` from the very first run, so they inherited the boilerplate answer
*"the stream key already contains the contested thing, so optimistic concurrency refuses the loser."*

**That is false, and following it ships a slice with no guard at all that passes every GWT** — `driverId`
is `terminal="driverId:generated"`, so every call mints a new stream and the fold is empty by
construction; two callers collide on nothing. Only a race test catches it, and the race test is
scaffolded from the same misclassification.

**The information was on the cell.** The GWT's own label reads *"No two drivers may share an email.
Spans streams: each driver is their own."* The classifier compares example key values and never reads it.
Two cheap improvements, either of which would have caught this: compare the aggregate **instance** where
the example data gives one, and treat a `terminal="…:generated"` key as *"a new stream every time,
therefore the fold cannot see other instances"* — which is precisely the condition that makes a
same-aggregate rule cross-stream.

### V5 — `status=` cannot be both "which tests run" and "how far along is this" · **BROKEN**

`status=` is read at **scaffold time** to decide whether a GWT's test is born with `[Fact(Skip=…)]`, and
test files are `scaffold` — so the skip is **kept for ever**. `codegen.mjs` generates the whole system in
one pass. Those three facts together leave no good option:

| | Tests | `status=` as a progress signal |
| --- | --- | --- |
| promote every slice to `ready` before the first scaffold | all live, 0 skipped | **destroyed** — every slice reads `ready` whether or not a line exists |
| leave them `in-design` and promote per slice | every later slice's tests baked `Skip`, each needing a hand edit that `TESTS STILL SKIPPED ON A CLAIMED SLICE` can only report, not repair | meaningful |

**Measured on Voltway.** Promoting all 22 before scaffolding gave 75 live tests and 0 skipped — and then
`status=` said `ready` for 19 slices with nothing written and `in-progress`/`in-review` for the one that
was built. A human reading the model for progress gets no signal at all, which is exactly what happened:
the user asked why "19 slices remain" did not match the statuses, and the answer was that the number came
from counting implemented code rather than from the field that exists to carry it.

**The field is being asked to do two jobs that want opposite defaults**, and the test-suite job wins
because its failure mode is silent. Options, none free:

- **`Skip` from the model at RUN time, not scaffold time** — a `[SkippableFact]` or a trait filter reading
  the compiled IR, so promoting a slice changes the run without touching a kept file. Removes the conflict
  entirely and is the only option that does.
- **Scaffold per slice** rather than per system, so an unpromoted slice has no test file yet.
- **Split the field** — `status=` for progress, and let the runner decide skipping some other way.

Until then, say out loud which convention a project is using, because the model does not.

**MITIGATED, not fixed.** `node tools/progress.mjs` reads the generated **code** rather than the claim
and prints both side by side — `N/20 built · NNN holes left` — with a `STATUS DOES NOT MATCH THE CODE`
section naming the exact `slice.mjs promote` command to reconcile it. `--stale` shows only the
disagreements. And `slice.mjs promote` now exists as the symmetric twin of `demote`, so moving a slice
forward is one command rather than a hand edit of two places that must agree — which is how `hold-bay`
came to sit at `in-progress` after it was finished.

That makes the drift **visible and cheap to correct**. It does not remove the conflict: `status=` still
cannot be both things at once, and the run-time-skip option above is still the only answer that does.

### V4 — every MOBILE review shot of a data-driven page is a picture of the loading state · **BROKEN**

`shoot.mjs` renders below `MIN_HONEST_WIDTH = 520` inside an `<iframe>`, which is the correct fix for the
sub-500px Windows layout lie it was written for. But the iframe is **cross-origin** (`file://` inside
`file://`), so it gets its own renderer process, and `--virtual-time-budget` — which advances a clock in
the *main* frame rather than sleeping — does not pause for the iframe's pending `fetch`. The shot is taken
before the data arrives.

**Measured on Voltway's `bay-finder`** at `--settle` 0, 4000 and 20000: identical loading-state shot every
time. Shooting at 520 gets real data — and then `review.mjs`'s sheet hard-codes `img { width:${w}px }`
(line ~161), so a 520px shot placed in a 390px column is **silently downscaled to 0.75×**. The port's type
then looks a quarter smaller than the design's, side by side, under a caption that says *"at 1:1"*.

So the two failure modes compose: shoot honestly and you photograph a spinner; shoot wide enough to get
data and the sheet lies about the scale. **This affects every data-driven screen in the kit at mobile
width**, and `design.mjs` is unaffected only because a static design page fetches nothing.

**The workaround in the project is a same-origin shim** (`web/_shot390.html`: a 390px iframe scaled
×1.333, served by Vite so the outer page shares the app's origin). It works and it is not where the fix
belongs.

**MEASURED, so the obvious fix can be ruled out.** `probes/` style run against a page that prints
`innerWidth` and flips a line after a resolved promise:

| invocation | `innerWidth` | async work landed? |
| --- | --- | --- |
| `--window-size=390` DSF 1 | **492** | — |
| `--window-size=390` DSF 2 | **492** (png 780×600) | yes |
| `--window-size=780` DSF 2 | **764** (png 1560×1200) | yes |

So **`--force-device-scale-factor` cannot produce a narrow CSS viewport** — `--window-size` is in CSS
pixels and DSF only changes output density. That kills the "drop the iframe, shoot at 780 physical"
suggestion outright.

The same probe settles the mechanism: **`--virtual-time-budget` DOES wait for async work in the main
frame.** The iframe is the entire problem, and only for an `http://` target — a `file://` design page
inside a `file://` shim is unaffected, which is why `design.mjs` never showed this.

**Two fixes remain, both real:**

1. **Same-origin shim, generalised into `review.mjs`.** Write the wrapper into the app's own served root
   so shim and target share an origin and one renderer, shoot it, delete it. This is exactly the manual
   workaround, moved into the tool. Cheap; only helps targets the kit can write a file into.
2. **Drive Chrome over CDP instead of flags** — `Emulation.setDeviceMetricsOverride` sets a true 390 CSS
   viewport with no iframe at any width, and `Page.captureScreenshot` takes the shot. Node 22+ has a
   global `WebSocket`, so this needs no dependency. Larger, and it fixes the width floor permanently
   rather than working around it.

### V2 — a documented Marten `Apply` overload is SILENTLY SKIPPED on a multi-stream projection · **BROKEN** *(in Marten, not the kit)*

`marten/events/projections/conventions.md` lists **`Task<T> Apply(TEvent, IQuerySession, T)`** as valid
return type 4 — *"allows you to use immutable aggregate types while also using external data read through
IQuerySession"*. On **Marten 9.22.5 / JasperFx.Events 2.42.2** it compiles, the host boots, the daemon
runs, and **that one `Apply` does nothing**: no exception, no warning, no log line. Measured on Voltway's
`AvailableBays` — the row came back with `bayId`, `siteId`, `bayLabel`, `connectorType` and `maxKw` all at
their type defaults while every other `Apply` on the same projection worked. Reproduced `static` and
instance.

**This is the worst failure shape there is** — a documented API that compiles and silently does nothing —
and nothing in this kit would have caught it. The model validates, the code compiles, the suite is green,
and the read model is empty. It was found because the slice gate says *look at the endpoint*, and the
agent looked.

**What works instead is `EnrichEventsAsync`**, which is an `override` and therefore cannot be silently
skipped. `enrichment.md` says the hook exists *"at least for SingleStreamProjection classes"*; the
`JasperFx.Events.xml` doc file puts it on `JasperFxAggregationProjectionBase`, the base of **both**, and it
runs fine on a multi-stream projection. Its two halves live in namespaces no page states —
`JasperFx.Events` for `IEvent<T>`/`EventSlice`, `JasperFx.Events.Grouping` for `SliceGroup`. It also
batches, so it avoids the N+1 the docs warn about in the same breath as the shape that does not work.

**Wanted:** confirm against a newer Marten and report upstream if it survives. Until then, treat
`IQuerySession` in an `Apply` signature as non-functional on multi-stream projections and reach for
`EnrichEventsAsync`. This is the third entry in the *"the mirror is not infallible either"* family and the
first where the documented member **exists, compiles and lies**.

### V3 — the generated Async-view test hint names a namespace that does not exist · **BROKEN** · ***FIXED***

`codegen.mjs` told every Async view's test to import `Marten.Events.TestingExtensions`. That is a **static
class**, not a namespace, so the `using` is `CS0138` — settled from `Marten.xml`, where the member is
`M:Marten.Events.TestingExtensions.WaitForNonStaleProjectionDataAsync`. The hint appeared on all five of
`bay-availability`'s scaffolded GTs and would have sent every implementing agent down the same path. Fixed
in both hint sites; the correct import is `using Marten.Events;`. Checked while fixing: overloads exist on
**both** `IHost` and `IDocumentStore`, so the hint's `Store.…` receiver was right.

### V1 — a race test for a lock taken BEFORE the read can pass without the writers ever overlapping · **BROKEN**

`architect.mjs tests` scaffolds, and `reference-implementations/cross-aggregate-invariant/` ships, an
advisory-lock race test that is a bare `Task.WhenAll` of two writers. **The reference implementation
explains why it cannot use the `Barrier(2)` every other arm uses** — a read-barrier deadlocks against a
lock taken before the read, since preventing simultaneous reads is exactly what that lock does — and then
asserts an outcome *shape* instead. That reasoning is correct and the conclusion is still not safe:
nothing in either version proves the two writers overlapped at all.

**Measured on Voltway's `hold-bay`.** Written that way the test went green; **mutating the advisory key to
a random value left it green**, because each writer read and committed before the other reached its read.
The guard was never exercised.

**What works is a delay seam rather than a barrier.** The writer holding the lock waits between its read
and its append while the other writer is blocked at the lock; remove the lock and the second writer reads
straight through the open window and both commit. Mutation-checked in both directions —
`HoldBayMechanism.HoldAsync` carries a test-only `afterRead` hook, null on every production path.

**A delay is still a bet, so the shipped form uses no wall clock at all.** The lock-holder *parks* in the
`afterRead` seam until the test releases it; the test then proves the boundary is locked with a keyed
`pg_try_advisory_xact_lock` on its own connection, waits for the second writer to be **observably**
blocked in `pg_locks` (a condition, not a duration), releases, and asserts the outcome shape. Mutating
the lock key fails it at the keyed assertion in under a second — 3 runs red, 5 green alone, 3 green with
the suite.

> **A RETRACTION, AND IT IS THE METHOD TURNED ON ITSELF.** This entry first recorded the intermediate
> version as *"order-dependent — passes in the suite, fails 0 of 6 alone."* **That measurement was
> wrong.** The restore step used `Move-Item` from a `Copy-Item` backup, which preserves the ORIGINAL
> mtime — so the restored source was older than the compiled assembly, MSBuild judged the build up to
> date, and `--no-build` re-ran the **mutated** binary six times. After a real rebuild: 5 of 5 green.
> The lesson is exactly the one this kit keeps relearning at a different altitude: **a mutation test
> proves nothing unless you can show the mutation actually reached the binary**, and `--no-build` after
> a timestamp-preserving restore silently guarantees it did not.

**And the reference implementation's arm 3 should be re-measured the same way**, because if its two
writers never overlap either, the arm that CLAUDE.md calls "the odd one and often the best" is green for
a reason unrelated to the lock. The implementing agent's independent read is that arm 3 uses the v1
shape and **v1 is the version that survives its own mutation** — so this is a live suspicion about
shipped reference code, not a hypothetical.

### AD9 — `validate` passes 0/0 on a `.drawio` draw.io cannot open · **BROKEN**

The parser is more tolerant than the editor. A model can be green in the kit and unopenable by the human
who has to look at it — and *"always close the loop by looking at the diagram"* is the one rule that then
cannot be followed. → [detail](KIT-HISTORY.md)

### AD4 — `reflow` grows lanes and never shrinks them · **BROKEN**

Geometry only ratchets. Remove a swimlane and the lane keeps its height for ever, so every derived y is
wrong in a way nothing reports. → [detail](KIT-HISTORY.md)

### AD5 — the View → Screen routing strip is placed under the UI LANE, not under the last ACTOR band · **BROKEN**

With actor lanes drawn, the strip lands inside the lanes instead of below them, so feeds cut through
screens. Latent until a model has two actors. → [detail](KIT-HISTORY.md)

### BM3 — the kit had 156 tests and not one of them was a unit test · **GAP** · *partly closed*

Not a testing preference — a **consequence**. A decider holding `IDocumentSession` cannot be tested any
other way, which is precisely the cost `LEB` ch. 15 warns about (*"you'll need a mocking framework"*), paid
in Testcontainers instead of mocks. With the deciders converted (**BM1**) the tier became possible:
`reservation/` has 12 and `automation/` 4, running in **~150 ms with Docker stopped**.

**Still open for the other four folders**, and for the shape worth copying: a unit test can assert things no
integration test can reach — `an_already_decided_grant_does_not_call_the_work_again` checks that the
executor was not invoked a second time, which leaves no trace in the event store and is the thing that
cannot be undone.

### BM4 — three namespaces no doc page states, all found the same way · **NOISE** · *recorded, not fixable*

The AD15 class, three more in one session. `IEventStream<T>` is in **`JasperFx.Events`**, not
`Marten.Events`. `OnException<T>()` is an extension on `IWithFailurePolicies` in
**`Wolverine.ErrorHandling`** — the docs show both `opts.OnException<T>()` and
`opts.Policies.OnException<T>()` and **neither compiles** without that using. `StubEventStream<T>` exposes
`EventsAppended` and `Key`, while the docs' own unit-test example uses `.Events` and `.Id` — and `Id` is
documented as *"Guid.Empty when the stream is keyed by string"*, so it silently addresses nothing on a
string-identity store.

Standing rule unchanged and earning its keep: **read the mirror, grep the package `.xml`, then compile.**

### BL3 — a codegen run that CRASHES leaves partial scaffolds, and the next run reports them as `kept` · **BROKEN**

Measured: `codegen.mjs` died partway through view generation (BL1), and the re-run after the fix printed
`29 file(s) written, 4 kept (already filled in)`. Nobody had filled anything in — those four were the
crashed run's own half-written scaffolds, and `kept` means *regeneration will never touch them again*. The
count looks healthy, which is the same failure shape as **Z5**: the report actively lies.

`rm -rf generated build` and re-run is the workaround, and it is only obvious if you already suspect it. A
scaffold written by a run that did not finish is not a scaffold anybody owns; either write scaffolds last,
or write them to a staging name and rename on success.

### AD7 — `route` refuses a same-column View → Screen because of `SCREEN_X_NUDGE` · **BROKEN**

The one edge ch. 16 of the book requires — a View feeding the screen in its own column — is the one the
router will not draw. → [detail](KIT-HISTORY.md)

---

## 2. Missing capability

### A11 — `codegen` scaffolds no decider · ***FIXED 2026-08-09*** → [detail](KIT-HISTORY.md)

It now scaffolds one per command slice — an HTTP endpoint for `state-change`, a message handler for
`automation`/`translation` — in the A-Frame shape, with the middleware attributes, the stream-key member to
resolve and one TODO per rule the model states. **The absent scaffold was not just a gap, it was the
mechanism of BM1**: with nothing to copy, every hand-written decider reached for `IDocumentSession` and
`FetchForWriting`, and the kit's own docs said the alternative was unavailable.

### AD19b — the GWT scaffold's stream-key hint is wrong for a non-stream boundary · **GAP**

A slice whose `architect` decision picked a guard row, reservation row, advisory lock or DCB has a
boundary that a raw `Given` **cannot see** — measured, and it silently made two tests pass for the wrong
reason. The scaffold still says only *"Stream key: `X.StreamKey(...)`"*. It should say which boundary the
slice decides on. Blocked on `codegen` not reading `ARCHITECTURE.md`, which is a larger change.

### AD20a — no multi-step process, and no failure direction · **GAP**

`reference-implementations/automation/` measures four ways to *wake* a trigger. It does not demonstrate a
**chain** of todo lists across slices, and — the one with teeth — **the failure direction**: a command that
fails, leaves its row open, is retried on the next sweep, and dead-letters after N. That is the whole
compensating-transaction story, it is what makes the todo-list pattern a saga replacement, and nothing in
the kit tests it. *"The task stays open and is retried"* is precisely the property a green suite does not
check.

### BK1 — an automation's todo View can silently lose work · ***DEMONSTRATED 2026-08-09*** · **still BROKEN in the generator**

`UES` **ch. 32** names the failure: *"entries get lost if the processor was running before the model got
updated"*. **It is no longer a claim.** `reference-implementations/reservation/` reproduces it
deterministically — `ExecutionModeTests.CONTROL_an_async_todo_view_silently_loses_the_work`: the wakeup
arrives inside the request that appended the trigger event, the async daemon cannot have caught up, the
trigger reads an empty todo list, and the reservation is never executed and never compensated. A 200
response, a clean log, a green suite, and a unit of a limited resource held for ever.

**The defence is to register a todo View `Inline`**, which puts the row in the append's own transaction.
Costs exactly what the book says Inline costs: the write side stops being independently scalable, and a
projection exception aborts the business transaction. Both accepted there, with the reasoning at the line.

What remains open is **BL2 below** — the generator still picks Async for these. And the chapter's own
answer, the *partially synchronous projection* (a bounded in-memory queue filled by a synchronous handler),
is still built nowhere; it is the third read-side option CLAUDE.md names.
→ [BOOK-INDEX.md](reference/BOOK-INDEX.md) gap 1

### BL2 — `codegen` registers a TODO View like any other multi-stream view, which ships the hazard above as a default · **BROKEN**

A todo View is not a view somebody reads. Marten's *"register the lookup projection inline and the
multi-stream projection async"* is guidance about the latter; an automation's **liveness** depends on the
former, and BK1 is what Async costs it. `codegen` cannot tell them apart today and picks Async for both.

It has the information: a View consumed by an `em="automation"` cell on the same slice is a todo View, and
the IR already carries that edge. Either register those Inline, or emit the report — `TODO VIEW REGISTERED
ASYNC` — by the same logic as every other report the generator owes. Worked defence and the deterministic
reproduction: `reference-implementations/reservation/`.

### BK2 — the Reservation Pattern, both halves · ***BUILT 2026-08-09*** → [detail](KIT-HISTORY.md)

### BK3 — the kit emits no metadata: no correlation ID, no causation ID · **GAP**

`UES` **ch. 39**. *"Event Sourcing is about preserving all data, and that includes metadata"*, and
*"we'll deal with metadata later"* is named as the trap. `codegen` generates no metadata strategy at all.

### BK4 — GDPR has no notation, and part of it is model content · **GAP**

`UES` **ch. 41**. Crypto shredding and forgettable payloads are implementation; **data minimalism is
modelling** — keep events fine-grained so personal data lands in one event instead of a fat one, because
a replay is what purges projections and the model is what tells you which ones to replay. No PII notation
exists.

### BK5 — event order is only guaranteed WITHIN a stream, and the kit never says so · **GAP**

`UES` **ch. 30**: *"If more than one stream is used as a source for the projection table... the order of
events typically is only guaranteed within one stream, not over several streams."* The kit generates
multi-stream projections routinely and states this nowhere.

### BK6 — the right-to-left validation walk is not implemented · **GAP**

`UES` **ch. 7** gives *two* validation tricks. The kit has the left-to-right narrative one. The second:
uncover events **from the right**, one at a time, checking each has everything it needs from its
predecessors. That checks **sequence sufficiency**; name-based completeness cannot.

### BK7 — a slice that is not ours to implement has no marker · **GAP**

`LEB` **ch. 9**: *"Slices that just mimic information flow"* get no border — an explicit visual marker for
a slice drawn as context, belonging to another system. The kit has `pattern=` and `status=` and nothing
for this, so **`codegen` would try to generate it**.

### BK8 — Lookup Tables, which answer T5 · **GAP**

`UES` **ch. 37**. The ID → name problem, modelled explicitly or implicitly, with the rule *keep them local
to a slice and accept the duplication*. Closes the "foreign key that is not our key" gap conceptually.

### BK9 — "fenced polling" is the answer the UI findings point at · **GAP**

`UES` **ch. 42**. Return the aggregate sequence from the command, persist the projection's version beside
it, poll only until they match. The kit's `ui-journey` rule *"if an assertion only passed on retry, that is
a finding"* is correct and has never said what to do about it. This is what.

### AD3 — "closing the books" is model content and the kit has no notation · **GAP**

Both books prefer bounding a stream by a business period over snapshotting — *"better to limit the length
of a stream naturally by understanding the business processes."* Which stream closes, and on what event,
is a domain fact with nowhere to live.

### T5 — a foreign key that is not our key has no notation · **GAP**

A correspondence between their identifier and ours can be stated nowhere; `mappings=` is a rename and
cannot cross types. Currently survives only as example data on a GWT.

### A10 — `Program.cs` is `emit`, so two runtime settings cannot be reached · **GAP**

Same class of bug as the read-model registrations, which were fixed by giving them a scaffold. If a
decision has no scaffold to live in, the generator is making it.

### A6 — a rule cannot choose its HTTP status · **GAP**

`Rejections.Problem` hard-codes 400. **Reconciled with Y1** (2026-08-09): a status code is *not* model
content and must never get notation — so this is a `codegen`/`architect` concern about how a decider
reports, not a missing attribute. Recorded so the two findings stop appearing to contradict each other.

---

## 3. Noise and cosmetics

### T4b — `VIEW WITH NO REGISTRATION` cannot tell "forgot" from "deliberately not a projection" · **NOISE**

A live-aggregation view is correctly unregistered and reported anyway.

### AD6 — `mapping-crosses-types` fires on every rename between a screen and a command · **NOISE**

A screen's `string` input legitimately becomes a typed command field.

### Z3 — a screen and a read model sharing a label resolve to whichever comes first · **NOISE**

### AD20b — the back-channel is not drawn differently · **NOISE**

Dilger draws the tick-off edge (`Event → todo View`) **dashed**, *"to indicate that this is not part of the
Flow but just updating the data of the Read Model."* The kit's grammar already permits that edge — it is
the single `Event → View` exception — but does not distinguish it. A real reader aid on a busy automation.

### BL4 — `architect.mjs` and the reference-implementation layout disagree about where things live · **NOISE**

`architect` reads `<project>/diagrams/` and writes race tests into `<project>/generated/<System>/tests/…`.
A reference implementation keeps its model in a named folder (`allocation/allocation.drawio`) and its code
in `generated/{src,tests}` — so **both halves need a scratch project and a copy back**, which is
undiscoverable and was rediscovered this run. `codegen.mjs` already takes the model path explicitly;
`architect` could take the same argument. Recipe, until it does:
`reference-implementations/reservation/README.md`, *Running it*.

### BL5 — the view scaffold's doc comment hard-codes "registered INLINE in Program.cs" · **NOISE**

Every generated view says *"Multi-stream projection, registered INLINE in Program.cs"* whatever lifecycle
`ViewRegistrations` actually emits — so three views in `reservation/` claimed Inline while being registered
Async. Two errors in one sentence: the lifecycle is not read from the registration, and **the registration
has not been in `Program.cs` since it moved to the `ViewRegistrations` scaffold**. Cosmetic, and it is the
comment a reader trusts when deciding whether a test must wait.

### BL6 — `cross-stream-rule` cannot tell a CONTEXT given from a DECIDING given · **NOISE**

On `reservation/` it fires on **8 of 15 GWTs** and exactly one (`gwt-reserve-3`) is genuinely contended.
The rest either read a value nothing ever rewrites (`capacity`, written once by the create slice) or name a
prior event for *context* while the fact that actually refuses the command sits in the stream the command
appends to. Each still costs a decision, a reason and a cost in `ARCHITECTURE.md`, which is how the one
that matters gets skimmed. A cheap improvement: rank a question below the others when every GIVEN outside
the appended-to stream comes from a stream with a single writing slice.

### BL7 — `terminal=` has no kind for a value the WORK answers · **OPEN**

`Grant Refused.reason` is the executor's verdict — not `actor`, not `clock`, not `const`, and not really
`generated` either, which is what it had to be declared as. A `result` kind would fit. One model wanting
one is not a case for adding it; recorded so it is a decision rather than an omission.
`reference-implementations/reservation/`.

### Z7 / T6 / W4 / W5 / B5 — smaller things, recorded not fixed

→ [detail](KIT-HISTORY.md)

---

## 4. Open questions

### AD2 — is DCB needed, or does multi-stream aggregation suffice? · ***ANSWERED 2026-08-08***

**Neither, exactly: four mechanisms all work.** A guard row, a reservation row behind a unique index, an
advisory lock and DCB each hold a cross-stream invariant; a multi-stream aggregation **does not**, and the
control test proves the race reproduces deterministically without a guard. Three of the four need no
Marten 9. Kept here rather than moved to history because it is the question the `architect` step now
answers per project. Full comparison: `reference-implementations/cross-aggregate-invariant/`.

### The standing "to confirm with the human" list

→ [KIT-HISTORY.md, section D](KIT-HISTORY.md). Reviewed 2026-08-09; nothing in it blocks work.

---

## 5. Standing rules — measured, and they stay true

These are not bugs. They are the conclusions that survived, and each one is enforced somewhere.

| | Where it bites |
| --- | --- |
| **Where the kit and the critter-stack docs disagree, the docs win — and the kit is CHANGED** | audit *defaults and behaviour*, not API names: a wrong method name fails to compile, a wrong default ships |
| **A green build is not evidence** | all three Marten 9 breaks compiled at 0/0 and died at host startup. The gate is that the host *starts* |
| **The docs mirror is always current, so a kit a major behind disagrees with its own reference** | a version bump is maintenance of the docs contract, not just the packages |
| **Never assert an invariant on a read model** | the race that breaks the invariant corrupts the view too, in the flattering direction |
| **A race test with no control proves nothing** | "the guard worked" and "the race never reproduced" are the same green |
| **`Store()` cannot conflict** | it supplies the version the entity already has. `UpdateRevision(doc, doc.Version + 1)` |
| **Grep the package `.xml` before suspecting the version** | a wrong namespace can imitate a wrong version, never the reverse |
| **The generator does not reach backwards** | a fix reaches new files only; scaffolds are kept. Add a *report*, not a rewrite |
| **Determinism holds across runs and model tiers** | three independent runs produced byte-identical `emit` output |
| **Concurrency, security, transport and status codes are NOT model content** | both books; asking for notation is answered, not built |
| **A saga is an implementation of an automation slice** | the todo-list View is the notation; neither author forbids a saga underneath |
