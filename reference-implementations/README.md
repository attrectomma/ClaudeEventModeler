# Reference implementations

Worked implementations of the Event Modeling **patterns**, kept and carried forward. They exist to be read
by a coding agent — or a human — before implementing a slice of that shape, so that the choices already
paid for are not rediscovered.

This is deliberately **not** a domain. Names carry no business claims, and there is nothing here a domain
expert has to stand behind. The archived POC that these replaced was a half-finished domain, and being
half-finished is what made it dangerous: it read as a reference example while asserting things nobody
agreed to.

**Five folders, and every one is green on the kit's current stack** — Marten 9.\*, Wolverine 6.\*,
JasperFx 2.\*, Alba 8.\*. Each was re-measured against it rather than assumed.

```
reference-implementations/
  automation/            the Automation pattern — four ways to wake a trigger, one model    15/15
    email-outbox/        the event model
    generated/           the implementations
  state-change/          the state-change pattern on an EXISTING stream — the aggregate     16/16
    drafting/            the event model                 handler workflow, with and without HTTP
    generated/           both implementations
                         ALSO: DraftHistory, the one demonstration of a row that carries its
                         own child lines as a Type[] group. It lives here rather than in
                         state-view because that model already demonstrates six recipes and a
                         seventh is a separate teaching point, not another column. (The original
                         reason given was a 3200px width budget; that rule has been REMOVED —
                         width was never the argument, "one model teaches one thing" is.)
  state-view/            the state-view pattern — six Marten read-model recipes, one model   36/36
    campaigns/           the event model
    generated/           the implementations
  translation/           the Translation pattern — four ways a FOREIGN event lands: an HTTP  15/15
    stock-feed/          the event model      endpoint, a table they INSERT into, a broker,
    generated/           the implementations  a poll of their API
  cross-aggregate-invariant/   an invariant that spans STREAMS — four ways to guard it:      28/28
    spend/               the event model      a guard row, a reservation row behind a unique
    generated/           the implementations  index, an advisory lock, and DCB. Plus a CONTROL
                         proving the race reproduces without one. The advanced state-change case.
```

Each folder has its own README with the measured comparison. Each is self-contained: its own model, its own
project, readable without the other.

## Read these WITH the library docs, never instead of them

Every folder here answers the same question — *what did this choice cost?* — and none of them answers
*what are the choices?* That set lives only in the libraries' own documentation, mirrored locally at
`reference/llms/`, and it is always larger than what got built here. Marten has more read-model recipes
than the six in `state-view/`; Wolverine has more handler shapes than the two in `state-change/`.

So the order for an implementing agent is:

1. **`reference/llms/<lib>/INDEX.md`** — what does the library offer for this shape of problem?
2. **the matching folder here** — what did the near-miss cost, and which traps are already paid for?
3. **compile**, because the docs are wrong too.

An agent that skips step 1 because step 2 already shows working code has not made a decision; it has
copied one. That is the specific failure the next section is about.

---

## Why the automation pattern first

Because it is where the kit was most wrong, and the error is instructive.

The Automation pattern is `Event(s) → View → Automated Trigger → Command → Event(s)`. Having built exactly
one automation — on a model whose triggers were all *foreign* events or the *passage of time* — the kit
concluded that a clock-driven sweep of a materialised todo View was the only correct implementation, and
wrote that into its own guidance. **That was a sampling error.** A sample of one model is not a pattern.

The correction matters more than the mistake, and it generalises to all four patterns:

> **The model constrains the contract, not the mechanism.**
>
> `Event(s) → View → Trigger → Command` says the trigger decides from **accumulated state** rather than
> from one event's payload, and that it **issues a command** rather than appending one. It says nothing
> about what wakes the trigger, and it does **not** require the View to be a materialised projection.
> A subscription's checkpoint is a record of what has been worked. A durable inbox is a list of pending
> work. The green box on the diagram is the concept.

`PrepareEmail → EmailPrepared → [subscription] → SendEmail → EmailSent` is an automation. It is drawn
`EmailPrepared → EmailsToSend → EmailProcessor → SendEmail`, and no `EmailsToSend` document has to exist
for that drawing to be honest.

### The same is true of the other three

Written out once, so that no future folder here has to rediscover it:

