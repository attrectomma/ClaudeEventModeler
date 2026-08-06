# Kit findings

Everything the kit got wrong, everything the runs taught, and every decision parked for the human.

**Three runs so far.** The first (CPOC01, *Recipe Box*) took a business brief through the whole workflow to
a clickable Docker app. The second (CPOC02, the book's shopping cart) was a deliberate verification on a
domain the kit had never generated from, chosen so that the **book** supplies every domain answer and the
kit can be scored against a documented expected outcome. The third built
`reference-implementations/translation/` — the last of the four patterns — model → generator → implementation
→ run, and is section **T** below.

The second run is first below, because its findings are sharper: a fresh domain exercises paths a
familiar one cannot, and three of its four `BROKEN` findings had been latent since the kit was written.

**Where this came from.** One session, 2026-08-06: the *Recipe Box* brief in `CPOC01/inbox/` taken
through all eleven `event-model` phases, then `styling`, then `codegen` for two slices — `create-recipe`
(State Change) and `recipe-list` (State View) — ending in a Docker Compose app that serves a clickable
site. Two slices are `in-review`; `add-ingredient` and `recipe-detail` are still `in-design`.

Nothing here was fixed during the run. That was deliberate and the human's call: prove the workflow end
to end first, so the artifact under test does not change while it is being measured.

**Severity, used consistently below:**

| | Meaning |
| --- | --- |
| **BROKEN** | the kit actively misleads. A user who trusts it reaches a wrong conclusion |
| **WRONG** | a documented claim is false. Costs time, does not corrupt output |
| **GAP** | something the kit cannot express or generate. No false claim, just a wall |
| **NOISE** | true, harmless, worth removing |

---

---

# The second run — the book's cart, ch. 12 and 16 (CPOC02)

A whole-workflow verification on a domain the kit had never generated from: the shopping cart of
*Understanding EventSourcing*, modelled from **the book** rather than from the kit's own `slice.mjs`
fixture, with the book playing the domain expert. Backend only, by agreement — the frontend paths had
just been exercised twice, and the backend is where modelling decisions become irreversible.

**Why this example.** Neither book has a second worked domain, and that turned out to be an argument
*for* the cart rather than against: the book also *implements* it (ch. 21–28), so there is a reference
answer for the backend and not only for the model. Ch. 16 is a **Translation** — external event →
view → automation → command → internal event — which codegen had never seen outside a reference
implementation. And ch. 16 exists precisely to demonstrate the completeness check finding a gap, which
gives a documented expected outcome to score the kit against.

**What was run:** `project.mjs init`, a two-file inbox with chapter provenance, phases 1–10, `slice.mjs`
for all geometry, `compile`, `codegen`, `dotnet build`, `dotnet test`, and an agent implementing the
translation slice against real Postgres.

## B-1 — Follow-on work: the reference implementations had no view specifications at all

Filed during the first run as A7/B1 and done after the second, because the second run made the case
better than the first: a GT is the **only** executable evidence a State View slice ever gets.

**All five view slices in `state-view` had no scenarios, and so did `my-drafts` in `state-change`** — the
first pass reported three because the output was truncated. So the kit's own worked examples demonstrated
six read-model *recipes* and never once demonstrated how a View is **specified**, which is the thing a
reader most needs to copy and the thing both books call mandatory. Nothing asked until `slice-needs-gwt`
started covering view slices.

Seventeen Given/Thens added. The ones that earn their keep are the three asserting **what a view
IGNORES** — *"an outcome does not touch the monthly rollup"*, *"an outcome does not add a log row"*,
*"closing a campaign changes its status and nothing else"*. The drawing already says which events feed
which view; these make that claim executable, and it is the one class of mistake a projection can make
that nothing else notices.

Two more worth naming for what they pin: `DeliveryLog`'s *"the same recipient on two messages is two
rows"* (a projection keyed on recipient alone passes the first GT and collapses on this one), and
`MyDrafts`'s *"revising the subject leaves the body alone"* (`SubjectRevised` carries no body, so a fold
that rebuilt the row from the latest event would silently blank it).

## B-2 — The repeated-group row shape is now demonstrated, and `state-view` is full

`DraftHistory` in `state-change/` is one row per draft carrying its **revision history inside the row**.
It needed no new events — a draft's revisions accumulate from the `SubjectRevised` events already there,
which is the cheapest possible way to show the shape.

It also exercises something nothing else did: `mappings="revisedTo=subject"` means a child field is a
**rename** of what the event carries, so a rename has to resolve *through* the group. That found a real
gap — codegen's append hint matched child fields by name and ignored `mappings=`, so the one view in the
kit that renames through a group got a blank `=> current` instead of the append line. Fixed; the hint now
reads `new Revision(e.Subject, e.RevisedAt)`.

**It lives in `state-change` and not `state-view`, and that is a finding rather than a preference.**
`state-view` is the right home for a "what one row is" comparison, and adding a tenth column took it to
**3500px, past the 3200 readability budget**. The budget did exactly what it exists for: that model is
full, and the next recipe wants its own model rather than another column. Recorded in
`reference-implementations/README.md` so the next person does not re-litigate it.

## B-3 — A view can exist with no registration, and nothing says so · **BROKEN** · ***now REPORTED***

The quietest failure in the kit. `Views/ViewRegistrations.cs` is a **scaffold** — written once, hand-owned,
kept. So a view added to the model *afterwards* gets its projection class scaffolded and **never gets a line
in `Register()`**, because that file predates it.

**There is no symptom.** Build clean, startup clean, no table created, `LoadAsync` returns null. codegen even
printed `2 views` on the line above while one of them was dark. It is the same bug the file's own header
warns about — a read-side decision lost to a scaffold — **inverted**: the decision was never made at all.

Now reported as `VIEW WITH NO REGISTRATION`, with the exact line to paste.

**And my first version of that check cried wolf on three correctly-registered views.** It matched only
`Add<XProjection>` and missed two other legitimate forms — `Add(new XProjection(), …)` by **instance**, when
configuration lives in the constructor, and `Projections.Snapshot<X>(…)` for a self-aggregating view, where
the word "Projection" appears nowhere. It accused three views in the six-recipe reference implementation on
a **fully green suite**. Only a model exercising more than one recipe could have exposed that, and it is
exactly the failure mode I had warned about an hour earlier in this same file. Fixed and tested both ways.

## B-4 — The stale-skip report had a blind spot in the mirror · ***now REPORTED***

`checkSkipFreshness` returned early unless the slice was *claimed*, so the inverse case produced no signal:
a slice left at `in-design` with **every test body filled in**. Three green tests sat dark, and the skip
count that `CLAUDE.md` calls *"the honest measure of what is left"* over-reported by three.

Now `IMPLEMENTED BUT STILL UNCLAIMED`, detected by the absence of the `NotImplementedException` stub. It
fired immediately on the newly-written `draft-history`, which is how that slice got promoted.

## B-5 — What a mutation check proved the completeness gate cannot see

Replacing `current with { … }` by `new MyDrafts { … }` in `Apply(SubjectRevised, …)` — a fold that rebuilds
the row from the latest event instead of revising it — failed **exactly one** test, the newly-added
*"revising the subject leaves the body alone"*. The pre-existing *"a revised subject replaces the old one"*
stayed green, and so did the write-side happy path.

**And the completeness check cannot catch it.** It asks whether some connected event supplies `body`, and
`EmailDrafted` does — so the model is complete while the fold silently blanks the field. *Which* event
supplies a field is a question only a fold can answer, and only a GT that says what must **not** change will
ask it.

## B-6 — Smaller, from the same work

- **Two hints that sent readers hunting for things that do not exist.** *"Set Id too if this event can be the
  first one on the stream"* — Marten sets a single-stream projection's document id from the stream id, so the
  line is dead and implies a doubt that is not real. And *"assert the read model through its endpoint"*,
  repeated six times per file, when **no read endpoint is generated for a view slice at all**. Both fixed.
- **A vacuous scaffold hole:** `SeedData` read *"Seeds only the 0 events nothing in this system produces ()"*
  with a live `TODO(codegen)` under it — an unfinished sentence from a zero-length list, which cost a reader
  a minute checking whether they had missed a step. Now says there is nothing to seed, and why that is
  normal.
- **`Marten.Events.Projections` is imported by every view scaffold** and unused in single-stream ones, with a
  `// MultiStreamProjection` comment that reads as a suggestion. Comment reworded.
- **A grouper's cache outlives `ResetAllMartenDataAsync`.** `MessageToCampaignGrouper` caches
  `messageId -> campaignId` for the store's lifetime; wiping the database cannot wipe the dictionary, so a
  messageId reused under a different campaign resolves from the stale entry — and the correcting lookup is
  skipped *because* the key is known. Measured: whichever test ran second failed with
  `Delivered should be 1 but was 0`, nothing thrown, nothing logged. A test-isolation hazard in a shipped
  exemplar, now finding #7 in `state-view/README.md`.
