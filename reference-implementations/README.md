# Reference implementations

Worked implementations of the Event Modeling **patterns**, kept and carried forward. They exist to be read
by a coding agent — or a human — before implementing a slice of that shape, so that the choices already
paid for are not rediscovered.

This is deliberately **not** a domain. Names carry no business claims, and there is nothing here a domain
expert has to stand behind. The archived POC that these replaced was a half-finished domain, and being
half-finished is what made it dangerous: it read as a reference example while asserting things nobody
agreed to.

```
reference-implementations/
  automation/
    email-outbox/          the event model — ONE model, shared by every implementation below
    generated/             what tools/codegen.mjs emits from it, unedited
    src/, tests/           the implementations
```

---

## Why the automation pattern first

Because it is where the kit was most wrong, and the error is instructive.

The Automation pattern is `Event(s) → View → Automated Trigger → Command → Event(s)`. Having built exactly
one automation — on a model whose triggers were all *foreign* events or the *passage of time* — the kit
concluded that a clock-driven sweep of a materialised todo View was the only correct implementation, and
wrote that into its own guidance. **That was a sampling error.** A sample of one model is not a pattern.

The correction matters more than the mistake:

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

## The decision table

Reasoned, not yet measured — the whole point of the implementations below is to test it.

| When | Implementation | Why |
| --- | --- | --- |
| the trigger event is **ours**, appended in our own transaction | **event forwarding → handler** | immediate, outbox-durable, no polling. The common case. |
| ours, and **ordering or replay** matters | **Marten `ISubscription`** | ordered, durable checkpoint, runs in the async daemon |
| ours, and the decision is a function of **the view row** | **projection `RaiseSideEffects`** | fires exactly when the row changes |
| the trigger event is **foreign** — we never append it | **sweep a todo View on a clock** | there is no transaction of ours to hook |
| there is **no event at all** — the trigger is *time* | **sweep** | nothing to subscribe to |

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

The model is built and validated, both deciders are green, and all four wakeup mechanisms are implemented
and verified to fire unaided: **15 tests passing**, stable across repeated runs. The generator no longer chooses a mechanism
— it emits the seam and reports `AUTOMATION NOT WOKEN` until a choice is made, which is the check that
would have caught the original defect.

All four mechanisms are built. What is *not* settled is whether the generator should offer a default — it
currently offers none, and reports `AUTOMATION NOT WOKEN` until a choice is made.

A claim without a measurement behind it does not belong in this file.