| `pattern=` | Same blocks on the canvas, genuinely different implementations |
| --- | --- |
| `state-change` | aggregate handler workflow vs. explicit `FetchForWriting`; HTTP endpoint vs. Wolverine message; `StartStream` where the slice creates the stream. The transport is not in the model, so the transport must not change the behaviour — which is why `state-change/` asserts every GWT against both. **And when the deciding facts live in another stream, four more:** guard row, reservation row, advisory lock, DCB — `cross-aggregate-invariant/` |
| `state-view` | a green box says only "derived from these events". It may be a live fold with no table, a snapshot, a per-event transformation, a cross-stream rollup, or a SQL table. `state-view/` builds six |
| `automation` | the four wakeup mechanisms above |
| `translation` | **how the foreign event lands** — webhook, a table they INSERT into, a broker, a poll of their API — and that is the *only* choice: the foreign event is never persisted by us, so the arrival is the wakeup and the automation choice does not arise. Built and measured in `translation/` |

**Nothing catches a wrong choice.** Not the rule families, not the compiler, not a green suite. That is
why each folder's job is to state what a choice costs, and why an implementing agent has to name the one
it took.

## The decision table

**Measured, not reasoned** — every row below is built and run in `automation/`. **Ask two questions, in
this order: is the trigger event ours to append, and can you afford to lose one?** The second usually
decides it, and it is *not* the same question as "does ordering matter".

| When | Implementation | Why |
| --- | --- | --- |
| the trigger event is **ours**, losing one is survivable, cheap + immediate wins | **event forwarding → handler** | ~1s, no daemon, one class. But a delivery that never happens is lost — no record of intent outside the moment |
| ours, and **losing one is unacceptable** | **Marten `ISubscription`** | durable checkpoint, so a host that was down catches up. Costs the async daemon |
| the trigger event is **foreign but WE INGEST IT** — the normal shape of a `translation` | **whichever of the two rows above the durability answer picks** | once we append it, it is ours from that moment: there IS a transaction of ours to hook |
| the trigger event is **foreign and never ingested** | **sweep a todo View on a clock** | genuinely no transaction of ours to hook |
| there is **no event at all** — the trigger is *time* | **sweep** | nothing to subscribe to |
| "is there work?" genuinely means "did this row change" | **projection `RaiseSideEffects`** | fires on the row, already knowing. The only one that reaches INTO the read model |

**The third row was missing, and its absence was worse than a gap.** A translation slice matched *"the
trigger event is foreign"* on the surface while failing its stated reason — the model draws the external
event inside one of our own swimlanes with `aggregate=` set, so something of ours appends it, so there *is*
a transaction to hook. As written, `translation` had **no correct row**, and the row it did match sends you
to a clock you do not need. Anyone reading the verdict rather than the justification writes a sweep, and
everything stays green.

**Nothing checks this.** No rule family, no compiler, no test can tell you the choice was wrong — so a
slice has to say which row it was in and why.

## The four, and what each has to answer

All four satisfy the *same* GWTs from the *same* model. What differs is only how `EmailProcessor` is woken,
selected by `Automation:Wakeup`. In a real project you pick one and delete the rest.

| | Implementation | State | Measured |
| --- | --- | --- | --- |
| | Mechanism | Wakes in | Daemon | View stays Inline | Catches up on a backlog | Touches the read model |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | event forwarding → doorbell | **~1s** | no | yes | **no** | no |
| **B** | Marten `ISubscription` | ~3s | yes | **yes** | **yes** | no |
| **C** | projection `RaiseSideEffects` | ~4s | yes | **no** | yes | **yes** |
| **D** | sweep on a clock | one interval | no | yes | yes | no |

All four are implemented and verified to fire with nobody invoking the trigger. **15 tests, stable across
repeated runs.**

Reading that table as a recommendation:

- **the trigger event is ours and you want it cheap and immediate → A.** No daemon, no polling, one class.
  Its cost is invisible until it matters: a delivery that never happens is simply lost, because there is no
  record of intent outside the moment.
- **ours, and you cannot afford to lose one → B.** The checkpoint is a row in the database, so a host that
  was down catches up. It also *coalesces* — one wakeup per page rather than per event — which A does not.
  Pay for it with the async daemon.
- **the trigger is foreign or is the passage of time → D.** Nothing else can work: there is no transaction
  of ours to hang a doorbell on, and no event to subscribe to.
- **C only when "is there work?" genuinely means "did this row change".** It is the only one that reaches
  into the read model, and the only one that forces the todo View to be eventually consistent.

`WakeupMechanismTests` is the only test in the project that can tell any of this. Every other test drives
`RunSendEmail` itself — correct, because that is the production path — but says nothing about whether
anything *sends* it. So each test there boots its **own host** with one mechanism on, posts an email through
the ordinary endpoint, and waits. **Nobody invokes the trigger.** If `EmailSent` appears, the mechanism woke
it. `WithNoMechanismNothingIsEverSent` is the control, and without it "forwarding works" could just as well
be "something else in the host happens to run the trigger".