- **No `python` on this machine.** A scripted patch fails with a Hungarian Microsoft Store message. Use Node
  or the `Edit` tool.

## B0-FIXED — the join rule now reproduces the book's discovery

**Fixed.** A screen fed by two or more Views must share at least one attribute across all of them — the thing
it lines them up on. `joins=` declares it where it is not obvious; `joins="none"` acknowledges a screen that
shows unrelated figures side by side.

Verified against the book **both ways**, which is the only test that matters here:

- on the model as ch. 16 **fixes** it (`productId` on the cart line): **silent**
- on the model as ch. 12 **leaves** it: fires on both Cart Page cells, naming *"Cart Items and Inventories,
  which share no attribute"* and saying the key is missing from one of them **and from the events and command
  behind it** — which is the ripple the book walks through

No false positives across five models: both projects, all three reference implementations, and the fixture
suite byte-identical.

A **warning** rather than an error, because whether a screen needs to correlate is a question only a human can
answer — a dashboard showing revenue beside active users needs no join. Same house style as the Conway rule:
warn unacknowledged, note acknowledged.

**What it still does not do:** it cannot tell you that a *screen* requires a per-row correlation in the first
place. `displays=` remains a flat set of names, so *"the indicator shows stock for each cart line"* is still
inexpressible — the rule catches the missing key once two views meet on one screen, not the missing
requirement. Groups exist for read models (`children=`); the screen side has no equivalent yet.

## Accepted, not queued — the generator does not reach backwards

A generator improvement does not improve files it has already handed over, and that is **by design**. Anything
scaffolded is hand-owned from the moment it exists. The alternative — editing inside files somebody else owns —
is the one thing the emit/scaffold split exists to prevent.

What the generator owes instead is **visibility**, which is what the five reports are for. The rule for future
work: **add a report, not a rewrite.**

**The reference implementations are likewise not the generator's job.** They carry what a choice *cost* and
improve as the stack is better understood — editorial work, not generation. The right home is a future **skill
or agent responsible for keeping them current**: re-reading the docs mirror as the libraries move, re-measuring
the comparisons, folding in what later runs learn. Not built; recorded so it stays a decision.

## KNOWN GAP, TODO — no journey tests at either end

Every test the kit generates or scaffolds is **one slice's scenario**. Two classes of bug therefore have
nowhere to be caught:

- **Backend journey tests** — several slices walked in sequence through the real API. A GWT appends its GIVEN
  straight to the stream, so **no test in this kit has ever driven two commands in a row over HTTP.** That
  hides slices that pass alone and cannot be composed.
- **Playwright/browser journey tests** — a workflow across screens. The three-way field check proves a page
  shows the right fields; nothing proves you can get from the list to the modal to the created thing. The
  pager-not-in-the-URL bug was found by *screenshotting*, not by a test.

Not accepted — genuinely TODO. The single-slice discipline stays; a journey layer sits above it, belongs to
the **system** rather than any slice, and so has no owner today. Likely a `journey` skill run once two or more
slices are `in-review`, with the model naming which journeys are worth walking.

Until then, be honest about what green means: **every slice works in isolation.** Composition is verified by a
human clicking — which is why `review.mjs` and *"run it and look"* carry more weight here than they would in a
kit that had journey tests.

## T — the translation run: building the fourth pattern's reference implementation

One session, 2026-08-06. A new model (`stock-feed`, ch. 16 shaped) built with `slice.mjs`, generated, implemented
against real Postgres, mutation-checked and run by hand. **15 tests, 0 warnings, stable across repeated runs.**
Full write-up and every measurement: `reference-implementations/translation/README.md`.

**T0 — THE HEADLINE, and it is a design error of mine that a reviewer caught, not a kit defect.** The folder was
built twice. The first version **appended the foreign event to one of our own streams**, then woke a trigger off
it with a Marten subscription. It compiled, passed 15 tests, and ran correctly — and it was wrong in exactly the
way this kit exists to catch, where nothing fails and the design is still broken. Two questions undid it, and
`tools/model.mjs` answers both:

- **A foreign event belongs in its own foreign band, not ours.** It must be in *a* swimlane, but `slice.mjs`
  defaults it to whatever band exists, and accepting that default is how this started.
- **We never persist it.** `band-needs-identity` and `identity-not-on-every-event` both filter to
  `kind === "event"` and exclude `external`, with the comment *"we never start those streams, we only project
  from them."* A foreign band is exempt from `identity=` because there is nothing of ours to key. The kit had
  said so all along.

The reason it matters: an event store is **append-only**, so a foreign schema written into ours is in our history
for ever — the precise coupling a translation exists to prevent, installed by the thing meant to prevent it.

**Removing the append collapsed the pattern.** For a 1:1 translation *the arrival is the wakeup*: the notice lands
in the transport's durable inbox, a handler translates it, the decider appends the one event we own. The four
automation wakeup mechanisms all wake a trigger off events **already in our store**, so none of them applies. And
the inbox **is** the todo View — pending work with retries and dead-lettering nobody wrote. Measured: 1 event type
in the store instead of 2, one document instead of two, no async daemon, one decision instead of two, one way to
be silently dead instead of two, and a refusal that is logged synchronously instead of racily.

**A rule also came off the model.** `NoticeNotReceived` — *"a notice nothing ever delivered cannot be applied"* —
was only expressible while the notice was persisted, because it asked *"is their event in our history?"*, a
question we should never be able to answer. An implementation choice had propagated **back into the domain model
as a business rule**, where it validated, generated a test, and passed. Nothing catches that, and it is the most
uncomfortable finding of the run.

### T-FIXED — what was repaired immediately after the run

Five changes, all verified against `cart-replay.mjs` (0 errors in every round, byte-identical re-run), the four
reference models, and CPOC01 (no new findings anywhere):

| | Change |
| --- | --- |
| **`slice.mjs`** | the new swimlane is **inserted after the last existing band** instead of appended, so it can no longer paint over an event drawn inside it. T2b. |
| **`model.mjs`** | new rule **`external-in-written-band`** — warns when a foreign event shares a band with events we write, acknowledgeable with `ingested="true"` (a note). This is the rule that would have caught T0 on the first `validate` instead of after a build, a suite and a live run. |
| **`codegen.mjs`** | `SeedData`'s instruction no longer tells you to append the foreign events — it now says why doing so puts another system's schema in our append-only history *and* makes the landing mechanisms untestable. T6. |
| **`codegen.mjs`** | `GenesisData`'s instruction likewise, plus the note that it can take no constructor dependency because `Program.cs` builds it with `new`. T6. |
| **`codegen.mjs`** | the Given/Then hint now **branches on whether the slice has a command**: a View slice still gets "assert the read model", an automation or translation gets "assert the EVENT the trigger produced", with the warning that no generated test can assert anything *wakes* it. T6. |

Also documented: `ingested=` in `CLAUDE.md`'s attribute table, the rule and its acknowledgement in the swimlane
section, and the band-per-source-system instruction in `add-slice/references/translation.md`.

**What is deliberately still open:** T1 (`INGEST NOT WIRED`), T3 (`AppFixture` disabling every transport) and
T4b (`VIEW WITH NO REGISTRATION` crying wolf) — the first is a new report, the other two need a decision about
where the seam goes. T5 and T7 are grammar changes.

### T9 — Critter-stack testing support, surveyed · and one suggestion that did not survive

Prompted by "can we stub the external event?". Every API below was **compile-verified against the pinned
versions** (Wolverine 5.40.1, Marten 8.37.4), not taken from the mirror.

**You do not stub an inbound foreign message — you send it.** Wolverine ships an in-memory mediator, so
`bus.InvokeAsync(msg)` runs the real production handler with no transport at all. That is already what every
generated test does, and it is why `DisableAllExternalWolverineTransports()` in `AppFixture` costs nothing
behaviourally. It is also **the same operation** as `StubAllExternalTransports()` — the docs describe both as
disabling listeners and stubbing outgoing subscribers.

So **T3 downgrades from BROKEN to documented.** The shared fixture is right; what it cannot test is *wiring*,
which is a configuration question that deserves its own host by nature. `codegen.mjs` now says so where the
call is made.

Three genuine capabilities the kit was not using, all verified to exist:

| API | Use |
| --- | --- |
| `host.StubWolverineMessageHandling<TReq,TResp>(fn)` | the real "stub" feature — fakes a request/reply **out to** another system. Has `ClearAllWolverineStubs()` and per-type `stubs.Clear<T>()` |
| `.IncludeExternalTransports()` on a tracked session | makes the session wait on externally-sent messages |
| `.DoNotAssertOnExceptionsDetected()` / `.IgnoreFailureAcks()` | the automation folder documents a test that "passed while printing what looked like a failure"; this is the built-in answer |
| `FakeTimeProvider` | Marten has used `TimeProvider` since 7.5, so `terminal="…:clock"` values are controllable. Nothing in the kit does this yet |