An unimplemented mechanism **throws on startup**. A wakeup that silently does nothing is the defect this
folder documents, so a missing one must not resemble a working one.

### B: the one that catches up

Its distinctive property is not speed — it is the only mechanism with a **durable record of intent outside
the moment**. `SubscriptionCatchesUpOnEventsItWasNotRunningFor` prepares an email with nothing listening,
disposes that host, and starts a second one with the subscription on. Nobody composes anything; the only
work available is the backlog, and it gets processed. Forwarding would have lost that delivery for good.

It also **coalesces**: one wakeup per event *page*, not per event. Since the trigger works the whole todo
View anyway, waking it twenty times for a page of twenty events would do the same work twenty times and
collide with itself. Forwarding fires once per event and relies on `AlreadySent` to absorb the rest.

And unlike C it keeps the view **Inline** — updated in the append's own transaction — so by the time the
daemon hands over the event, the row the trigger reads is already committed. Same daemon cost, none of the
consistency cost.

**Two API facts no doc page states**, both settled by reflecting over the assemblies:

- `ISubscription` is in `Marten.Subscriptions`, `EventRange` in `JasperFx.Events.Projections`,
  `ISubscriptionController` in `JasperFx.Events.Daemon`, `NullChangeListener` in `Marten` itself.
- **a subscription cannot take `IMessageBus` by constructor injection.** Marten builds the subscription
  during store construction, and Wolverine's message store *is* Marten — so `MessageBus` reaches for
  `WolverineRuntime.Storage` while that `Lazy` is still being created:
  *"ValueFactory attempted to access the Value property of this instance."* A circular startup. Resolve the
  bus from `IServiceProvider` when a page arrives instead.

### C: it works, and the interesting part is what it costs

**It had to be `Async`.** Marten calls `RaiseSideEffects` only during continuous asynchronous projection
processing unless `EnableSideEffectsOnInlineProjections` is switched on — and the docs describe that switch
as a late addition for a single client. Async is the supported path, so mechanism C takes it and the
consequences cascade:

- the todo View stops being updated in the same transaction as the append, so it is **eventually
  consistent**. Its test waits where the others assert.
- it pulls in the **async daemon**, a background thread nothing else here needs.
- the projection **lifecycle is no longer a fixed property of the view** — the owning automation now
  overrides it, which is why the generator emits `SendEmailWakeup.LifecycleOf(ProjectionLifecycle.Inline)`
  rather than the literal.

**And it is the only mechanism that reaches into the read model.** Forwarding is a handler, a subscription is
a registration, a sweep is a clock — all outside the view. C puts a `PublishMessage` inside the projection,
so a read model becomes the thing that dispatches work and has to know an automation exists. For a generated
kit that is a mark against it: the file scaffolded for a *view* now carries transport.

What it buys is precision. Forwarding fires on the *event* and the trigger then re-reads the View to discover
whether there is anything to do; C fires on the *row*, already knowing. Where "is there work?" is exactly
"did this row turn pending", nothing expresses it as directly.

The guard matters: this projection also folds `EmailSent`, so an unguarded publish would wake the trigger
with its own completion — harmless, since the run finds nothing pending, but a wasted round trip per send and
one step from a loop if the guard were ever wrong.

### What building them taught

**Hook order is load-bearing, and getting it wrong fails silently.** A mechanism may need configuration in
generated bootstrap code — forwarding sets a flag on `IntegrateWithWolverine`, a subscription needs
`AddAsyncDaemon`. `Program.cs` is `emit`, so it cannot be edited; the generator therefore emits five call
sites (`Choose`, `ConfigureMarten`, `ConfigureStore`, `ConfigureIntegration`, `ConfigureWolverine`,
`RegisterServices`) and the scaffold decides what they do. `Choose` was originally resolved *last*, so
forwarding set its flag on a callback that had already run: no error, nothing logged, the automation never
woke. Only the real-wakeup test caught it. **This folder reproduced its own subject matter in its own
plumbing.**

**At-least-once is not a footnote, and one guard is not enough.** With forwarding, the outbox delivered
`EmailPrepared` twice. Two runs folded the stream *before* either appended, so both legitimately saw
`Sent == false` and both passed the `AlreadySent` rule. What stopped the second was Marten's optimistic
concurrency — `FetchForWriting` captured the version and the second append collided.

> The **rule** catches the sequential duplicate. The **transaction** catches the simultaneous one.
> They are complementary. A decider with only the rule sends twice under a double delivery; one with only
> the version check reports a crash where a plain refusal is the truth.

Left alone, that collision surfaced as a failed message, a logged stack trace and a Wolverine retry — which
is how the forwarding test first passed *while printing what looked like a failure*. Translating
`EventStreamUnexpectedMaxEventIdException` into `AlreadySent` is what makes a duplicate delivery a
non-event. Worth stating plainly: **every mechanism here is at-least-once, so the decider must be
idempotent, and idempotent means both guards.**

**Static mechanism selection does not survive parallel hosts.** The `Configure*` hooks are static methods
called from `Program.cs`, so the chosen mechanism has nowhere per-host to live and ends up static. Run in a
parallel xUnit collection, one wakeup host called `Choose()` in between the shared host resolving its own
choice and registering its projections — so the shared host built the view **Async** and every inline row
assertion in the GWT tests failed, in a way that had nothing to do with what those tests were testing. Fixed
by serialising the wakeup tests into the shared collection. A real project never meets this, because it picks
one mechanism and deletes the rest; it is a cost of keeping four side by side.

**Shared-schema isolation is a real limit.** Each mechanism gets its own host, but the generated
`Program.cs` hard-codes `DatabaseSchemaName`, so `UseSetting` cannot separate them and rows accumulate
across tests. The tests are made independent by naming their own `emailId` instead — which works because
the endpoint honours a supplied id and mints one only when it is absent.

## Status

| folder | pattern | what is built | tests |
| --- | --- | --- | --- |
| `automation/` | `automation` | all four wakeup mechanisms, each verified to fire unaided | **15** |
| `state-change/` | `command` | both deciders — with and without Wolverine.HTTP — asserted against the same GWTs, **plus `DraftHistory`: a row carrying its own child lines as a `Type[]` group** | **16** |
| `state-view/` | `view` | six Marten read-model recipes over two stream types, **each now with Given/Thens specifying its fold** | **35** |
| `translation/` | `translation` | three ways a foreign notice LANDS — webhook, external database table, poll on a clock — and the finding that a translation needs **no** wakeup mechanism and persists **no** foreign event | **15** |

**All four patterns now have one, and the last one corrected the table above it.** `translation/` was built twice.
The first version persisted the foreign event onto one of our own streams and woke a trigger off it with a Marten
subscription; it compiled, passed 15 tests, and ran — and it was wrong in exactly the way this kit exists to catch.
`tools/model.mjs` had said so all along: both identity rules exclude `external` because *"we never start those
streams, we only project from them."*

So `translation` is **not** "the automation choice plus how the foreign event lands". The automation choice does not
arise: all four wakeup mechanisms wake a trigger off events already in our store, and a translation's trigger event
never is one. **The arrival is the wakeup**, and the transport's durable inbox is the todo View — the sharpest case
in the kit of "the green box is the concept", because here a materialised View is not merely unnecessary but
impossible.

Two numbers worth carrying: **1 event type in our store, not 2**; and, measured on the first version before it was
fixed, **11 of 15 tests passing with the automation completely dead.**

**Every view slice here now has Given/Thens, and until recently none did.** These folders demonstrated six
read-model *recipes* and never once demonstrated how a View is **specified** — the thing both books call
mandatory and the thing a reader most needs to copy. Seventeen were added. The ones that earn their keep
assert what a view **ignores**, because the drawing already claims which events feed which view and nothing
made that claim executable. All of those were mutation-checked: break the fold on purpose, confirm that one
test and only that one fails.

**All five suites pass — 110 tests — and are stable across repeated runs.** Every folder has also been
**run as an app**, because each pattern has at least one failure mode a green suite cannot see: an
automation that nothing wakes, an async projection that nothing processes, a foreign feed that never
arrives.

**And all five were re-measured, not assumed, when the enforced stack moved to Marten 9 / Wolverine 6.**
That mattered: a green *build* proved nothing — the migration's breaks all compiled at 0 warnings 0 errors
and failed at host startup. Only running each suite settled it.

Each folder's own README carries its measured findings. Two are worth knowing before opening any of them:

- **The generator does not choose a mechanism or a recipe.** For automations it emits the seam and reports
  `AUTOMATION NOT WOKEN` until somebody chooses; for views it emits the default recipe into a **scaffold**
  that regeneration keeps. Neither reports a choice that is merely *wrong*, and no checker can.
- **Both of those seams exist because a choice was silently lost or silently absent once.** That is the
  recurring shape here, and it is why every folder's job is to say what a choice costs rather than which one
  to make.

A claim without a measurement behind it does not belong in this file.