**And the suggestion that did not survive.** I proposed replacing the hand-rolled polling in the automation
folder's wakeup tests with `PauseThenCatchUpOnMartenDaemonActivity()`. Built and measured: **15 green, 51s
against a 52s baseline, stable over two runs** — and then reverted, because it is wrong for *these* tests.
Those four tests exist to claim *"nobody does anything, and it fires anyway."* A helper that pauses the daemon
and forces it to catch up makes the test the thing that made it happen, which is the one claim they are there
to make. The polling loop is the instrument, not incidental machinery.

`WaitForNonStaleProjectionDataAsync` was the other half of the suggestion, and the kit **already uses it**, in
`state-view/`, where it belongs — waiting for an Async projection rather than for a downstream handler. That
file also already documents the `Marten.Events.TestingExtensions` namespace trap in nearly the words I had
written up as new. Worth recording as a caution about the survey itself: two of my four "gaps" were already
closed.

### T10 — A GWT could not carry the example data the kit told you to write · **BROKEN** · ***FIXED***

Raised by the human, from the translation gap: *"we lack a mapping between translated properties… this
reminds me of computed properties… GWTs are the correct answer. A GWT also specifies how something is
computed or translated."*

**The kit already agreed, in writing.** `add-slice/SKILL.md` had said since it was written that
`derived=` records inputs and not the formula, and that *"the formula's home is a GWT with concrete
values: `when="Send(a=2, b=3, c=4)" then="XRecorded(d=9)"`."*

**That syntax did not parse.** `names()` was `spec.split(",")`, so the commas inside the parentheses cut one
worked example into three nonexistent event names. Measured: two `gwt-unknown-event` errors from the `then=`
— and **silence from the `when=`**, because `when` was only validated on `command` slices. So half the
documented notation failed loudly and half passed unchecked.

Fixed: paren-aware parsing, `$Name` for a seed-data constant, and five new checks — `gwt-example-unknown-field`,
`gwt-example-type`, `gwt-example-malformed`, `gwt-example-on-error`, `gwt-multiple-whens` — plus `when=` now
validated on every pattern. All errors, per the standing instruction to be strict.

`gwt-example-type` closes the thread it came from: **`customerId=cus_A1` against `customerId:Guid` is now an
error**, so a foreign key passed off as ours is caught in the model rather than in production.

**And the first version was too strict in the wrong way.** It fired `gwt-example-malformed` on the cart
fixture, because the book's own event is labelled `Inventory Changed (external)` — parentheses in a *label*.
Parentheses alone no longer make example data; an `=` inside them does. A false positive is worse than a
missing rule, because it teaches people to stop reading the output.

### T10b — `derived-without-example`, and what it found on the first run

The follow-up: nothing *required* an example where one was needed. Now `derived-without-example` warns when a
`derived=` field has no worked example anywhere in its slice. It found 17 in the models this kit owns, and two
of them were real:

- **`MessageStatus`'s GWT label said "3 recipients"; the implemented test asserts 2.** The model and the code
  generated from it had drifted, and the suite stayed green — because the numbers were **prose in a label**,
  which nothing checks. One case, and it is the entire argument for structured example data over description.
- **A todo View on an automation or translation slice cannot carry an example at all.** `then=` must name an
  Event where the slice has a Command, so `then="EmailsToSend(status=…)"` is rejected two rules later. The
  first version of the check recommended exactly that — to `EmailsToSend.status` and
  `StockNoticesToApply.status`, *the two cases that motivated the whole rule*. It now says the truth instead:
  no GWT can state this today, and whether `then=` should relax for a todo View is a decision to take.

**Backfilled 15 of 17**, all of `campaigns/` — every value taken from the implemented, passing tests rather
than invented, and every one of them cleared the strict type and field checks on the first run. That model
went from 15 warnings to 0.

**Not promoted to error, and here is exactly what blocks it:** the two todo Views above (needs the `then=`
decision) and three in `tools/fixtures/cart/` (the book's own model, which states no example data — inventing
values there would be inventing domain facts). Promotion is a one-word change once those five are settled.

**And a bug worth recording about the tooling rather than the kit:** the first implementation wrote a NUL byte
instead of a space into a template literal, so the "has this field got an example?" key never matched and the
rule would have fired on every derived field, including ones with examples. It surfaced as `grep` reporting
`model.mjs` as a binary file. Caught by checking why, rather than working around it.

### T1 — The generator emits no ingest seam for a foreign event · **GAP**

It emits the event *record* and a `SeedData` TODO to append it **in tests**, and nothing in the application. So
there is no production path by which a foreign event enters the store, and **"nothing ever ingests this" is
invisible to a green suite** — the exact parallel of "nothing ever wakes this", which the kit *does* defend
against with `AUTOMATION NOT WOKEN`. Every file in `generated/src/StockFeed/Landing/` is hand-written with no
generated ancestor.

The fix in the kit's own idiom is **a report, not a rewrite**: a slice with a foreign event in one of our own
bands and no ingest seam should be named, the way an unwoken automation is. `INGEST NOT WIRED`.

### T2 — ~~The write-side fold omits the foreign event~~ · **RETRACTED**

Filed in the first pass as a generator bug: `TranslateStockNoticeState` was scaffolded with `Apply(StockLevelSet)`
only, and I hand-added a fold for the foreign event.

**The generator was right and the finding was wrong.** Filtering the write-side fold to events the system *owns*
is exactly correct, because the foreign event is never in our store. Kept here rather than deleted, because "the
scaffold looks incomplete" is going to feel like a bug to the next person too, and the reason it is not is the
whole content of T0.

### T2b — `slice.mjs swimlane` paints its band over its own events · **BROKEN** · ***FIXED***

The new band's cell is appended at the **end** of the XML. mxGraph renders in document order and a swimlane has an
opaque fill, so moving the external event into the newly added band made it **disappear from the render** — while
the model validated at 0 errors, 0 warnings.

Caught only by rendering and looking, which is exactly what that rule is for. The fix is one line: insert the band
before the elements rather than appending it. Any event drawn in a band added after it is currently invisible.

### T3 — The generated harness disables every landing mechanism · ~~BROKEN~~ · ***DOWNGRADED to documented — see T9***

`AppFixture` calls `DisableAllExternalWolverineTransports()` unconditionally, and it is `emit`. A translation's
landing mechanism **is** an external transport, so the harness the generator provides can never test the arrival
half of the pattern. `LandingMechanismTests` boots its own hosts, as `WakeupMechanismTests` already had to.

### T4 — A generated test cannot see a disconnected feed

Nothing in the model or the generated code makes an arrival happen. Every model-derived test hands the notice to
the translator itself — the production path, correctly — so a feed wired to nothing at all leaves the suite green.
Only the hand-written `LandingMechanismTests` boot a host and let the infrastructure deliver, with a control test
that makes the others mean anything.

**This is one failure mode, and it used to be two — measured before the design was fixed.** With the notice
persisted and a subscription waking the trigger, disabling that subscription left **11 of 15 tests passing**,
including `gt-translate-5`, the Given/Then written specifically to catch it: a generated test can only drive the
trigger itself, so it can prove the trigger selects its own work and never that anything wakes it. Removing the
append removed that whole class of failure — there is no separate wakeup left to be missing. Worth keeping as a
number, because it is the sharpest measurement the kit has of what a green suite does not cover.

### T4b — `VIEW WITH NO REGISTRATION` cannot tell "forgot" from "deliberately not a projection" · **BROKEN** · *open*

Regenerating the finished folder reports:

```
VIEW WITH NO REGISTRATION — 1. The projection class exists and NOTHING RUNS IT.
  StockNoticesToApply   ->   opts.Projections.Add<StockNoticesToApplyProjection>(ProjectionLifecycle.Inline);
```

The registration is absent **on purpose**: that view is a todo list realised as the transport's durable inbox, and
a Marten projection cannot fold an event that is never in our store. The report is right that nothing runs it and
wrong that anything should — and it will now nag for ever, on a folder where the omission is the design.

It also recommends adding `StockNoticesToApplyProjection`, a class that no longer exists, because it reasons from
the model rather than the code.

**This contradicts the kit's own doctrine**, which says in two places that a View need not be materialised — a
subscription's checkpoint, a durable inbox. So an unmaterialised View is legal, expected, and unacknowledgeable.

The fix is the kit's own house style, the one `joins="none"` and the acknowledged Conway split already use: **warn
on the unacknowledged case, note the acknowledged one.** Something like `recipe="none"` on the read model, or a
recognised marker in the scaffold, so a deliberate omission can be stated once and stop being reported. A report
that cries wolf stops being read — which this file already says about B2's first version.

### T5 — A foreign key that is not our key has no notation · **GAP**

`mappings=` is a rename (same value, same type), `derived=` is computed, `terminal=` comes from context. A foreign
`sku:string` becoming our `productId:Guid` is **none of the three**: it is a lookup in a correspondence table, and
a translation's whole job is exactly that. This model dodged it by sharing the product id and renaming only
`quantity` → `onHand`. A real boundary needs a fourth notation.

### T6 — Smaller findings from the same run

- **`GenesisData` can take no dependency.** `Program.cs` is `emit` and constructs it with `new GenesisData()`. A
  translation's demo data belongs on the **far side** — seeding our own stream with a foreign event makes a
  broken landing mechanism look identical to a working one.
- **There is no landing hook in `Program.cs`**, so ingest is smuggled in through the wakeup scaffold's hooks —
  two decisions, one set of seams. Same shape as B5's note about the subscription.
- **B5's `SeedData` warning confirmed on independent ground**, and it is worse than recorded: seeding the foreign
  event does not only race other slices, it makes the landing mechanisms untestable outright.
- **A GT hint is written for a view slice** — it says "assert the read model", but on an automation or translation
  the GT's `then=` must name an event. The *restriction* is correct and should stay (the todo View need not be
  materialised, so a row is machinery and not contract); only the hint is wrong.
- **`ListenForMessagesFromExternalDatabaseTable` is in `Wolverine.RDBMS.Transport`** and the doc page names no
  namespace. Found by grepping the NuGet package's own `.xml` doc file — **a faster tiebreaker than the
  `dotnet run probe.cs` reflection app `CLAUDE.md` recommends.** It lists only documented members, so absence
  proves nothing, but a hit is definitive. Worth adding to the mirror guidance.
- **`SendMessageThroughExternalTable` exists and is documented nowhere** — Wolverine's own testing helper for
  writing the row an upstream system would write.

### T7 — What held up

- **`slice.mjs` built the entire translation shape** — external, view, automation, command, event, four edges,
  two columns — with the View correctly placed *under* the processor. 0 errors, 0 warnings at first validate.
- **`AUTOMATION NOT WOKEN` fired for a translation slice** and named the file: B1's fix confirmed independently.
  It also **cleared itself** once a mechanism was chosen.
- **The generator scaffolded both projection folds**, including the tick-off edge ch. 16's own sketch omits —
  because the model drew it. Nothing checks that the second edge exists; still a rule worth having.
- **The scaffold/emit split earned its keep twice.** Both of this folder's real read-side decisions — deleting a
  projection registration, emptying the wakeup — are edits inside `scaffold` files that regeneration kept. Inline
  in `Program.cs`, which is `emit`, both would have been silently reinstated.

### T8 — B4 is retracted as well

**B4 said the wakeup decision table needed a "foreign but WE INGEST IT" row**, reasoning that the external event is
drawn inside our own swimlane with `aggregate=` set, so something of ours must append it, so every "ours" mechanism
becomes available.

**That reads the model's default LAYOUT as a requirement.** `slice.mjs` puts an external event in whatever band
exists; with one band that is ours. The identity rules contradict the inference outright — externals are excluded
from both, *"we never start those streams"*. A translation needs **no row** in that table, because its trigger event
is never in our store and the arrival is the wakeup.

The original table's answer for a foreign trigger event was *"sweep a todo View on a clock"*, and that is wrong too
— but for a different reason than B4 gave. It is not that we can hook a transaction of ours; it is that the transport
already delivers the notice to a handler, so no clock is needed unless the far side offers only a query API.

---

## B0 — THE HEADLINE (now fixed, kept because the mechanism is the lesson)

Ch. 16's whole purpose is this discovery:

> *"**We haven't modelled the 'product-id' in the system yet. This is important.** What we've just
> discovered is a mismatch in the information available long before starting the implementation. That's
> one of the major benefits of using Event Modeling!"*

Ch. 12 was modelled faithfully — **without** `productId`, which is the state the book's model is in at
that point. Then ch. 16 was appended. The kit reported **0 errors**. The book's fix was then applied —
`productId` onto the read model, the event and the command — and it reported **0 errors again**.

**The checker cannot distinguish the incomplete model from the complete one.** Two causes:

1. **It is name-based and join-blind.** `productId` on the Cart Page *was* satisfied — by the
   **Inventories** view, which carries it. The name resolved, so the check passed. But the requirement is
   *"match the product-id from the inventory **to an item in the cart**"*: a **join**, and `Cart Items`
   had no key to join on. The check asks "does some upstream supply this name", never "can these two
   sources be joined".
2. **`displays=` is a flat set of names**, so *"the indicator shows inventory **for each cart line**"*
   cannot be stated at all. Read models gained groups via `children=`; the screen side has no matching
   notion, so the requirement is inexpressible and therefore uncheckable.

**A rule that would catch it:** when a screen displays attributes drawn from two different views, require
a shared key between them. That is implementable and would have reproduced the book's discovery.

Honest scope of the claim: a human modelling this *would* still find it, exactly as the book's team did —
by asking how the indicator lines up with a cart row. What the kit does not do is find it for you, and
`CLAUDE.md` implies the completeness check is the thing that does.

## B1 — A translation slice got none of the automation machinery · **BROKEN** · ***FIXED***

`codegen.mjs` filtered wakeup generation on `s.pattern === "automation"`. A **translation** is an
automation whose source is foreign — the cheat sheet defines it as
`Event(s) (source system) → View → Automated Trigger → Command → Event(s)`, and `CLAUDE.md`'s own table
calls it *"the automation choice, plus how the foreign event lands"*.

So for the translation slice the generator emitted **no trigger message, no trigger class, no wakeup
scaffold with its decision table, no discovery registration** — and, worst, **`checkWakeupChosen` could
never fire**. The kit's one structural defence against *"nothing ever wakes this in production"* — the bug
`CLAUDE.md` says shipped once — was unreachable for the slice type most likely to need it. `Program.cs`
even asserted `// No automation slice is past in-design, so nothing needs waking` directly over a
translation slice that needed waking.

Fixed: `WOKEN_PATTERNS = new Set(["automation", "translation"])`.

## B2 — `status=` does not turn tests on after the first generation · **BROKEN** · ***now REPORTED***

`CLAUDE.md` promises: *"A slice at `in-design` has not been claimed, so its GWT tests are generated but
skipped. From `ready` onward somebody is answerable for them and they run."*

**False after the first generation.** `factAttr()` bakes `[Fact(Skip = …)]` into the file from `status=`
at scaffold time, and the test file is a `scaffold()` — so it is **kept**. Promote the slice afterwards
and its tests go on being skipped for ever, reporting `Skipped` where the entire gate depends on `Passed`.

The first project never hit it by luck: its first slice was already `ready` when generated. The second
generated everything at `in-design` and promoted later — and every test stayed off. I briefed an agent
that three tests were live and failing; they were not, and it had to notice that itself.

Now reported — `TESTS STILL SKIPPED ON A CLAIMED SLICE`, naming the file and the slice's status. Reported
rather than repaired, because by then the file is hand-owned. Note the first version of the check was a
plain substring search and produced a **false positive** on a `///` comment explaining a hand
un-skipping; it now matches an actual attribute. A report that cries wolf stops being read.

## B3 — An automation's label was used verbatim as a class name · **BROKEN** · ***FIXED***

The book writes the processor as **"Inventory Processor"**, with a space. The generator used the label
verbatim for the filename, the class and a `typeof()`, producing a file called `Inventory Processor.cs`
containing `class Inventory Processor` — **eleven compiler errors**.

Latent for the whole life of the kit, because every model that ever had an automation happened to use a
single-word label (`EmailProcessor`). A different domain found it in one build. Now `pascal()`-ed.

## B4 — The wakeup decision table has a missing row, and it is the translation row · ***RETRACTED — see T8***

> **Retracted by the translation run.** Its premise — that the external event sits in one of *our* swimlanes, so
> something of ours appends it — reads `slice.mjs`'s default layout as a requirement. The identity rules exclude
> externals precisely because *"we never start those streams"*. A translation needs no row in this table at all:
> its trigger event is never in our store, and the arrival is the wakeup. The section is kept unedited below
> because the reasoning is instructive and it is what the code was built against for a while.

`CLAUDE.md`'s table routes *"the trigger event is **foreign** — we never append it"* to **sweep on a
clock**, on the grounds that *"there is no transaction of ours to hook"*.

**That premise is false for a translation.** The model draws the external event inside *our own* swimlane
with `aggregate=` set — an event's y is its stream — so something of ours has to append it. Once we do,
every "ours" mechanism is available again. The table has no row for *a foreign event that is ingested
first*, which is the normal shape of a translation.

The implementing agent chose a Marten `ISubscription` and gave the reason the table should have: the black
box *"notifies us whenever a change in inventory occurs"* and never re-sends, so a dropped notification
leaves the recorded stock level permanently wrong — and the rule at stake is *"we must not sell items that
are not in stock"*. Durability wins; a checkpoint is a row in the database. Cost stated: the async daemon,
and that test waits rather than asserts.

## B5 — Smaller findings from the same run

- **A generated comment contradicted the line beneath it.** `Program.cs` said *"Every stream in this
  system is keyed by a composite of model fields, so stream ids are strings"* immediately above
  `StreamIdentity.AsGuid`. Hard-coded prose from the model the generator was written against. **Fixed** —
  it now derives from the keys and says which case applies.
- **No decider is scaffolded, for any pattern.** codegen emits the command record and the state fold and
  stops. *"The endpoint is the decider"* — the sentence the whole design rests on — has no file to live
  in. Two projects in, the handler is hand-written every time.
- **`Program.cs` is `emit` with no scaffold hook** into `UseWolverine` or `builder.Services`, so a
  subscription had to be smuggled in through `ViewRegistrations.ConfigureStore` — the *read-model
  registration* file — because it was the only scaffold reaching the Marten chain.
- **A test hint assumes surface nobody generates.** Both GT scaffolds said *"assert the read model through
  its endpoint"*. codegen emits no read route for any view.
- **`SeedData`'s scaffolded instruction is actively wrong for a woken slice** — it says to append the
  foreign events onto their streams, which for a translation means every test starts with a notification
  the subscription then translates, appending into streams other tests assert on.
- **`AppFixture` sets `Automation:Wakeup=false` and is `emit`.** Honour it and the "nobody asks" test is
  unpassable; ignore it and the setting is a lie. Its own comment says it is about a *clock*; the kit
  should say so, because conflating clock with wakeup makes the one test that matters untestable.
- **`appsettings.json` hard-codes port 5433 and is `emit`**, and no `docker-compose.yml` is generated,
  though `CLAUDE.md` and the agent briefs both tell you to run one.
- **The mirror was wrong again.** `guide/handlers/discovery.md` writes `[Wolverine.WolverineHandler]`; it
  is `Wolverine.Attributes.WolverineHandlerAttribute`. Also: the documented `dotnet run probe.cs`
  tiebreaker needs `#:property PublishAot=false` for anything touching Marten, **and** plain
  `Assembly.LoadFrom` + `GetExportedTypes()` throws in a file-based app.
- **A todo View has no tick-off edge and nothing checks for one.** The model draws
  `external → todo view` and not `own event → todo view`, so as drawn the list can only grow. A checkable
  rule the kit lacks: *a view a trigger watches, with no edge from that trigger's own output event, is an
  incomplete todo list.*

## B6 — What held up, on ground it had never seen

Worth as much as the failures, and all measured:

- **`slice.mjs` did every bit of geometry.** It refused to add a slice without `--aggregate` once a second
  swimlane existed, then built the entire translation shape — external, view, automation, command, event,
  four edges, across two columns — and knew a translation begins with an external event.
- **`children=` held on independent ground.** Fig 12.7 *is* a cart holding lines plus a total, and
  `derived="totalPrice=price"` resolved through the group.
- **Codegen took an unseen model to 0 warnings, 0 errors** — translation slice, external event, two stream
  types, a nested-group view — correctly labelling the foreign event as foreign.
- **The automation's Given/Then generated a live test**, which was impossible before this session.
- **`status=` skipped everything correctly on the first pass**: 7 tests, 7 skipped.
- **The "nobody asks and it still happens" test is real**, measured by deletion: commenting the wakeup out
  failed **exactly one** test and left the other two alone.
- **Three unasked runs against real Postgres**, with the tick-off working (1 outstanding, not 3) and
  exactly one internal event per notification.

---

## A. Findings — the first run (CPOC01)

### A1 — `design.mjs` mobile screenshots were lies below 500px · **BROKEN** · ***FIXED***

**Fixed.** `tools/shoot.mjs` is now the single capture path, shared by `design.mjs` and the new
`review.mjs`, and it renders any width under 520px inside an `<iframe>` of that width — which gets a real
layout viewport. Verified by probe: a 390px capture now reports `innerWidth=390`, where it reported
`innerWidth=500` before. Verified again on real content: the `new-recipe` mobile shot that previously
showed the primary button clipped to "Crea" now shows the whole dialog, same CSS untouched.

Sharing the capture path buys the other thing that matters — a design shot and an implementation shot are
only comparable if they were taken the same way.

The original finding, kept because the measurement is the useful part:

The worst one, because the kit's own governing rule is *"never hand over anything you have not
rendered"*, and this silently breaks the half of that rule that matters most.

**Measured, not suspected.** `chrome --headless=new --window-size=390,200` reports
`window.innerWidth = 500`. Windows will not make a real window narrower than ~500px, so Chrome lays the
page out at **500** and then crops the screenshot to the requested 390.

Every sub-500px shot the kit has ever produced is therefore a **crop of a 500px layout**. It invents
right-edge clipping that does not exist, and it will equally hide clipping that does.

**What it cost:** a wrong diagnosis during styling. The `new-recipe` modal appeared to overflow at
390px; two rounds of CSS "fixes" followed; the page had been correct all along. Confirmed by rendering
it in a 390px `<iframe>` inside a 500px window, where it fitted perfectly.

**Fix.** Either render the page in a 390px-wide `<iframe>` inside a ≥500px window — an iframe gets a
real layout viewport, verified working and used for every mobile shot in this run — or drive
`Emulation.setDeviceMetricsOverride` over CDP. **`--headless=old` is not an option**; modern Chrome
ignores it and silently gives you `=new` (both invocations produced byte-identical output).

Until it is fixed, `tools/design.mjs`'s own help text should say the mobile shot cannot be trusted.

---

### A2 — A read model cannot hold structured children · **GAP** · *mechanism now PROVEN, kit change specified*

**PROVED BY RUNNING IT.** `scratchpad/nested-poc/poc.cs` — real Marten 8, real Postgres, its own schema,
twelve checks, all passing. One `SingleStreamProjection<RecipeDetail, Guid>` holding
`List<IngredientLine>`, fed by `RecipeCreated` **and** `IngredientAdded`, appending in
`Apply(IngredientAdded e, RecipeDetail current) => current with { Ingredients = [.. current.Ingredients, new IngredientLine(...)] }`
— the shape `aggregate-projections.md` documents for `QuestParty`.

What the run settled, beyond the bare claim:

| Check | Result |
| --- | --- |
| a brand-new recipe, no ingredients yet | row exists, `Ingredients` is **empty, not null** |
| two ingredients in **two separate transactions** | accumulate into one row — Inline really does fold across appends |
| the header after ingredient appends | intact |
| `decimal` amount, `string?` description | round-trip (3.5, and null) |
| append order | preserved |
| **query INTO the collection** | works — `where d.data -> 'Ingredients' @> :p0`, JSONB containment |
| **full projection rebuild** | reproduces the list exactly |

**So both of my arguments against the single box were wrong.** "A brand-new recipe would have no row"
applies to the *one-row-per-line* shape, not to a nested list — I carried the objection across from the
wrong candidate. And "a separate flat view is needed to query the lines" is answered by JSONB containment.
The human was right that the stack has no such limit, and said so with full confidence.

**The remaining limitation is entirely the kit's, and it is now a specification rather than a complaint:**

1. **`parseFields` must accept a collection of a declared child type.** Proposed, and it reuses the
   existing `name:Type` grammar rather than inventing one — a **`children=`** attribute on the read model
   cell:
   ```
   fields="recipeId:Guid, name:string, description:string?, servings:int, prepTimeMinutes:int, ingredients:IngredientLine[]"
   children="IngredientLine: ingredientName:string, amount:decimal, unit:string"
   ```
   `identity=` is unchanged — `recipeId`, one row per recipe.
2. **`codegen.mjs` must emit the child record**, and the projection scaffold must fold an event into a
   collection member. The PoC is the template for both.
3. **The completeness check must flatten children** when resolving a screen's `displays=`, so
   `displays="ingredientName"` is satisfied by `ingredients:IngredientLine[]`. Without this the phase-7
   gate fails on a correct model.
4. **`then=` on a GT can then name one View** for the detail page instead of two — see A7's closing note.

Then re-model `recipe-detail` with a single green box and delete `RecipeIngredients`.

**Incidental finding, worth its own line because `CLAUDE.md` recommends the technique:** a .NET 10
file-based app (`dotnet run probe.cs`) **cannot run Marten** without
`#:property PublishAot=false`. File-based apps disable dynamic code generation, and Marten's
`StoreOptions` constructor reaches `Reflection.Emit` via `JasperFx.Core.Reflection.LambdaBuilder`, failing
with `PlatformNotSupportedException: Dynamic code generation is not supported on this platform`. The
tiebreaker the kit recommends is broken for anything touching a Marten store until that directive is
documented.

`parseFields` (`tools/model.mjs:85`) is a flat `name:Type` split with no nesting, and there is nowhere
to declare a child record type. The only collection the kit has ever generated is a **primitive array**
(`recipients:string[]`, in `reference-implementations/state-view/`), which works only because
`string` needs no declaring.

**What it forced.** The `recipe-detail` slice was drawn with **two** green boxes — `RecipeDetail` (one
row per recipe) and `RecipeIngredients` (one row per ingredient line) — because a detail page showing a
recipe *and its ingredient lines* cannot be expressed as one view. The human considers that split a
modelling anti-pattern and is right; the limitation is the kit's, not the stack's.
`SingleStreamProjection<RecipeDetail, Guid>` folding `IngredientAdded` into `List<IngredientLine>` is
idiomatic Marten.

Note also what killed the *other* workaround: one row per ingredient line would leave a
just-created recipe with **no row at all**, and the create flow redirects straight to its detail page.

**Four things must change before one green box is legal:**

1. `parseFields` must express a structured child — `ingredients:IngredientLine[]` plus somewhere for
   `IngredientLine`'s own fields to live.
2. `codegen.mjs` must emit the child record type. Today an unknown type passes through verbatim, so
   `IngredientLine[]` compiles into a reference to a type nobody generated.
3. The completeness check must resolve a screen's `displays="ingredientName"` **through** a collection
   field. Today it matches flat names only, so a nested view would fail the phase-7 gate.
4. The projection scaffold must fold an event into a collection member rather than a row.

Then re-model that slice with a single view. **See also B2** — the human wants the rule written down
independently of the mechanism.

---

### A3 — The test host reports `Development`, and the demo seed leaked into every test · **WRONG**

`CLAUDE.md` and Alba's own `gettingstarted.md` both imply the test host is Production. Alba's docs state
outright: *"Alba does not do anything to set the hosting environment."*

**It does.** A probe inside this suite's own host measured:

```
PROBE EnvironmentName=[Development]
PROBE ASPNETCORE_ENVIRONMENT=[]
```

So a `GenesisData` gated the obvious way — `if (builder.Environment.IsDevelopment())` — attaches in
tests, and `ResetAllMartenDataAsync()` re-applies it before every one. First run after seeding 24 demo
recipes: **`Failed: 14, Passed: 15`**, including all eight previously-green `create-recipe` tests.

Worse in general: this silently activates **every** `IsDevelopment()`-gated line of production code
inside the test suite, not just seeding.

**Worked around** by gating `GenesisData` on the *process* variable
(`ASPNETCORE_ENVIRONMENT` / `DOTNET_ENVIRONMENT`), pinned by a test. **The proper fix is one line** in
`AppFixture.cs` — `builder.UseEnvironment("Testing")`, exactly as Alba's docs show — but that file is
`emit`, so it must be fixed in `codegen.mjs`.

**Consequence for the Docker app:** because the gate now reads the process variable, the `api` service
*must* set `ASPNETCORE_ENVIRONMENT=Development` or the demo comes up with an empty recipe box and no
error explaining why. Commented at the line in `docker-compose.yml`.

---

### A4 — `CLAUDE.md`'s `emit` row is stale: views are `scaffold` · **WRONG**

The emit/scaffold table lists *"event records, view **types**, csproj, Program.cs"* as `emit`. The
generator writes `Views/*.cs` with the `<auto-generated-scaffold>` banner — verified by reading them.
They are **kept**, not overwritten.

This matters twice: a hand edit in a view file *is* durable (I told the human the opposite mid-session
and had to correct it), and the table is the document people reason from when deciding whether a fix
will survive.

---

### A5 — Nullable fields make the build warn, and the "0 warnings" claim is model-dependent · **WRONG**

`CLAUDE.md` states *"`dotnet build` succeeds with 0 warnings"*. True only for a model with **no nullable
field**. CPOC01 declared `description:string?` and got `CS8669` twice —
Roslyn disables nullable annotations in files it recognises as generated unless the file carries an
explicit `#nullable` directive.

**And the banner does not save you: `// <auto-generated-scaffold>` trips the same heuristic as
`// <auto-generated>`.** Found by an agent when adding a nullable to a scaffold, not by reading. So the
fix must stamp `#nullable enable` on **both** banners, and any agent filling a scaffold with a nullable
field trips it meanwhile.

---

### A6 — A rule cannot choose its HTTP status · **GAP**

`Rejections.Problem` hard-codes `statusCode: 400`, and `codegen.mjs:735` writes test comments that
assume 400 (*"expect a 400/ProblemDetails for …"*).

CPOC01's `RecipeNotFound` wants **404** — the path names a recipe that does not exist. Reaching it needs
a status argument on the helper plus a hand edit in the (scaffolded) endpoint.

**The trap worth recording alongside it**, already paid for in
`reference-implementations/state-change/`: the *obvious* route to a 404 —
`[WriteAggregate(..., Required = true)]` — produces a **framework** 404 carrying no `ProblemDetails` and
no rule name, which makes the GWT unassertable, and on the message path the handler logs and
**discards**, so the rule silently ceases to exist. A deliberate
`Results.Problem(title: rule, statusCode: 404)` is fine; the framework's own 404 is not.

Helpfully, the generated harness calls `IgnoreStatusCode()` and asserts on `Title`, so a chosen status
costs nothing in tests.

---

### A7 — Nothing ever asks a View slice for its Given/Thens · **NOISE**

**Filed twice and wrong twice. The corrected version is here; the two wrong ones are recorded below,
because how they were wrong is the more useful lesson.**

Filed first as *"a State View slice generates no tests"*, then re-filed as *"the kit cannot express a
Given/Then, four rules block it"*. **Both overstated it.** The kit expresses GTs and generates tests
from them **today**, unchanged. Proven, not reasoned: five GTs were added to `recipe-list`, the model
validated at **0 errors**, and `codegen` went from *17 tests across 2 slices* to *22 across 3*, emitting
a live `[Fact]` per GT.

**What was actually wrong with my reading.** I cited rule line numbers without reading their guards:

- `gwt-needs-when` (`model.mjs:647`) sits inside `if (s.commands.length)`. A view slice has no command,
  so **it never fires**.
- The `then=` resolver (`model.mjs:675`) already has
  `if (!s.commands.length && el?.kind === "readmodel") continue;` — a `then=` naming a **read model** is
  already legal, with the comment *"On a State View slice the outcome is the View's contents, not an
  event."*
- `codegen.mjs:699` iterates **every** slice with GWTs, and `:704` already handles
  *"no command in this slice, so no stream is written"*.

So somebody wrote this deliberately and it works. The remaining defects are small:

1. **`slice-needs-gwt` warns for State Change slices only** (`model.mjs:629`), so nothing ever *asks* a
   view slice for its GTs — which is exactly why `recipe-list` reached `in-review` without any. This is
   the whole of the real finding. The books say *"don't save on them. They are the real treasury in
   Event Models."*
2. **The generated scaffold prints `WHEN (nothing)`** for a GT. A GT has no WHEN *by definition*, not a
   WHEN that happens to be empty. Misleading in the one place an implementer reads.
3. **The stream-key hint is wrong for a GT**: *"no command in this slice, so no stream is written."* True
   of the slice, false of the test — a GT's GIVEN events must be appended to *some* stream, so this is
   the one hint the implementer actually needs and it says there isn't one.
4. Banners and skill wording say "GWT" throughout where they now mean GWT-or-GT.

**And a lesson worth more than the finding** (see C11): I twice reported a capability as missing after
reading source without executing it. The kit's own rule — *"read the mirror first, then compile"* —
applies to the kit itself. One `validate` run would have settled it in seconds either time.

---

### A7b — What the books actually say about GTs, and why the web is worse than useless here

Kept as its own entry because the quotations are the reference, independent of A7's tooling verdict.

**What the books say.** *Understanding EventSourcing*, ch. 3:

> *"If you want to describe how a Read Model projects data to a view, you typically do not use GWTs but
> **GTs (Given - Then)**. Read Models only rely on previously stored events, so there is **no 'When' part
> necessary**."* — Fig 3.15, captioned *"Given / Then for Read Models"*

Ch. 13 repeats it and **widens it to automations**:

> *"For read model **and automation** tests, the 'When' step is typically omitted, leaving a 'Given /
> Then' scenario. In such cases, it's sufficient to put the system into the desired state and verify that
> the read model shows the correct information."*

Worked, in ch. 13:

> *"GIVEN an 'Item Added' event, THEN we expect the Read Model to show one item."*
> *"GIVEN an 'Item Added' event followed by an 'Item Removed' event, THEN we expect the Read Model to
> show no items."*

And it goes further than the kit does anywhere — *"we can even extend the scenario with clear example
data… If I add an item priced at '5,00 €' I expect the total price in the Read Model to be '5,00 €'."*

*The Little EventModeling Book* is blunter still. Under State View, *"How to test?"* → **"Scenario is
always a 'Given / Then' (skipping the 'When' Part)"**. Under Automation it gives two: **GT** for the
infrastructure half (*"Given these 2 Events, we expect the automation to run automatically, make the
external API call and result in another Event"*) and **GWT** for the domain half.

**A warning about the online sources**, since they were consulted first and were wrong. The
eventmodeling.org cheat sheet does not cover specifications at all. Two search results asserted a WHEN
for view scenarios — one *"When the view is queried"*, the other *"When = one new event, Then =
resulting projection state"*. Both contradict both books. **Prefer the local extracts** in
`reference/eventmodeling-and-eventsourcing.txt` and `reference/the-little-eventmodeling-book.txt` — they
are the authority and they are already on disk. Searching the web for this cost time and produced a
wrong answer.

**One open question the books do settle and the kit does not implement:** `enforce=` is meaningless on a
GT. There is no command, so nothing can reject anything, and `periphery` / `aggregate` should be an error
on a GT rather than silently defaulting to `aggregate` — which is what happens today.

Note the interaction with **A2/B2**: `then=` naming *one* View is a clean rule only while a screen is
fed by one View. The `recipe` detail page is fed by two, so a GT about "the detail page" would have to
name both — another way the A2 workaround leaks.

---

### A8 — `wireframe.mjs` draws every screen title twice · **NOISE**

`tools/wireframe.mjs:143` emits a chrome cell carrying the screen's own `label`, which the screen box
already renders at the top with `verticalAlign=top`. Every scaffolded wireframe overlaps its own title.
One-line fix: do not emit the title cell. Worked around by hand in the CPOC01 model.

---

### A9 — Testcontainers' obsolete constructor · **NOISE**

`CS0618`: the parameterless `PostgreSqlBuilder()` is obsolete; use the image-parameter constructor.

This is exactly the gap `codegen.mjs` predicts about itself — *"Testcontainers is not in
`reference/llms/`, so that harness is the one part written from unverifiable knowledge."* Every other
generated file cites a mirrored page. The self-awareness is correct and the prediction came true; the
lesson is that the docs mirror should probably grow a fourth library.

---

### A10 — `Program.cs` is `emit`, so two runtime settings cannot be reached · **GAP**

Both surfaced as real problems and neither can be fixed from a scaffold:

- **No `UseLightweightSessions()`** → Marten's `DefaultSessionFactory` logs a warning on *every*
  session.
- **No `RejectUnparseableQueryValues`** → Wolverine returns `default(T)` for both a *missing* and an
  *unparseable* query value, so `?page=abc` silently becomes page 1. The `recipe-list` endpoint had to
  bind every parameter as `string?` and parse by hand to get a 400.

Either `Program.cs` needs a scaffolded hook (as `ViewRegistrations.cs` already has for the read side),
or these belong in the emitted default.

---

### A11 — `codegen` scaffolds no endpoint for a State Change slice · **GAP**

`CreateRecipeEndpoint.cs` had to be created from nothing. Not obviously wrong — an endpoint is pure
judgement — but the emit/scaffold table implies endpoints are scaffolded, and "scaffold" normally means
"a file exists with holes in it". Either generate a stub or say plainly that this file is the
implementer's to create.

---

### A12 — Mirror gaps and contradictions found by compiling or reflecting

Each cost real time. Recorded so they are not re-discovered.

| Fact | How it was settled |
| --- | --- |
| `MartenOps.StartStream` is **generic-only** — five overloads, all `StartStream<T>`; `AggregateType` is on `IStartStream`. The mirror never says the type parameter is mandatory, while Marten's own `events/appending.md` offers an untyped `session.Events.StartStream(id, events)` | reflection over Wolverine.Marten 5.x |
| `(IResult, IStartStream)` works as a return tuple. Docs show `(TResponse, IStartStream)` and `(IResult, Events)` separately, never combined | compiled and run |
| Alba *does* set the hosting environment (A3) | probe inside the test host |
| `AppFixture`'s generated comment says *"Marten attaches any `IInitialData` in the container"*; `CLAUDE.md` says only `.InitializeWith(...)` does. **Unresolved** | contradiction noted, both avoided |

**This is the mirror-then-compile rule earning its keep**, and the general lesson stands: the mirror
removes most of the guessing, not all of it. Reflection over the assembly with a `dotnet run probe.cs`
file-based app remains the tiebreaker.

---

## B. Three standing reminders, requested explicitly

### B1 — A State View slice takes a **Given/Then**, not a Given/When/Then

**There is no WHEN, because there is no command.** A read model only ever reads events that already
exist, so the specification is:

```
GIVEN a set of events   THEN the read model shows <this>
```

This is not an open question — both books state it outright, and the little book says a State View
scenario is **always** a GT. Quotations in **A7b**.

**The kit already supports this.** A `gwt` cell with `given` + `then` and **no `when=`**, on a slice with
no command, validates and generates a live test. It stays `em="gwt"`; the absent `when=` is what makes it
a GT, which mirrors how the book presents it — a GWT with the middle step omitted, not a different
animal. What was missing is only that nothing *prompts* you to write them (A7).

**It applies to automations too**, in halves: GT for the infrastructure half (*given these events, the
automation runs and produces that event*), GWT for the domain half of the command it issues.

**The test shape**, which is the whole point of writing the GT down:

1. **GIVEN** — append the events. Concrete example values, from `SeedData`, not placeholders. Ch. 13 is
   explicit that a scenario should carry real data: *"If I add an item priced at '5,00 €' I expect the
   total price in the Read Model to be '5,00 €'."*
2. **THEN** — assert **through the read endpoint**, not against the document store, and assert on the
   actual data: which rows, in which order, with which values.

**Asserting through the endpoint rather than the document is measurably stronger, not just tidier.**
Proven on the first GT written: the stored `Views.Recipes` document has **five** members, because the
generator sets `Id` *and* `RecipeId` from the same value for every view; the wire has **four**. So
asserting that a row's property set is exactly `recipeId, name, servings, prepTimeMinutes` — against the
raw JSON, via `JsonDocument`, not a deserialised DTO — pins two things a `session.Query<Views.Recipes>()`
assertion cannot see at all: that the duplicate `id` is withheld, and that the casing is camelCase.

Assert on the **raw body**, for the same reason. A DTO silently absorbs an extra field, a missing field
and a renamed one. Check for the absent field's **key and its value** — a value found under a renamed key
is still a leak.

Trade-off to know: paging and sorting are not expressible in the model (C7), so a GT test necessarily
touches un-modelled surface. Worth having, but it means the GT does not fully specify its own test.

**Mutation-check a GT rather than trusting it green.** The "what the view ignores" GT was verified by
temporarily adding `Apply(IngredientAdded e, Recipes c) => c with { Servings = 999 }` to the projection:
it failed **that test and nothing else**, which is the right blast radius. A green test proves nothing
about what it would catch.

**Write the GTs before implementing, not after.** `recipe-list` was built first and given its GTs
afterwards, which walked straight into `ANTI-PATTERNS.md` #13: five GTs added to an
already-`in-review` slice generated five live `[Fact]`s nobody had written, and the suite went from
`Failed: 0, Passed: 29` to `Failed: 5, Passed: 29`. Correct behaviour, avoidable cost.

**Two kinds of test, and keep the line clean:**

| | Where | Covers |
| --- | --- | --- |
| **generated from GTs** | `tests/…/Slices/<Context>/<Slice>Tests.cs` — codegen owns the filename | the projection contract: which events feed the view, what one row is, what a row carries, what the view *ignores* |
| **hand-written** | `tests/…/ReadModels/<View>ReadTests.cs` | what the model cannot express — paging boundaries, sort orders, bad parameters (C7) |

The second file must not use the first's filename, or codegen will claim it the day the slice gains a GT.

**A GT that specifies what the view IGNORES is the one worth writing above all others.** *"GIVEN
RecipeCreated then IngredientAdded, THEN the list still shows one unchanged row"* asserts that `Recipes`
is fed only by `RecipeCreated` — which the drawing already says, and which is the single thing a
projection can get wrong that no other test would notice.

### B2 — Multiple green boxes feeding one screen is a smell

**One screen should be fed by one View.** When a page needs two or more green boxes, treat it as a
signal that the *model* is working around a tooling limit rather than describing the domain.

CPOC01 has exactly this: the `recipe` detail page is fed by `RecipeDetail` **and**
`RecipeIngredients`. The reason is A2 — the kit cannot express a view holding structured children — and
the human's verdict is that the split is an anti-pattern to be undone once the kit can express it.

Distinguish the two cases carefully:

- **One screen, several views** → a smell. Ask why one view cannot answer the screen.
- **One view, several screens** → also a smell, but a *different* one, and it was rejected earlier in
  this same session: `Recipes` originally fed both the list page and the detail page's header. Two
  independently evolvable features must not share a read model. Each screen's feature owns its own
  view, even when the two views are shaped identically today.

The checker sees neither. Both are review questions.

### B3 — Screenshots must be of the built software, not only of the design · ***TOOLED***

**Now enforced by `tools/review.mjs`**, so it is a convention rather than something somebody remembers.
Shots land in `<project>/review/` — gitignored, like `designs/_shots/`, because they are regenerable
evidence rather than source — and `review/index.html` puts the **agreed design beside the built
software**, same screen, same width, 1:1. `review/_shots/review-sheet-<viewport>.png` is the whole set in
one image. Wired into the `codegen` skill's gates and into the `frontend-agent` definition, which now
calls the tool instead of raw Chrome.

**It found a defect within a minute of existing**, which is the argument for it: shots of `/` and
`/?page=2` came back **identical**. The pager is component state and never reaches the URL, so a page
cannot be linked, bookmarked, or survive a refresh. Nothing in 32 passing tests had noticed, and no design
page could have shown it.

Row heights in both contact sheets now come from the PNG headers rather than from `--height`. Guessing
crops the tallest row, and a design page carrying a States panel is routinely taller than the built screen
it is compared against — the first sheet this tool produced had exactly that defect, plus every
implementation image broken because a bare filename cannot resolve from the temp directory the sheet HTML
is written to. Both caught by looking at it, which is the rule this entry is about.

The standing obligation, unchanged:

*"A design nobody has looked at is worth as much as unrendered XML"* — and a **static design page is
not the software**. The full obligation is:

1. **The static design**, via `tools/design.mjs sheet`. Catches layout and token defects early.
2. **The running frontend**, driven so that every state is actually reached — populated, empty,
   loading, rejected, in-flight, stale — not just the happy path.
3. **The deployed artifact.** For CPOC01 that meant Chrome pointed at `http://localhost:8080`, served
   by nginx out of the Docker image, hitting the API container through the real proxy.

Step 3 is the one most easily skipped and the only one that exercises the real path. Things it catches
that nothing else can: a wrong `proxy_pass` prefix (the API answers 404 and the browser shows an
**empty list with no error**, because a 404 body is not a paged result), a missing environment variable
that leaves the seed unapplied, and a runtime that cannot do Wolverine's codegen.

And subject every one of those shots to **A1** — below 500px they are not what they appear to be.

---

## C. Lessons learned

**C1 — Rendering and looking caught a real defect at nearly every phase.** Not one of these was visible
in the source: two bad edge routes crossing boxes; every wireframe title drawn twice; the table header
sitting on the title rule so the two read as one smudge; a prep-time column of bare numbers with the
unit stated nowhere (`1440` making the reader do arithmetic); a disabled Cancel button that looked
completely live; a double hairline in an error state; and a state that was silently *not being
rendered* at all, so its screenshot was of the wrong thing.

**C2 — A claim is not a verification, and the discipline paid.** Both agents reported green; every
gate was re-run independently, plus scope checks that `diagrams/` and `designs/` were untouched, a hash
check that the ported `tokens.css` had not forked, and a `codegen` re-run to prove hand-filled files
survive regeneration. Everything held — but the seed leak (A3) was found *only* because the agent was
told to verify an assumption rather than trust two documents that agreed with each other.

**C3 — The emit/scaffold split works.** Re-running `codegen.mjs` after both slices reported
`10 written, 12 kept` and the suite stayed green. That is the property the whole design exists to
protect, and it held under a real edit.

**C4 — `status=` is worth more than it looks.** `Failed: 8, Passed: 0, Skipped: 9` after generation, and
`Passed: 29, Skipped: 9` two slices later. The skip count is an honest measure of remaining work, and
it is only honest because unclaimed slices skip rather than fail.

**C5 — Deciding the stream key early paid for itself, twice.** `identity="recipeId"` was chosen because
*"you can't list the same ingredient twice in one recipe"* is only a true invariant if one stream holds
the whole recipe. The same reasoning ran in reverse for names: recipe names are deliberately **not**
unique, and with a per-recipe stream a uniqueness rule would not have been enforceable anyway. One GWT
now asserts the *absence* of that rule.

**C6 — A dictated brief needs a gap list, and the gaps were real.** The brief never said whether
`description` was required, whether names were unique, whether a recipe could be deleted, or what a
list row shows. All four were asked. `RecipeDeleted` was drawn `proposed=` and dashed, and was correctly
never confirmed.

**C7 — Query capabilities have nowhere to live, and that is fine as long as it is said out loud.**
Paging, sorting and filtering are not expressible on a cell — `fields=` says what a row holds,
`identity=` says what a row *is*, neither can say "sortable by". They were carried in cell notes, in
`OPEN-QUESTIONS.md`, and handed to the implementing agent verbatim. The human's framing is the right
one: *"the event model is about business knowledge, and paging is not that."*

**C8 — `/api` behind a proxy, decided before either agent wrote code, removed a whole class of work.**
The frontend calls a relative `/api/…` path; Vite and nginx both rewrite it. One build runs in
development and in Docker with no rebuild, no environment variable, and **no CORS at all**.

**C9 — Terminology drifted from the tooling.** The human uses the canonical **State Change** / **State
View**; the validator's `pattern=` vocabulary is `command` / `view` / `automation` / `translation` /
`upstream`. The prose in `CLAUDE.md` already says "State Change slice". Renaming the attribute is a
kit-wide change across three tools, four skills and `CLAUDE.md` — see D2.

**C11 — I twice reported a capability as missing after reading source without running it.** A7 was filed
as "views generate no tests", re-filed as "four rules make a GT unrepresentable" with line numbers, and
was wrong both times: `gwt-needs-when` sits inside `if (s.commands.length)` and the `then=` resolver
already accepts a read model. **One `validate` run settled it in seconds** — and it was only run because
the human asked for verification against the books, not because the claim was doubted.

The kit's own rule is *"read the mirror first, then compile"*. It applies to the kit itself: **grep is a
hypothesis, execution is the answer.** Citing a line number reads as evidence and is not — a guard three
lines up inverts it. Before filing any "the kit cannot do X", write the smallest X and run it.

**C10 — Cost per slice, the number that says whether this kit works.**

| | `create-recipe` (State Change) | `recipe-list` (State View) |
| --- | --- | --- |
| Generated files | 22 written, 0 kept | 10 written, **12 kept** |
| Hand-written / filled | 4 | 5 |
| Build iterations | 1 | 2 |
| Test iterations | 1 | 3 (one spent discovering A3) |
| Tests | 8, all generated | 21, **none** generated |
| Frontend `tsc` iterations | 2 | 4 |
| Render iterations | 1 | 4 |

The second slice cost *more*, and both reasons are informative rather than discouraging: it was the
first State View slice (no generated tests, A7) and it uncovered a latent kit bug that had been sitting
there all along (A3).

---

## D. To confirm with the human

Parked deliberately during the run.

**D1 — Merge the `recipe-detail` slice's two views into one.** Agreed as the goal, blocked on A2.
Sequencing agreed: fix the kit, then re-model the slice.

**D2 — Rename `pattern=` to the canonical terms?** `state-change` / `state-view` instead of
`command` / `view`. Kit-wide: `model.mjs`, `slice.mjs`, `codegen.mjs`, four skills, `CLAUDE.md`, and
every existing model and fixture.

**D3 — The max lengths were delegated, never confirmed.** `name` ≤ 200, `description` ≤ 1000,
`ingredientName` ≤ 100, `unit` ≤ 20. All four are live GWTs and generated validators.

**D4 — Prep time: raw minutes or formatted?** The list shows `1440` with the unit in the header,
`Prep (min)`. Chosen for a dense right-aligned numeric column that reads as sortable; `24 h` would be
friendlier and would cost the alignment.

**D5 — Should the modal dim the list behind it?** The design's ground is opaque, because the static page
had no list to sit over. With a real page behind, the modal reads as navigation rather than as an
overlay. A translucent scrim is an aesthetic call and belongs to a `styling` session.

**D6 — `sort=name` was added beyond the brief.** The human named `servings` and `prepTimeMinutes` only.
The *default* order has to be expressible as a query value or the UI can never return to it after
sorting. No new field, no new rule; only Servings and Prep are clickable in the UI.

**D7 — Is `unit` really free text?** Free text for this release, with "not empty" and a max length. A
fixed list makes it an enum and adds a rejection rule.

**D8 — Fix A1 now rather than later?** It is queued with everything else, but it is the one finding that
makes a *current* kit capability untrustworthy rather than merely absent.

---

## E. What was measured and held

Recorded so the next run knows what it can rely on.

- **The bilateral draw.io link.** Plain-file edits appear in an open tab with no reload and no prompt;
  a merge does not falsely dirty the tab; concurrent edits lose neither side.
- **`codegen` is total and idempotent** — C3.
- **`Inline` read models are genuinely immediate.** A `201` and the very next fetch shows the row, with
  no daemon, no retry and no optimistic UI. Proven by a test that deliberately does not wait, and again
  live against the containers.
- **Seeding is idempotent.** Cold volume → 24 recipes; restart the API → still 24, not 48. Checked per
  recipe against the event store rather than against a projection.
- **The three-way field check works** — `displays=`/`inputs=` ↔ wireframe `binds=` ↔ HTML `data-em`, and
  it reads the **React port** too, so the shipped component is held to the model and not just the static
  design.
- **The completeness check is a real gate.** Zero errors before any code was written, and implementing
  two slices required no model change — which is the property that makes the gate worth having.
- **Wolverine's runtime codegen works in the `mcr.microsoft.com/dotnet/aspnet:10.0` image**, so the demo
  needs no SDK at runtime and no precompiled types.
