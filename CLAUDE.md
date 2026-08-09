# ClaudeEventModeler

Event Modeling diagrams in draw.io, edited by both a human (visually, in VS Code) and Claude
(as XML). The `.drawio` file is the single source of truth — there is no database and no
export step to keep in sync.

## This folder is the KIT. The work goes somewhere else.

**One copy of the kit serves one project.** The kit is cloned once from GitHub; a developer then
copies the folder — **without `.git`** — as many times as they have projects. Each copy is
configured with the path of the project it writes to:

```
node tools/project.mjs init --project C:/Repos/acme-shop
node tools/project.mjs where          # what this copy is pointed at
```

| | Lives in the **kit** (here) | Lives in the **project** |
| --- | --- | --- |
| skills, agents, `.mcp.json`, this file | ✅ | |
| `tools/`, `templates/`, `reference-implementations/` | ✅ | |
| `reference/llms/` — the docs mirror | ✅ regenerable, gitignored | |
| `tools/fixtures/` — the kit's own regression suite | ✅ | |
| `inbox/` — raw input, the phase-0 baseline | | ✅ |
| `diagrams/*.drawio` | | ✅ |
| `designs/<slug>.html` | | ✅ |
| `build/` — derived IR | | ✅ gitignored |
| `generated/<System>/` — code and tests | | ✅ committed |

**The project has no trace of the kit in it.** Its own git history, its own `.gitignore`, no
submodule, no path back. That is deliberate: the project outlives whichever copy of the kit built
it, and can be handed to someone who does not have the kit at all.

**Why copies rather than one shared install.** Everything Claude Code gives an agent — this file,
`.claude/skills/`, `.claude/agents/`, `.mcp.json`, per-project memory — is scoped to the **working
directory**. Keeping cwd inside the kit is what makes all of it resolve with no plugin, no
`${CLAUDE_PLUGIN_ROOT}`, and no installation step. The output is what moves, not the agent surface.

**So never write a kit-relative output path.** `diagrams/`, `designs/`, `build/` and `generated/`
under this folder are all wrong. The tools resolve them for you:

```
--project <path>   beats   $EM_PROJECT   beats   project.json   beats   a clear error
```

`project.json` is configuration, not a manifest. The no-manifest rule below is about **domain
facts**, which belong on cells; an absolute path to an output directory is not one and could not be
drawn on a diagram if we tried.

**`validate`, `map`, `compile`, `codegen`, `design check` and `design sheet` all default to the
project's own folders**, so the common case has no path in it at all.

## Enforced tech stack

Generated code and any reference implementation target exactly this. Not a default to be
argued with per slice — it is the stack.

- .NET 10
- Postgres
- **Wolverine 6.\*** (messaging, command handling)
- **Marten 9.\*** (event store, projections)
- **Alba 8.\*** (in-process HTTP integration testing)
- **JasperFx 2.\*** — the shared library the other three now sit on
- Testcontainers (real Postgres in tests)
- Docker
- Aspire — optional, only after an explicit feasibility check

**The majors move together, and that is not tidiness.** Wolverine 5 *compiles* against Marten 9 and then
dies at host startup with `TypeLoadException: Could not load type 'Weasel.Core.IAdvisoryLock'` —
`WolverineFx.Marten` 6.25.1 depends on Marten 9.22.2, so the family is one decision. A mixed pin is not a
conservative choice, it is a green build that cannot boot.

**Current, deliberately, because `docs.mjs sync` always mirrors the CURRENT docs.** A kit pinned a major
behind therefore has a mirror permanently *ahead* of its own packages, and *"read the mirror before writing
generated code"* silently becomes conditionally true — a documented member that will not compile (the
`WaitForExecutionOf<T>` note below) is that skew rather than a namespace mistake. It cost a real
misdiagnosis: `IAggregateGrouper<TId>`'s batch parameter is `IReadOnlyList<IEvent>` and the mirror had said
so all along, while the Marten 8 package wanted `IEnumerable<IEvent>`. Moving to current makes the mirror
and the packages agree, which retires the whole class. **So a version bump is maintenance of the docs
contract, not just of the packages.**

**A project may override a package version, and must say why.** Both `.csproj` files are `emit`, so a
hand-edited version is reverted by the next regeneration — silently, with the symptom arriving later as
behaviour rather than a build error. `<project>/package-versions.json` is where a pin survives:

```json
{ "_why": "held on Alba 7 until the harness rewrite lands; 8 changed IScenarioResult", "Alba": "7.*" }
```

*(That example used to pin Marten to `9.*` — which is now the **default**, so it pinned nothing. The one
project that needed it, `cross-aggregate-invariant/`, has had its override file deleted: the folder that
had to depart from the stack is now on it.)*

Keys beginning with `_` are comments, and the reason is the point — a bare version with no
justification is how a departure from this list becomes folklore. **An unknown package name is an error,
not a no-op**, because a typo in a pin is exactly how the pin goes missing. Every override is printed on
every `codegen` run, so a divergence from the stack above is visible rather than buried in a file.

Do not solve this with MSBuild. A `Directory.Build.targets` carrying
`<PackageReference Update="Marten" Version="9.*" />` inside a target reads correctly and `dotnet restore`
**ignores it** — measured: restore resolved **Marten 2.10.3**, a 2018 package with a critical CVE, while
the file looked right. A pin that fails must fail loudly; that one failed by downgrading.

Wolverine, Marten and Alba each need continuously updated, LLM-friendly documentation available
locally. Their APIs move faster than model knowledge, so anything generated against remembered API
shapes will be subtly wrong — right shape, wrong method name, quietly deprecated overload. Codegen
*multiplies* that: a fan-out of agents produces one wrong file per agent instead of one you would
have caught.

**All three publish `llms.txt`** — a markdown index whose every entry is also served as raw `.md`.
Alba does too, at `jasperfx.github.io/alba/llms.txt`, which this file previously said it did not.

```
node tools/docs.mjs sync     # mirror all three into reference/llms/   (392 pages, ~4 MB)
node tools/docs.mjs status   # how many pages, and how stale
```

**Read the mirror before writing any generated code — including when a reference implementation already
shows an answer.** `reference-implementations/` records what a choice *cost*; the library docs are the
only place the full set of *options* lives, and each pattern has several. Each library has
`reference/llms/<lib>/INDEX.md`, a local table of contents grouped as upstream groups it. The mirror
lives under `reference/`, which is **gitignored** — it is a regenerable build input like
`node_modules`, so a fresh clone must run `sync` once. `_manifest.json` records when it last ran so
staleness is visible rather than assumed.

## Codegen: what a script owns, and what needs judgement

`tools/codegen.mjs` emits everything **mechanically derivable** from the IR — the solution, both
projects, `Program.cs`, 16 event records, 4 aggregate folds, 10 view types, the validators, the Alba
harness, and one test per GWT. It is total and idempotent, and its diff is how a model change gets
reviewed. It emits **no business logic**, marking every hole `TODO(codegen)` for the `codegen` skill,
which reads `reference/llms/` and fills them.

**This is not aspirational — it was tested against a second, fully independent run.** Two Opus runs and
one cold Sonnet run of the same brief, sharing no artifacts, produced **byte-identical `emit` output**
every time, and the three independently-authored backends converged on the same view recipe, the same
lifecycle and the same decider with no coordination between them. KIT-FINDINGS **X**.

Verified rather than assumed: `dotnet build` succeeds with 0 warnings, and `dotnet test` discovers
and runs **55 tests, 55 failing** — one per GWT, against a real Testcontainers Postgres.

The stack pattern, all of it read from the mirror:

```csharp
[WolverinePost("/entries/{subjectId}/{period}/add"), EmptyResponse]
public static EntryAdded Add(AddEntry cmd, [Aggregate] Entries entries) => ...;
```

Static methods, no controllers. `[Aggregate]` resolves the stream from route args and applies Marten's
transactional middleware; `[EmptyResponse]` makes the returned event get *appended* rather than
serialised. **The endpoint is the decider** — so a state type is a pure `Apply` fold with no rules in
it. Streams are `StreamIdentity.AsString` because every key here is composite.

### Accepted: the generator does not reach backwards

**A generator improvement does not improve the files it has already handed over, and that is by design
rather than a defect.** Anything under a `<auto-generated-scaffold>` banner is hand-owned from the moment it
exists, so a fix to `codegen.mjs` only reaches *new* files. Measured: regenerating three reference
implementations after three generator fixes left two warnings behind, both in scaffolds, both needing a hand
edit.

The alternative — a generator that edits inside files somebody else owns — is strictly worse, and it is the
one thing the emit/scaffold split exists to prevent. So this is **accepted**, not queued. What the generator
owes you instead is *visibility*, and that is what the reports are for: `GWT WITHOUT A TEST`,
`TESTS STILL SKIPPED ON A CLAIMED SLICE`, `IMPLEMENTED BUT STILL UNCLAIMED`, `VIEW WITH NO REGISTRATION`,
`AUTOMATION NOT WOKEN`. Each names a file and what to change. Add a report rather than a rewrite.

**One report is still missing, and it is the arrival of a foreign event.** The generator emits an external event's
record and a `SeedData` TODO to append it *in tests*, and nothing at all in the application — so no production
path exists by which a foreign event enters the store, and *"nothing ever ingests this"* is invisible to a green
suite in exactly the way *"nothing ever wakes this"* was. `INGEST NOT WIRED`, by the same logic as the reports
above. Measured in `reference-implementations/translation/`; see KIT-FINDINGS T1.

**The reference implementations are not the generator's responsibility either.** They are worked examples
carrying what a choice *cost*, and they get better as the stack gets better understood — which is editorial
work, not generation. A future **skill or agent whose job is keeping them current** is the right home for it:
re-reading the docs mirror as libraries move, re-measuring the comparisons, and folding in what later runs
learn. Not built yet; noted so it is a decision rather than a drift.

### Two kinds of generated file, and conflating them is a trap

"Generated code is committed so its diff is the review" and "fill in the TODOs" contradict each other
unless the generator distinguishes them:

| | Overwritten? | Holds |
| --- | --- | --- |
| `emit()` | **always** | what the model fully determines — event records, view *types*, csproj, Program.cs |
| `scaffold()` | **never, once it exists** | what needs judgement — folds, projections, **which recipe each view is and how it is registered**, validators, endpoints, tests, seed data |

The line between them is not obvious, and it has moved twice. Both moves had the same cause: something that
needed judgement was being emitted, so the judgement was silently overwritten on the next run — the
automation wakeup hooks, then the read-model registrations. **If a decision has no scaffold to live in, the
generator is making it.**

Scaffolded files carry `<auto-generated-scaffold>` instead of `<auto-generated>`. Regeneration
reports `N written, M kept`, and re-running it after the first slice was implemented kept all 35 filled
files and left the suite green — which is the property worth protecting.

### `[Aggregate]` does not fit a composite stream key

The attribute resolves a stream id from **one** route argument. Every stream here is keyed by
`subjectId + period`, so there is no single argument to find. `FetchForWriting<T>(streamKey)` gives
the same optimistic concurrency and the same live fold, and is honest about the composite key. Reading
another stream is `session.Events.FetchLatest<T>(streamKey)` — on `IDocumentSession.Events`, not the
query session.

A rejected rule returns **ProblemDetails with the rule name as the Title**, which is what
Wolverine.HTTP already does for FluentValidation failures — so `then="error: RuleName"` asserts the
same shape whether the rule was caught at the periphery or in the decider.

### Live on the write side, inline on the read side

| | Registered? | Why |
| --- | --- | --- |
| **write** — the state a slice folds to decide | **nothing** | live aggregation: `FetchForWriting` folds on demand |
| **read**, one row = one stream | **`ProjectionLifecycle.Inline`** | updated in the append's own transaction, so a GWT's THEN can be asserted the moment the request returns |
| **read**, one row spans streams | **`ProjectionLifecycle.Async`** + the daemon | Marten's own guidance: *"register the lookup projection inline and the multi-stream projection async"*. Not assertable immediately — a test must **wait** |
| a **todo View an automation's liveness depends on** | **`Inline`, even when it spans streams** | the exception, and it is measured. See below |

**The third row is a deliberate exception to Marten's guidance, and it is the only one.** That guidance is
about a view somebody **reads**. A todo View is not that: a trigger's liveness depends on it, and
*Understanding EventSourcing* ch. 32 names what Async costs it — *"entries get lost if the processor was
running before the model got updated"*. Reproduced deterministically in
`reference-implementations/reservation/`: the wakeup arrives inside the request that appended the trigger
event, the daemon cannot have caught up, the trigger reads an empty list, and **the work is never done and
never compensated** — with a 200 response, a clean log and a green suite. Inline puts the row in the
append's own transaction, so anything woken by the event finds it already committed.

It costs what the book says Inline costs, and both are real: the write side stops being independently
scalable, and **a projection exception now aborts the business transaction that appended the event**, so a
bug in a todo list can refuse a command. Accepted, because the alternative fails silently.

**`codegen` does not yet know the difference** and registers a todo View Async like any other multi-stream
view — KIT-FINDINGS **BL2**. Until it does, this is a hand edit in the `ViewRegistrations` scaffold, which
is exactly what that scaffold exists for.

Those two rows are the **starting point**, not the only option — Marten offers six read-model recipes and
several of them cannot be `Inline`. See *…and what one row is decides WHICH projection* below, and note
that `ProjectionLifecycle` is a **required argument**: Marten has no default to fall back on.

**There is no "the" aggregate.** Every state-change slice folds the stream into whatever shape *its*
decision needs, so aggregates are **per slice**, not per stream — which also takes them out of the
shared layer and makes slices more independent. Each folds *all* of its stream's events, because the
daily cap needs the whole month, not just the booking being added.

**No `Create` methods.** A no-arg constructor lets any event open the stream, and Marten's own docs
say that is *"probably safest unless you can guarantee that a certain event type will always be first"*
— which does not hold here. "First event drawn in the swimlane" is a good rule that covers 3 of 4
bands: one stream was genuinely always opened by the same event, but another could be opened by either of
two, depending on whether the subject acted or the system filled in on their behalf. The leftmost event survives as a doc comment, not a dependency.

### `identity=` on a read model — what one ROW is

A view's `fields=` say what a row holds and never what a row **is**. One view is per line item, another
per (subject, category), a third per (subject, period) — and nothing said so until a projection had to
group events.

**A projection with no slicing rule cannot be registered.** Marten rejects a multi-stream projection
with no `Identity<T>` rules **at startup**, so the whole host goes down and you lose the per-test
failure detail — 55 individual failures become 55 identical fixture errors. `Identity` is derivable
for any event carrying the view's whole key; where it is not, the generator emits the projection but
leaves the registration commented with the reason.

Declare `identity=` on the read model. Where it is missing the generator falls back to the system key
and stamps the projection `GUESSED`, because silently grouping the wrong rows together is worse than
saying so. **Only 1 of 10 views in the worked model declared it** — see ANTI-PATTERNS.md #3.

### …and what one row is decides WHICH projection, of six

`Event(s) → View` is the whole contract of a view slice. It does not say the view is a
`SingleStreamProjection`, and it does not say a document exists at all — a live aggregation and a flat
SQL table both satisfy the drawing. `identity=` is what narrows it:

| One row is | Recipe |
| --- | --- |
| one stream, read by id, short stream | **live aggregation** — register nothing, `FetchLatest<T>` |
| one stream, read often or long | **`SingleStreamProjection<T, TId>`** / `Projections.Snapshot<T>` |
| one stream, **with its child lines inside the row** | the same, plus a `Type[]` group — see below |
| **one event** — a log line, or one row per item *inside* an event | **`EventProjection`** — the only recipe that is not an aggregation |
| a key carried by events from **several stream types** | **`MultiStreamProjection`** + one `Identity<T>` per event type |
| a key rolled up over **many streams of one type** (per sender, per month) | the same, with a composite `Identity<IEvent<T>>` reading `StreamId` / `Timestamp` |
| a key the events **do not carry** | multi-stream + `CustomGrouping(IAggregateGrouper<TId>)` over an inline lookup |
| rows to be aggregated **in SQL** | **`FlatTableProjection`** — not a document |
| a view fed by **another projection's output** | **composite / chained** projections (Marten 8.18+) |

`Identities<T>` fans one event into many rows, `FanOut<T,TChild>` splits a collection member into child
events, `RollUpByTenant()` keys by tenant; all three compose with `Identity<T>`, while a custom
`IEventSlicer` replaces all of them. `IProjection` is the escape hatch.

**The generator knows two of these**, because two is all `identity=` determines: single- or multi-stream,
registered `Inline`. The view file is `scaffold`, so choosing another recipe is a legal hand edit that
regeneration keeps — but it must be *said*, and the table above is the menu to say it from.

**So is the registration.** `Views/ViewRegistrations.cs` holds `Register(StoreOptions)` and
`ConfigureStore(marten)`, both called from `Program.cs`, and both `scaffold`. They exist because the
registrations used to be inline in `Program.cs`, which is `emit` — so every read-side decision an implementer
made was **lost on the next regeneration**, and on the worked model four views out of five needed one. The
second hook is separate because `AddAsyncDaemon` sits on the Marten *chain* and not on `StoreOptions`;
without it, `Async` could not be chosen from a scaffold at all.

### A row can carry its own child lines — `Type[]` and `children=`

A header plus its line items is **one row**, not two views. Say so with a repeated group:

```xml
<object id="rm-recipe-detail" label="RecipeDetail" em="readmodel" identity="recipeId"
        fields="recipeId:Guid, name:string, ingredients:IngredientLine[]"
        children="IngredientLine: ingredientName:string, amount:decimal, unit:string">
```

**`[]` means many of these, not one.** `children=` names the group's shape and lists its fields, reusing
the same `name:Type` grammar — the only new notation is the brackets. `identity=` does not change: still
one row per recipe, with the lines *inside* it.

**The group is transparent to the completeness check in both directions**, which is what keeps everything
else working. A view declaring `ingredients:IngredientLine[]` is really asking for `ingredientName`,
`amount` and `unit`, because that is what an event can supply — the collection field itself has no source
and never could. And a screen displaying `ingredientName` is satisfied by a view offering the group.
`mappings=`, `derived=` and `mapping-crosses-types` all keep working on the flattened names, so a child
field may legitimately be a rename of what the event carries.

**A list of primitives is not a group.** `recipients:string[]` needs no `children=` — it already *is* the
attribute, and it generates `string[]` exactly as before.

**Arrays, not `List<T>`, and not for tidiness.** Both were run against real Marten and Postgres: identical
behaviour, identical JSONB containment SQL for a LINQ `Any()`, identical rebuild. What decides it is that
`List<T>` lets somebody write `current.Lines.Add(...)` in an `Apply` — which compiles, appears to work, and
**mutates the document instance Marten handed you**, a real bug under second-level projection caching that
no test would obviously catch. On an array that is a compile error, so the immutable
`with { X = [.. X, item] }` is the only way through. One documented Marten query pattern is array-only too.

**Why this exists at all:** without it, a detail screen showing a recipe *and* its ingredients had to be
modelled as two read models — and a screen fed by two views is a smell (see below). Twelve checks against
real Marten proved the single-row form works, including the empty list on a brand-new parent,
accumulation across separate transactions, querying into the collection, and a full rebuild reproducing it.
Demonstrated in `reference-implementations/state-change/` as `DraftHistory`, whose row carries its own
revision history.

**One screen fed by two views is a smell.** Ask why one view cannot answer the screen — usually the answer
is that it can, with a group. The mirror-image smell is one view feeding two *features*: two independently
evolvable screens must not share a read model, even when the two views are shaped identically today.
Neither is checkable; both are review questions.

**A view's document id is not the stream id.** A rolled-up view is keyed by its own `identity=` —
`(messageId, recipient)`, `(senderId, month)` — and neither is a stream key. Same rule as `StreamIdentity`:
one field means that field's type, a composite means `string`. Getting this wrong did not produce a subtly
wrong read model, it produced code that would not compile.

**Keying a view on event metadata keys it on the APPEND time.** `Identity<IEvent<T>>` is how you reach
`StreamId` and `Timestamp`, and it is the natural way to write "per sender per month" when no event carries a
month. `IEvent.Timestamp` is stamped when the event is written and ignores the payload — so the view answers
*"appended in month M"* while every reader assumes *"happened in month M"*. Use the payload's own timestamp
unless the question really is about the write. ANTI-PATTERNS.md #15.

So **the lifecycle is per view, and the generator now follows Marten rather than its own habit:
single-stream `Inline`, multi-stream `Async`.** `RaiseSideEffects` no longer forces `Async` outright — side effects are processed only during async processing **by default**, and running them on an `Inline` projection needs `opts.Events.EnableSideEffectsOnInlineProjections = true`. Every step
away from `Inline` costs the same two things: the async daemon, and tests that must **wait** where they
used to assert — which is why `codegen` puts the `WaitForNonStaleProjectionDataAsync` line in an Async
view's test hint and starts the daemon in `ConfigureStore`.

**This paragraph used to say something else, and it was wrong three ways** — worth recording, because it
is the standing rule earning its keep. It claimed Marten *"registers multi-stream projections `Async` by
default"* and that `Inline` *"invites apparent event skipping"*. Checked against the mirror:

| The old claim | What the docs say |
| --- | --- |
| Marten defaults multi-stream to `Async` | **there is no default** — `ProjectionLifecycle` is a required argument, and all 22 `Projections.Add` call sites in the mirror pass it explicitly |
| `Inline` causes apparent event skipping | *"event skipping"* is an **async-daemon high-water-mark** phenomenon, so it was attributed backwards |
| `Inline` everywhere is a reasonable default | *"Register the lookup projection inline and the multi-stream projection **async**"* — the multi-stream page states the shape outright |

**The standing rule: where this kit and the critter-stack docs disagree, the docs win, and the kit is
changed to match.** Not documented as a difference — *changed*. These libraries move faster than model
knowledge, which is the whole reason the mirror exists; a kit that keeps its own opinion beside theirs is
just a second source of truth that nobody reconciles.

All six are built and measured against one model in `reference-implementations/state-view/`.

### Journeys: the layer above a slice

**Every GWT and GT is a single slice's scenario**, and appends its GIVEN straight to the stream. That is the
right shape for a slice, and on its own it leaves a slice pair that each pass alone and cannot be **composed**
with nowhere to be caught: an id minted in one shape and read in another, a projection current for its own
slice but stale for the next, a rule that only bites on the *second* command in a sequence.

A **journey** closes that: one test walking several slices end to end **through the real API**, named on the
model as an `em="journey"` cell and scaffolded by `codegen`. It belongs to the system rather than to any
slice, which is why the `journey` skill owns it and neither `codegen` nor a slice's own agent does.

```
node tools/slice.mjs journey <model> --journey <slug> --slices "<a, b, c>" --then "<View(field=value)>"
```

**The one rule: no step may append an event.** No `Given(...)`, no `Events.Append`, no `StartStream`. A GWT
may append its history because history is exactly what a GIVEN means; a journey may not, because the whole
question is whether step two can live on what step one *actually left behind*. It is an easy and tempting edit
when a step fails, so `codegen` reports it: `JOURNEY APPENDS ITS OWN HISTORY`.

Two things measured while writing the first one, both worth knowing before the second:

- **Use the ids the API hands back.** Asserting on a variable the test made up cannot see a slice that echoes
  something subtly different — the first failure class on the list above.
- **`WhenPosting` does not wait for Marten's async daemon.** It wraps each request in Wolverine's
  `ExecuteAndWaitAsync`, which blocks on *cascading messages* only. An `Inline` view is assertable
  immediately; an `Async` one needs `Store.WaitForNonStaleProjectionDataAsync(timeout)`. **The tell is a
  partial result, not an empty one** — the measured failure was `Queued == 1, Delivered == 0`, the daemon
  caught up as far as step two and not step three. A journey has the longest gap in the suite between the
  first write and the last assertion, so it bites hardest here and reads exactly like a composition bug.

Worked example: `campaign-lifecycle` in `reference-implementations/state-view/`.

### And the same layer in front of the API — UI journeys

**A journey walks slices through HTTP, so it cannot see anything between the screens.** Whether you can get
from the list to the modal to the created thing is a different question, and the three nets under the UI all
check **one screen at rest**: `model.mjs` holds `displays=` to the wireframe, `design.mjs check` holds both to
the React port, `review.mjs` puts the built screen beside the design. The bug that proves the hole was found by
*screenshotting*, past 32 passing tests — `/` and `/?page=2` rendered **identically**, because the pager was
component state that never reached the URL, so a page could not be linked, bookmarked or refreshed.

**`ui-journey` closes it, in a browser, and it is the same cell.** No new notation: an `em="journey"` cell
names one story, and `journey` walks it through HTTP while `ui-journey` walks it through the browser. A journey
whose slices have no screens is a backend journey and only that — which is an answer, not a gap.

```
node tools/uijourney.mjs plan       # what the model says a UI journey would walk, and what it cannot say
node tools/uijourney.mjs scaffold   # the playwright config, the shot helper, one spec per journey
node tools/uijourney.mjs check      # a spec that fakes its backend, skips its navigation, or invents a selector
```

**The one rule has two halves here, because a browser has two ways to cheat.** *No step may fake the backend* —
no `page.route`, no `fulfill`, no `localStorage` seeding, and **no `/harness/`**, which exists to make a hard
state *lookable* and fakes transport to do it. And *no step may skip the navigation it is testing* — reaching
step three by typing its URL is exactly a backend journey appending its own GIVEN. A deep link is legal **after**
a click has proved the app produces it, which is not a loophole: it is the pager test.

**Selectors come from the model, and that is why this needs no test ids.** `data-em` / `data-em-input` /
`data-em-action` are already in the shipped React, already derived from `displays=`/`inputs=`/the command edge,
and already held to the model in both directions by `design.mjs check`. `check` reports a spec naming a field
its screens do not declare — the same error class, at the same strictness.

**Playwright, deliberately, and the "no Playwright" rule above is unchanged** — that rule is about `design.mjs`,
where shooting a URL needs nothing. A journey **clicks**, and nothing else on this machine does. Two things come
with it that are not conveniences: a real 390px layout viewport from device metrics, so the sub-500px lie
`shoot.mjs` needs an iframe to dodge does not arise and a desktop-only run has no excuse; and retrying
assertions, which are the only way to say *eventually consistent* rather than confuse it with broken. **If an
assertion only passed on retry, that is a finding** — the screen needs a refetch or optimistic UI in production.

**It also buys back a capability the kit had written off.** `frontend-agent` correctly says headless Chrome
shoots a URL and does not click, so a modal over a list, page 2, a rejected form and an in-flight button were
states nobody could look at. A journey that clicks shoots them into `<project>/review/_shots/` under the name
`review.mjs` already parses, so they appear **beside the agreed design** with no extra step.

**A shot is the proof of an assertion, and the folder is a snapshot of the last run.** Assert, then shoot —
one shot per *state*, not per assertion, because a URL that changed, a console that stayed quiet and a button
that is genuinely `disabled` have no picture. `check` reports both directions, `SHOT WITH NOTHING ASSERTED
ABOVE IT` and `STATES ASSERTED BUT NOT SHOT`. The name is
`<screen>__<journey>-<state>-<viewport>.png` — no timestamp, no counter, so a re-run overwrites and nothing
accumulates; the journey sits in the *state* segment because `review.mjs` pairs by **screen slug**.
**Overwriting alone is not enough**: a run where step 5 fails would leave step 6's picture from the *previous*
run looking current, which is worse than accumulation because it is plausible. So the scaffold clears this
journey's own shots for this viewport in a `beforeAll` — a missing shot must read as missing. And this is
**not** `toHaveScreenshot()`: a pixel baseline fails on a diff, which puts aesthetic judgement in the suite
instead of with a human, and is flaky over real data besides.

**Typecheck the specs, because Playwright does not.** It transpiles TypeScript and never checks it, so an
error in step 4 surfaces only when step 4 runs — and step 4 is what does not run when step 2 fails.
`journeys/tsconfig.json` extends the app's and adds Node types; `npx tsc -p journeys --noEmit` is the gate.
The app's own `typecheck` is deliberately left alone: it sets `types: ["vite/client"]` and excludes
`journeys/`, both correct for a browser build.

**Manually invoked, and nothing gates on one existing.** It starts containers and drives a browser. `codegen`
prints a one-line prompt once two slices with screens are claimed; that is all the scheduling there is.

**The run that counts is against compose, not Vite.** Vite proxies `/api` itself, so it cannot see a wrong
nginx `proxy_pass` prefix, a missing `ASPNETCORE_ENVIRONMENT` that leaves the seed unapplied, or a runtime that
cannot do Wolverine's codegen. All three have happened, and each renders as **an empty screen with no error** —
which is why the check is `watchForSilentFailure` plus *assert real data*, not *assert no error*.

**One thing is still not in the model and is not derivable: how a user reaches a screen.** There is no notation
for *"the modal opens from the list"*, and `ui-journey` invents none — `plan` flags every screen no data path
reaches and asks. The answer lives in the spec's own doc comment, which is then the only place in the system it
is written down. So green now means **every slice works, the named journeys compose behind the API, and the
named journeys are walkable in front of it.**

### `status=` decides which tests run

A slice at `in-design` has not been claimed, so its GWT tests are generated but **skipped**. From
`ready` onward somebody is answerable for them and they run. Without this, one finished slice is
invisible — 55 failures look identical whether nothing is built or everything but one thing is — and
the skip count becomes the honest measure of what is left.

```
Failed: 10, Passed: 0, Skipped: 45, Total: 55     # one slice claimed, the rest documentation
```

**But `status=` only decides this AT SCAFFOLD TIME, and that is a trap.** The skip is baked into the test
file from `status=` when the file is first written, and the test file is `scaffold` — so it is **kept**.
Generate a slice while it is `in-design`, promote it later, and **its tests go on being skipped for ever**,
reporting `Skipped` where the gate depends on `Passed`. `codegen` now reports this as
`TESTS STILL SKIPPED ON A CLAIMED SLICE` and names the file; the fix is deleting the `Skip` argument by
hand, because a generator must not edit inside a file somebody else owns. The first project never hit it
only because its first slice was already `ready` when it was generated.

### Example data comes from `IInitialData`

The model declares field names and types but **never example values**, which is why tests cannot be
fully generated. Marten's `IInitialData` is the answer: seed the foreign/genesis events once with
fixed ids, and `ResetAllMartenDataAsync()` re-applies them before every test. Values live in one
`SeedData` class — `SeedData.SubjectId`, `SeedData.Period`, `SeedData.EligibleDay` — so a GIVEN can
name things and a failing test is reproducible.

### `enforce=` on a GWT — where a rule is checked

`periphery` (FluentValidation, rejected before any stream is read) or `aggregate` (default, needs
accumulated state). **This is declared, not derived.** The obvious heuristic — "no `given=` means the
request alone settles it" — fails on a real model: almost every GWT carries a *context* `given=` like
*"the period is still open"*, so on the worked model it found zero periphery rules out of four. The default is
the safe one, because a state rule placed in a validator cannot enforce itself.

### When the kit and the critter-stack docs disagree, the docs win

**Standing rule, and it means the kit gets CHANGED — not documented as a difference.** If `reference/llms/`
says Marten or Wolverine does X and this kit does Y, adopt X. These libraries move faster than model
knowledge, which is the entire reason the mirror exists; a kit that keeps its own opinion alongside theirs
is a second source of truth that nobody reconciles, and the difference silently becomes a bug in generated
code that compiles and passes.

It has already paid for itself once. `Inline` on every read model was justified in this file by two claims
the mirror does not support — that Marten *"registers multi-stream projections `Async` by default"* (it has
**no** default; the argument is required, and 22/22 call sites in the mirror pass it) and that `Inline`
*"invites apparent event skipping"* (that is an async-daemon high-water-mark phenomenon, attributed
backwards). The docs say plainly: *"Register the lookup projection inline and the multi-stream projection
async."* `codegen` now does exactly that.

**Auditing for this is a real task, not a reflex.** The claims worth re-checking are the ones about
**defaults and behaviour**, not API names — a wrong method name fails to compile, while a wrong default
ships. When one is found, fix the generator, fix this file, and record it in KIT-FINDINGS: a corrected
claim that leaves the old sentence standing somewhere else is how the kit ends up disagreeing with itself.

### The mirror is not infallible either

Two API facts the docs got wrong or never stated, both caught by compiling:

- **`JasperFx.Resources` is a namespace, not a package.** Inferring a package id from a `using` in a
  doc sample fails restore.
- **`JasperFxEnvironment` is in `JasperFx.CommandLine`**, not `JasperFx` as the migration guide says.
- **The two projection base classes are in different namespaces**:
  `Marten.Events.Aggregation.SingleStreamProjection<,>` but
  `Marten.Events.Projections.MultiStreamProjection<,>`. No doc page states either.

The last two were settled by **reflecting over the assembly with a .NET 10 file-based app**
(`dotnet run probe.cs` with a `#:package` directive) — that is the tiebreaker when the docs and the
compiler disagree, and it takes about a minute.

**A NuGet package's own `.xml` doc file is faster, and often enough.** It ships beside every `.dll` under
`~/.nuget/packages` and carries fully-qualified names for every documented member, so a grep answers "which
namespace is this in?" in seconds — that is how
`Wolverine.RDBMS.Transport.ExternalDbTransportExtensions.ListenForMessagesFromExternalDatabaseTable` was
found, along with `SendMessageThroughExternalTable`, a testing helper documented on no page at all. It lists
only **documented** members, so a miss proves nothing and a hit is definitive.

**And the mirror can be AHEAD of the version you have pinned, which reads exactly like a namespace mistake.**
`WaitForExecutionOf<T>(n)` is documented on the testing page — and described as being for messages published
out of band by a Marten subscription or projection side effect, which is the most tempting API in the section
for anything this kit does. It **does not exist in Wolverine 5.40.1**: not on `TrackedSessionConfiguration`,
and the string is not in `Wolverine.dll` at all. `WolverineFx 5.*` resolves below the docs. So when a
documented member will not compile, the question is *which version am I on* before it is *which namespace*.

So: read the mirror, grep the package `.xml`, then **compile**. The mirror removes most of the guessing, not
all of it.

Everything a generator cannot decide, and the traps found by running rather than reading, are in
[.claude/skills/codegen/SKILL.md](.claude/skills/codegen/SKILL.md).

**Smells the checker cannot see are catalogued in [ANTI-PATTERNS.md](ANTI-PATTERNS.md)**, with the
tooling-catches-it column made explicit. Read it before trusting a green run.

### The four documents, and which one to open

| | |
| --- | --- |
| **CLAUDE.md** (this file) | how the kit works. The instruction set |
| **[KIT-FINDINGS.md](KIT-FINDINGS.md)** | **what is still open.** Short, and the one to read. Also carries the standing rules |
| **[KIT-HISTORY.md](KIT-HISTORY.md)** | the archive: every run, every fixed bug, and the reasoning that produced the fix |
| **[ANTI-PATTERNS.md](ANTI-PATTERNS.md)** | smells no tooling catches |
| **[reference/BOOK-INDEX.md](reference/BOOK-INDEX.md)** | **where every rule in this file comes from.** Chapter map into both books, by line number, plus what the books license that the kit has not built |

**Both books are committed, as extracted text, in `reference/`.** *The little Eventmodeling Book* is free
and *Understanding Eventsourcing* is pay-what-you-want; the PDFs stay out (64 MB of binary git cannot
diff) and `tools/pdf-text.mjs` regenerates the text. **Read the index before asserting what a book says** —
grepping them only finds what you already suspect exists, which is how an entire chapter got paraphrased
uncredited for months (KIT-FINDINGS AD20).

**Finding IDs (`W6`, `AD11`, `Z6`) are stable and never reused**, and a citation resolves with
`grep -n "AD11" KIT-FINDINGS.md KIT-HISTORY.md` — an ID lives in whichever file matches its status, and
only ever travels from findings to history. Citations elsewhere in this file say *"KIT-FINDINGS X"*
because that was the single file's name until the split; they are not stale.

## Keep it simple, but prepare for evolution

The standing principle for codegen, and the reason for several choices that would otherwise look
like over-engineering:

- **The system IR separates `shared` from `slices`** even though generation is currently sequential.
  That split is what makes a parallel fan-out possible later without redesigning anything.
- **Slices are nowhere near independent.** In the worked model one aggregate was touched by
  4 commands across 4 slices, a second by 4, and every event fed 2–5 views. So "generate a
  slice" can never mean generating its events and projections — several slices would each write the
  same file. Events, aggregates, views and the GWT tests are generated **once, from the whole
  system**; only handlers, endpoints, pages and slice-local validators are per-slice.
- **The agent tree stays flat.** Subagents do not reliably get to spawn subagents, and workflow
  nesting is one level. An orchestrator fans out `(slice × side)` directly rather than
  slice-agents-spawning-side-agents.
- **Do one slice end to end before any orchestration.** Throughput is worthless before correctness,
  and a fan-out is impossible to debug if a single slice has never succeeded.

## How the bilateral link works

Two independent paths reach the same file. Prefer the first.

**1. Plain file tools (default).** A `.drawio` file is mxGraph XML. Read/Edit/Write it directly.
Fastest, fully diffable, no server involved. Requires the XML to be *uncompressed*.

**2. The `drawio` MCP server** (`.mcp.json`, `@drawio/mcp`, local stdio). Use it when:
- the file is compressed — `get_page` decompresses transparently, plain Read cannot
- the file is multi-page — `list_pages` / `get_page` / `set_page` touch one page and leave the rest byte-identical
- you need a real shape style — `search_shapes` returns exact style strings for AWS/Azure/GCP/UML
  rather than you inventing them

Note: `set_page` preserves the file's existing compression. A compressed file stays compressed
and therefore stays invisible to plain Read.

### Gotchas — already paid for, don't rediscover

- **`npx` cannot launch the MCP server on this machine.** `cmd /c npx -y @drawio/mcp` dies with
  `0xC0000409` on cold start, so `.mcp.json` invokes `node node_modules/@drawio/mcp/src/index.js`
  directly. The package is a devDependency — run `npm install` if `node_modules` is missing.
- **drawio.com's MCP docs are stale.** They describe the server as generation-only. v1.5.0 ships
  `list_pages` / `get_page` / `set_page` against local files. Trust `tools/list` over the docs.
- **Claude → editor is already live. Measured, not assumed.** An earlier version of this file said an
  open draw.io tab was a stale snapshot that never noticed the file changing underneath it, and that
  saving it destroyed Claude's work — so the rule was *answer no, then close and reopen*. **That is
  wrong on `hediet.vscode-drawio` as installed here.** The three-part probe, run against
  `tools/fixtures/cart/cart.drawio`: a cell written by plain `Edit` **appeared in the open tab with no
  reload and no prompt**; the tab did **not** go falsely dirty
  ([issue #215](https://github.com/hediet/vscode-drawio/issues/215) is fixed); and closing afterwards
  did **not** offer to save anything. The extension uses draw.io's merge API on external change.
- **A merge flushes the human's unsaved edit to disk too.** With a genuinely dirty tab — a box moved
  and recoloured, never saved — an external write from Claude landed, and the file on disk then held
  **both** changes. No autoSave is configured at either project or user level, so the merge itself
  writes. The practical consequence is the good one: **concurrent editing does not lose either side**,
  so Claude no longer has to ask the human to close the tab before it edits.
- **Still save-triggered in the other direction.** Claude sees the human's changes when they reach
  disk, not as the cursor moves — and per the bullet above, a Claude write is one of the things that
  makes them reach disk. True push-live would need `lgazo/drawio-mcp-server`, which is **browser-only**
  (Chrome/Firefox extension or its own hosted editor; its README rules out the VS Code extension and
  documents no local-file round-trip). Adopting it would cost both the VS Code surface and
  file-is-truth, to buy a direction we already have. Not installed, and now for a stated reason.
  [`abossard/drawio-mcp`](https://github.com/abossard/drawio-mcp) is the VS-Code-shaped alternative if
  one is ever wanted — but its live update *is* plain file writes plus the merge proved above, so it
  adds tooling, not capability.
- **The human is a read-only observer, and that is a deliberate division of labour.** The draw.io tab
  is open to *watch* Claude edit, not to edit alongside it — so the live direction that matters is
  disk → editor, and it works. Claude owns every write to the `.drawio`.
- **A human Ctrl+S would reformat the whole file** — latent, not a current problem, because of the
  bullet above. draw.io's serializer rewrites every line: 2-space → 4-space indent, attributes
  reordered with `id=` moved last, `/>` self-closing, `host="Electron"` → `host="<hash>"`. Six lines
  of content measured **479 insertions / 473 deletions**, so *"fully diffable"* holds only while the
  human does not save. If hand-editing ever starts, canonicalising both serializers is the fix; until
  then `git checkout -- <file>` reverts an accidental save, which is the standing reason to commit the
  model at every milestone.
- **MCP and memory are both cwd-scoped.** A session started outside this folder sees neither
  `.mcp.json` nor this project's memory. Durable knowledge belongs in this file.
- **`code <folder>` hijacks an empty VS Code window.** Pass `--new-window` when the current
  window holds a live conversation.

**Answered: the VS Code extension saves uncompressed.** This was an open question here until a real
human Ctrl+S settled it — the saved file was plain, readable mxGraph XML, so the default plain-file
path survives a human edit and no `inflate` step is needed. `node tools/drawio.mjs check <file>` is
still the way to confirm for a file of unknown provenance.

## Driving the kit by voice

**The human dictates and does not type; the diagram is watched, not edited.** Both halves are
deliberate. Combined with the live merge above, the loop is *voice in, picture out*: talk, and watch
the draw.io tab redraw. It also makes the kit demoable — push-to-talk means the mic is open only while
the key is down, so what is said to a room stays off the wire.

**This is native, and MCP is the wrong layer for it.** An MCP server is called *by* Claude during a
turn; it cannot start one. A `listen()` tool would only work inside an already-running turn, which
inverts control, cannot be interrupted, and bills every round trip. The STT MCP servers that exist
work around this with a terminal keybinding that types into the input — bypassing MCP for the part
that matters. It is a client concern and lives in the client.

### The surface is the VS Code panel, and it is not the one the docs describe

**This kit is driven from the Claude Code VS Code extension panel — never the terminal TUI.** That is
a standing decision, and it decides everything below, because *the two surfaces have completely
different voice implementations and share no configuration.*

| | Terminal TUI | **VS Code panel** ← ours |
| --- | --- | --- |
| Turned on by | `/voice [hold\|tap\|off]`, persisted to settings.json | **nothing — it is on whenever it can be** |
| Config key | `voice: { enabled, mode }` (and a mirrored `voiceEnabled`) | **none. Both keys are ignored** |
| Trigger | a rebindable key, `Space` by default | **the mic button, or `Ctrl+D` (`⌘D` on Mac)** |
| hold vs tap | a mode you must choose | **both, always, no setting** |

So **`/voice` does not exist here** and neither does `~/.claude/settings.json`'s `voice` block — a
correct-looking one can sit in that file doing nothing, which is exactly how this was mis-documented
for a while. Read from the shipped extension bundle, the whole gate is:

```js
isSpeechToTextEnabled() {
  if (vscode.env.remoteName) return false;                       // no SSH / devcontainer / web
  if (auth.getAuthStatus()?.authMethod !== "claudeai") return false;
  return nativeAudioModuleLoads() || hasRecOrArecordOnPath();
}
```

Nothing else. If the mic icon is missing from the right-hand edge of the input box, it is one of those
three — not a setting you forgot.

### `Ctrl+D` is push-to-talk and tap-to-toggle at once

One key, and which one you get is decided by how long you hold it — there is no mode to pick:

- **Hold past a short threshold, release → stops.** True push-to-talk: the mic is open only while the
  key is down, which is the property that makes the kit demoable in a room.
- **Tap and release quickly → latched.** Tap again, or click the mic, to stop.
- **The panel losing focus stops recording**, so alt-tabbing cannot leave the mic open.

**Neither path submits.** The transcript lands in the input and the human presses Enter — the pause is
the proofread, and here it is free rather than something `autoSubmit: false` has to buy. (The TUI's tap
mode *does* auto-submit with no opt-out; that is a TUI problem, and one more reason not to use it.)

`Ctrl+D` is a webview key listener, not a VS Code keybinding — so it fires only while the Claude panel
has focus, there is no `keybindings.json` entry to write, and it does not collide with the editor's own
`Ctrl+D`, whose `when` clause is `editorTextFocus`.

### Auto-post: asked for, investigated, deliberately not built

**There is no auto-submit on this surface and no setting that adds one.** `autoSubmit` occurs zero times
in the webview bundle; the `voice.autoSubmit` key in the settings schema is the TUI's, and the extension
host *defines* that schema without ever reading it. The stop path calls `stopSpeechToText()` and nothing
else. So this is not a configuration question and there is nothing to search for again.

**And a naive workaround is worse than it looks.** `stopSpeechToText()` flips the UI out of recording
**synchronously**, but the transcript keeps arriving on the channel until the *host* closes it. The STT
stream runs with `endpointing_ms: 300` and `utterance_end_ms: 1000`, so the tail of the last sentence can
land up to about a second after the key comes up. An Enter fired on release — by a macro or by a fast
human — submits a **truncated prompt that looks complete**. Any real implementation would have to hook
the channel closing, not a timer.

The two ways to get it were priced and declined: an AutoHotkey macro (a guessed delay, and it would fire
after the first tap in tap-mode too), or patching `webview/index.js` (correct timing, but it modifies a
signed extension that VS Code silently overwrites — 2.1.215 → 2.1.223 inside one day).

**The pause is load-bearing, which is the actual reason** — and the next section is what it is guarding
against. Enter is where a mis-heard *type* gets caught; `add-slice`'s gap list is the second net, not
the first.

### What voice gets wrong here, and why it mostly does not matter

Transcription is tuned for coding vocabulary and auto-adds exactly two recognition hints: **the project
name and the git branch**. There is **no user-configurable vocabulary** — no dictionary, no term list.
So this kit's own jargon is unhinted: `aggregateId`, `swimlane`, `GWT`, `em=`, `binds=`, `.drawio`, and
the unfortunate one — **`Marten` transcribes as `Martin`**, which is also the maintainer's name.

It matters less than it would in an editor, because **Claude is the error-correcting layer**: the
vocabulary is small and closed, so "cart items read model" resolves to `rm-cart-items` and "Martin" in
a sentence about projections is obviously the library.

**The exception is where precision *is* the content** — `fields="aggregateId:UUID, price:Double"`. A
mis-heard *type* is a silent domain error that reaches generated code and compiles. This is exactly
what `add-slice`'s gap list is for: every attribute must trace to a sentence in the brief, and the
remainder is asked rather than filled. Under dictation that discipline stops being bureaucracy.

### Requirements, and the one that is a policy question

Needs a **Claude.ai account** — unavailable on a raw Anthropic API key, Bedrock, Vertex or Foundry —
an organisation **without HIPAA compliance enabled**, and a **local window**: `vscode.env.remoteName`
being set disables it outright, so Remote-SSH, Dev Containers, WSL-remote and Claude Code for web all
lose dictation regardless of whether a microphone exists.

Capture is a **native module the extension ships**, at
`resources/audio-capture/<arch>-<platform>/audio-capture.node`, with `rec`/`arecord` on `PATH` as the
only fallback — neither of which exists on Windows. So on this machine the native module loading *is*
the audio backend: if a future extension update ships without the `x64-win32` build, the mic silently
disappears and no setting will bring it back.

**Audio is streamed to Anthropic's servers and is not processed locally**, which is the fact to weigh
before dictating client-confidential domain detail. Transcription consumes no tokens and does not count
toward `/usage`.

Dictation language follows the `language` setting and falls back to English — **unverified on this
surface**, since the panel streams audio from the extension host rather than through the CLI.
**Hungarian is not among the 20 supported languages** either way; dictate in English.

### When it stops working, in the order worth checking

1. **Reload the window.** The extension updates itself in place while VS Code is running, so an old
   extension host keeps serving the old webview. This is the most likely cause of "it worked yesterday".
2. **Look for the mic icon** at the right edge of the input box. Absent means the gate above failed;
   present but disabled means the OS denied the microphone, and the tooltip says which settings panel
   to fix it in.
3. **`Claude Code: Show Logs`** from the command palette. There is no `/voice` to interrogate, so this
   is the only place a reason is written down.
4. **Do not go editing `~/.claude/settings.json`.** Nothing in it affects this surface, and a `voice`
   block there is inert — the reason this section exists.

## Always close the loop by looking at the diagram

Never hand over diagram XML you have not rendered. Layout bugs — edges crossing through
boxes, overlapping labels, nodes outside their lane — are invisible in XML and obvious in a PNG.

```
node tools/drawio.mjs render <project>/diagrams/ordering.drawio   # -> ordering.png
```

Then Read the PNG. Fix what you see. Re-render. This caught two bad edge routes while this
project was being set up.

## Helpers

```
node tools/drawio.mjs check   <file>   # is this readable as plain XML, or compressed?
node tools/drawio.mjs inflate <file>   # decompress in place, making it plain-Read-able
node tools/drawio.mjs render  <file>   # export a PNG beside the file
node tools/crop.mjs <file> <x0> <x1> <out>   # an x-window of a wide model, so it renders legibly
node tools/verify-mcp.mjs              # re-prove the MCP read/write link end to end

node tools/slice.mjs add      <file> --slice <n> --pattern <p> [--at start|end|before:<s>|after:<s>]
node tools/slice.mjs swimlane <file> --label <t> --streams <A> [--identity <f>]   # + the cascade
node tools/slice.mjs actorlane <file> --actor <name> [--kind person|system]       # who USES the screens
node tools/slice.mjs journey  <file> --journey <slug> --slices <a,b,c> [--then <outcome>]
node tools/slice.mjs route    <file> --from <id> --to <id>    # allocates a routing y in the right band
node tools/slice.mjs identity <file> --band <id>              # propagate the stream key onto its events
node tools/slice.mjs demote   <file> --from-diff              # impacted slices back to in-design
node tools/slice.mjs reflow   <file>                          # re-derive lane/page geometry
node tools/fixtures/cart-replay.mjs          # the book's cart model in nine appends — the MODEL half of the suite

node tools/wireframe.mjs scaffold <file>     # grow the UI lane, scaffold bound wireframe cells
node tools/design.mjs shot  <file.html>      # render one design page to PNG, per viewport
node tools/design.mjs sheet <designs-dir>    # shoot every screen, build the contact sheet + index
node tools/design.mjs check <system-dir>     # the styled pages against the model's displays=/inputs=

node tools/review.mjs shot <url> --screen <slug> [--state <n>]   # shoot the RUNNING app
node tools/review.mjs sheet                  # design beside implementation, per screen, per viewport
node tools/review.mjs clear                  # throw the shots away and start again

node tools/uijourney.mjs plan     [--journey <slug>]   # what a UI journey would walk, and what the model cannot say
node tools/uijourney.mjs scaffold [--journey <slug>]   # playwright config, shot helper, one spec per journey
node tools/uijourney.mjs check               # a spec that fakes its backend, skips its navigation, invents a selector

node tools/project.mjs init --project <path>   # scaffold a project; point this kit copy at it
node tools/project.mjs where           # which project this copy writes to
node tools/project.mjs inbox           # what is in the baseline, and what cannot be read
node tools/project.mjs palette         # do the three draw.io settings copies still agree?

node tools/architect.mjs questions      # the concurrency/consistency choices the model leaves open
node tools/architect.mjs record         # a section per question in <project>/ARCHITECTURE.md
node tools/architect.mjs tests          # a RACE test per contended invariant — no GWT can express one
node tools/architect.mjs check          # unanswered, still TODO, or answered but now orphaned

node tools/model.mjs validate <file>   # one model
node tools/model.mjs validate          # every model in the project, plus the cross-model rules
node tools/model.mjs map               # (re)generate diagrams/_context-map.drawio from the real edges
node tools/model.mjs compile           # the system IR a generator reads -> <project>/build/<system>.ir.json
node tools/docs.mjs sync               # mirror Marten/Wolverine/Alba docs into reference/llms/
node tools/codegen.mjs                 # the deterministic code -> <project>/generated/<System>/
```

### Testing the kit itself — the `kit-test` agent

**`cart-replay.mjs` is the regression suite for the MODEL half and stops at the `.drawio`.** Nothing
in the kit has ever run `codegen.mjs` and then `dotnet build`, which is how a generated project that
does not compile shipped twice — once from an automation label of more than one word, once from a
`fields=` type that is not a C# type. Both are in KIT-FINDINGS as **W6** and **W9**; the missing check
is **W8**.

`kit-test` is that check, as a **manually invoked agent** rather than a script, because most of what
it hunts needs judgement: *is this tool silently doing nothing, or is there genuinely nothing to do?*

```
"run kit-test"        # there is no CLI entry point — it is .claude/agents/kit-test.md
```

Five tiers, cheapest first: the existing sweep; **tools that succeed while doing nothing** (the
highest-value tier — `wireframe.mjs` reported "no screen cells" on a fixture with four, and had never
once worked); CRLF round-tripping, since every `.drawio` here is CRLF; generate-and-build, per fixture;
and the awkward-input classes that only bite on multi-word labels or a promoted `status=`.

**It reports and never fixes** — no `Write`, no `Edit`, deliberately. A test that repairs itself has a
stake in the run being clean, and its own repair is the one change nothing has tested. Same reasoning
that keeps `completeness-checker` outside the model it audits.

**Validate the folder, not the file.** A single file cannot see whether an imported event is
actually published anywhere; only the whole-project run can. `compile`, `mark` and `clear` still
take one file. With no argument the folder commands mean `<project>/diagrams/`, which is the only
thing they could sensibly mean when one kit copy serves one project.

A real model runs thousands of pixels wide, and a whole-model PNG downscaled to fit a screen is
too mushy to spot layout defects in — which defeats the point of rendering. `crop` writes a
throwaway window to look at. It drops edges whose other endpoint fell outside the window, so the
output is never a valid model: look at it, then edit the source.

## Event Modeling conventions

Colours are the book's, not ours: *"We use sticky notes in different colors—blue, orange, green,
and yellow"* — Commands in blue, Events in orange, Read Models green, and **external events in
yellow** ("indicating that external data is entering the system during this process step").
Fill/stroke pairs are preset so the same swatches appear in the draw.io colour picker, in this
order. **`templates/drawio-settings.json` is the one authored copy**, and there are three mirrors of
it because every one of these keys is **window-scoped**: in a multi-root window VS Code ignores a
folder's `.vscode/settings.json` outright, so the `.code-workspace` needs its own copy, and the
project needs one to be legible when opened without the kit at all.

```
node tools/project.mjs palette     # do the three copies still agree?
```

That check exists because they drifted once: the workspace file sat on six colours while the kit had
eight, so the external-event yellow and the GWT grey were missing from the picker entirely — and a
hand-coloured cell is what `em=` falls back to when a cell has not been annotated. Edit the canonical
file, then bring the mirrors into line.

| Element | `em=` | Lane | Fill | Stroke | Source |
| --- | --- | --- | --- | --- | --- |
| Screen / wireframe | `screen` | UI | `#ffffff` | `#666666` | book |
| Command | `command` | Commands / Views | `#dae8fc` | `#6c8ebf` | book (blue) |
| Event | `event` | Event Stream | `#ffe6cc` | `#d79b00` | book (orange) |
| External event | `external` | Event Stream | `#fff2cc` | `#d6b656` | book (yellow) |
| Read model / View | `readmodel` | Commands / Views | `#d5e8d4` | `#82b366` | book (green) |
| Automation / processor | `automation` | Commands / Views | `#e1d5e7` | `#9673a6` | ours |
| Given / When / Then | `gwt` | GWT band | `#f0f0f0` | `#999999` | ours |
| Slice group label | `group` | left of a slice | `#f8cecc` | `#b85450` | book (pink) |
| Journey | `journey` | a bar below the GWT band | `#e6eef7` | `#6c8ebf` | ours |
| Model context note | `model` | top-left, above the lanes | `#f8cecc` | `#b85450` | book (pink) |
| Wireframe field | `field` | inside a screen | `#f0f0f0` / `#ffffff` | `#dddddd` / `#999999` | ours |
| Wireframe action | `action` | inside a screen | `#dae8fc` | `#6c8ebf` | ours |
| Wireframe chrome | `chrome` | inside a screen | none | none | ours |

A `field` is drawn white-on-grey when it is typed (`inputs=`) and dashed grey when it is only shown
(`displays=`), so a wireframe reads as a form at a glance.

Rules:
- Events are past tense (`OrderPlaced`), commands imperative (`PlaceOrder`).
- Events only ever enter the Event Stream lane. Nothing else goes there.
- An event never points at another event, and never at an automation. Every connection must be
  part of one of the four patterns below.
- One Command per State Change slice. The little book, chapter 6, on more than one command:
  *"No."* More than one Event is allowed but *"should not be the rule."*
- Give every cell a stable, meaningful `id` (`evt-order-placed`, not `node7`), so edits stay
  reviewable in diffs and edges keep resolving.
- On edges that would otherwise cut through a box, set explicit
  `exitX/exitY/entryX/entryY` hints. The free band between lanes is the place to route.

## Cell data: the semantics live on the cells

The diagram is the single source of truth, so payloads live on it too — as custom attributes on
`<object>` cells. draw.io exposes them to a human through *Edit Data* (Ctrl+M); Claude edits the
same attributes as XML. Verified: adding them does not change the rendered picture.

```xml
<object id="evt-order-placed" label="OrderPlaced" em="event" slice="place-order"
        aggregate="Order" fields="orderId:Guid, placedAt:DateTimeOffset">
  <mxCell style="fillColor=#ffe6cc;strokeColor=#d79b00;..." vertex="1" parent="1">
    <mxGeometry x="100" y="470" width="180" height="60" as="geometry" />
  </mxCell>
</object>
```

| Attribute | On | Meaning |
| --- | --- | --- |
| `em` | every element | which building block this is (table above) |
| `slice` | every element | the slice it belongs to; unassigned elements generate nothing |
| `fields` | command, event, readmodel | `name:Type` list. The book's "attributes" |
| `aggregate` | command, event | which aggregate owns the stream |
| `displays` | screen | data the screen shows — the elements the book marks green on the wireframe. Must be supplied by a View |
| `inputs` | screen | data the user types here. A terminal source: information entering the system |
| `mappings` | any | `targetField=sourceField`, for legitimate name mismatches. A **rename only** |
| `derived` | any | `target=a+b`, for a value that is *computed* from upstream rather than carried |
| `terminal` | command, event | `name:kind`, for a value that enters from context, not from the data flow |
| `given` / `when` / `then` | `gwt` | prior events / the command / expected events. `then="error: RuleName"` for an expected rejection. Any step may carry **example data** — `Label(field=value, …)` |
| `rule` | `gwt` | the business rule this GWT names |
| `pattern` | slice cell | which of the four patterns this slice is — checked against what it's made of |
| `journey` / `slices` | `journey` | the journey's slug, and the **ordered** run of slices it walks end to end through the API |
| `status` | slice cell | where the slice sits in the implementation workflow |
| `screen` | screen | the screen's identity. Cells sharing a slug are one screen |
| `joins` | screen | the attribute two or more feeding Views are lined up on. `"none"` = never correlated |
| `binds` | `field` | which `displays=`/`inputs=` attribute this wireframe element shows |
| `command` | `action` | which Command this affordance issues — checked against the screen's edge |
| `context` / `system` | model cell | which business context this model is, and which system it belongs to |
| `public` | event | another model in this system may consume it. The only public surface there is |
| `actor` | an **actor lane** | which person or system uses the screens drawn in this band. Makes the cell an actor lane, exactly as `streams=` makes one a swimlane |
| `actorKind` | an actor lane | `person` (default) or `system`. Never a role — roles are an implementation detail both books refuse |
| `from` | external | the sibling model that publishes it — **checked** |
| `origin` | external | a genuinely foreign system — a claim on record, unverifiable |
| `ingested` | external | `"true"` acknowledges that **we append this foreign event into a stream of ours**. Another claim on record |

`displays` is what makes the check two-directional. Without it a read model can be missing every
attribute and nothing notices, because nothing states what the screen needed.

### Two Views on one screen must have something to line up on — `joins=`

**This is the hole that let a model the book calls incomplete pass at zero errors.** Ch. 16 of
*Understanding EventSourcing* exists to demonstrate the completeness check finding a missing field: a stock
indicator is shown *"for each item in the cart"*, the cart's own read model had no `productId`, and the
book's team discover *"we haven't modelled the product-id yet. This is important."*

The kit found nothing. The check is **name-based**: `productId` *was* supplied — by the Inventories view,
which is keyed by it — so the name resolved and everything looked sourced. What it could not see is that the
two views had **no field in common**, so no row of one could ever be matched to a row of the other. **A join
is not a name lookup.**

So a screen fed by two or more Views must share at least one attribute across all of them:

| | |
| --- | --- |
| nothing shared, nothing declared | **warning** `screen-views-cannot-join` — the key is missing from one of them, *and from the events and command behind it* |
| `joins="productId"` | checked: every feeding View must carry it, or **error** `join-not-supplied` |
| `joins="none"` | acknowledged — this screen shows unrelated figures side by side and never correlates them |

**A warning rather than an error**, because whether a screen *needs* to correlate is a question only a human
can answer — a dashboard showing total revenue beside active users needs no join and never will. Same house
style as the Conway rule: warn on the unacknowledged case, note the acknowledged one.

Verified against the book both ways: silent on the model as ch. 16 fixes it, and on the model as ch. 12
leaves it, it names both views and says what to add.

Type suffix `?` means nullable. Generators read the compiled IR, never this XML.

### Three ways an attribute gets its value, and they are not interchangeable

An attribute that no upstream source supplies by name is red. There are exactly three honest ways
to answer that, and picking the wrong one produces code that compiles and is wrong.

| | Means | Generator emits |
| --- | --- | --- |
| `mappings="total=totalAmount"` | the **same value** under another name | an assignment |
| `derived="dayTotal=hours"` | **computed** from upstream — a sum, a count, a fold | a fold |
| `terminal="closedBy:actor"` | arrives from **context**, not the data flow | a handler lookup |

**A rename cannot change the type.** `mappings="dayTotal=hours"` claims dayTotal *is* hours; it is
really their sum. `mappings="month=date"` claims a `string` *is* a `DateOnly`. Both pass a
name-match and both are lies a generator will act on, so a mapping whose declared types differ is
warned as `mapping-crosses-types`.

`derived` inputs are checked: each must be an attribute an upstream source supplies, **or the
label of an upstream source itself**. That second form is what lets a fold over event *presence*
be stated — `periodStatus=PeriodOpened+ClosureSubmitted+PeriodClosed`, whose "Open"
value is the *absence* of a closure event and which no rename could ever reach. Naming an event
that isn't connected is an error: a derivation cannot invent its inputs.

`terminal` kinds are `actor` (the authenticated principal), `generated` (an id the handler mints),
`clock`, and `const`. Same `name:kind` shape as `fields=`. These are reported as notes rather than
silently skipped, because "the handler supplies this" is a claim worth a reader disagreeing with.

### None of the three says HOW — a GWT with example data does

`derived="total=price"` names the inputs and never the formula. A correspondence between their key and
ours has no notation at all. And a fold's semantics — *"Outstanding until what we accepted catches up"* —
is a judgement nothing in the model records. Same shape every time: **the model says where a value comes
from, never how it is obtained.**

Two of the four notations do not need a *how*, and two do:

| | says WHERE | needs a HOW? |
| --- | --- | --- |
| `mappings=` | a rename | **no** — same value, self-specifying |
| `terminal=` | context | **no** — the kind says it |
| `derived=` | the inputs | **yes** |
| a correspondence lookup | the foreign input | **yes**, plus a failure rule |

Those two are exactly the ones that can be silently wrong. The answer is a **worked example on the GWT**:

```xml
given="PaymentSucceeded(providerCustomerId=cus_A1, amount=42.00)"
when="RecordPayment(customerId=$AcmeCustomer, amount=42.00)"
then="PaymentRecorded(customerId=$AcmeCustomer, amount=42.00)"
```

**`$Name` is a named constant, not a literal** — it resolves to `SeedData.Name`. A model full of raw Guids
is unreadable, and identities shared across tests already live in seed data; a GWT carries the example that
pins *this* rule.

**An example specifies the how well enough to VERIFY, never well enough to GENERATE**, and that is the right
line here — the generator emits what is mechanically derivable and marks the rest `TODO`. Examples
underdetermine a formula (2, 3 → 5 could be a sum or a maximum plus two); what they do is make it testable.

Every part of an example is checked, because an example nobody holds to the model reads as a specification
while asserting a fiction:

| Rule | |
| --- | --- |
| `gwt-example-unknown-field` | the example names a field the element does not declare |
| `gwt-example-type` | the literal cannot be the declared type — **`customerId=cus_A1` against `customerId:Guid` is the whole foreign-key problem in one line** |
| `gwt-example-malformed` | a step is not `name=value` |
| `gwt-example-on-error` | `then="error: X(...)"` — a rejection carries no payload, the rule name IS the outcome |
| `gwt-multiple-whens` | more than one command in a `when=` |

A label may legitimately contain parentheses — the book's own model writes `Inventory Changed (external)` —
so **parentheses alone do not make example data; an `=` inside them does.**

**`derived-without-example` warns where a derived field has no worked example** anywhere in its slice.

It found the case that justifies the whole notation: **`MessageStatus` said "3 recipients" in its GWT label
while the implemented test asserted 2.** Prose in a label is not checked, so the model and the code generated
from it had drifted and stayed green.

### `then=` names an Event on a slice that has a Command — decided, not inherited

A View that a trigger consults is **machinery, not the slice's contract**. What a State Change, Automation or
Translation slice promises is the events it appends; the todo View is one implementation of that promise,
which is why the automation folder can satisfy the drawing with a durable inbox and a translation *must*.

Both books point the same way. The little book's automation shape is *"Given these 2 Events, we expect the
automation to run automatically… and result in **another Event**"*, and ch. 13 omits the WHEN for automation
tests without ever moving the outcome off the events.

**Nothing is lost, which is what makes it safe.** A todo View's fold has observable consequences and they are
all events: get `StockNoticesToApply.status` wrong and either a second `StockLevelSet` appears or a refusal
does — both already pinned by *"the same notice delivered twice is applied once → error: AlreadyApplied"*. So
a derived field on such a View is a **note** (`derived-on-todo-view`), not a warning, and the note asks the
question that matters: would getting the fold wrong change which events appear, and would a GWT catch it? If
not, the missing scenario is an event one.

### Promotion to error, and what is holding it

All **five** reference implementations validate at **0 errors, 0 warnings**. The only `derived-without-example`
left anywhere is **two in `tools/fixtures/cart/`** — `Submit Cart.orderedProducts` and
`Cart Submitted.totalPrice`, both on the `submit-cart` slice.

That fixture reproduces the book, and **the book's model genuinely does not say how `totalPrice` is computed
or with what numbers.** Filling them in means inventing domain facts, which is the one thing this kit refuses
everywhere else. So the warning is correct, and promotion waits for someone with the book — not for a change
to the rule.

**And a `when=` is now checked on every pattern.** It used to be validated only on `state-change` slices, so an
automation, translation or view could name a command that does not exist and hear nothing. Unchecked is not
the same as optional: the WHEN may be *omitted* on those patterns — that is the GT shape — but a WHEN that
is present is a claim like any other.

Note `bookingId` on a booking command: the screen *displays* a `bookingId` — the row being looked
at — while creating a booking needs a **new** one. Same name, opposite meaning, and a name-match
cannot tell them apart. That is `terminal="bookingId:generated"`, not a source.

## The slice cell: a vertical slice is a thing, not a string

A slice used to have no identity — it was a `slice=` string repeated across the cells that
happened to belong to it. So membership was invisible on the canvas (drag a cell into another
column and nothing noticed), the pattern was inferred and never declared, and there was nowhere
to record a fact about the slice itself.

A **slice cell** is that identity: one `em="group"` rectangle drawn around the slice's columns.

```xml
<object id="slice-add-entry" label="add-entry&#10;state-change · in-design"
        em="group" slice="add-entry" pattern="state-change" status="in-design">
  <mxCell style="fillColor=none;strokeColor=#b85450;dashed=1;..." vertex="1" parent="1">
    <mxGeometry x="1260" y="0" width="220" height="645" as="geometry" />
  </mxCell>
</object>
```

Use a **plain rectangle, never a draw.io container.** A container reparents its children and makes
their `mxGeometry` relative to the parent, which breaks every absolute-x reader — `geometryOf`,
marker placement, `tools/crop.mjs`.

`pattern` is one of `state-change`, `state-view`, `automation`, `translation` (the cheat sheet's four),
plus `upstream` for a column that is only external events landing in our stream. It is **checked
against what the slice actually contains** — declaring `automation` on a slice with no View is an
error. Declared and derived disagreeing is a bug worth catching.

**The first two used to be `command` and `view`, and the rename was worth doing.** Those words are
already taken by **element kinds** — a blue Command cell is `em="command"`, and `command=` on a wireframe
action names the command it issues — so `s.pattern === "command"` and `cell.kind === "command"` sat two
lines apart in `model.mjs` meaning different things. `state-change` / `state-view` are what both books
call these patterns, what the `slices[].kind` the IR derives has always called them, and what a human
says out loud. **No alias is accepted:** the old values are now `slice-unknown-pattern` errors, which is
safe because every model in existence was migrated with the rename and the archived projects stay
archived.

A slice must be **one contiguous band**. If a slice's columns aren't adjacent, that's a layout bug:
reorder the columns. A vertical slice that isn't vertical isn't a slice.

Every element geometrically inside a band must declare that `slice=`, and every element declaring
it must be drawn inside. That is what stops the drawing and the data drifting apart.

## The screen: identity, and a wireframe the checker can see

Two problems, both invisible before `screen=` existed.

**A screen had no identity.** It was a repeated *label* — one screen drawn as three separate cells,
with `displays=` hand-copied between them and nothing comparing the copies. Exactly the bug the slice
cell fixed for slices. `screen="entries"` is the slug, and it buys one asymmetric rule:

> **`displays=` must agree across cells sharing a slug. `inputs=` may differ.**

What a screen *shows* is a property of the screen. What it *offers* is a property of the slice — the
same screen offers add, correct and remove in three slices. That asymmetry is load-bearing, not
a convenience: *"there may be only one entry per day+category, so adding again is a
Correction"* is a domain fact about affordances, and it is why one screen legitimately has three
different buttons.

**A wireframe drawn as a picture earns nothing.** The book does draw wireframes and they are
sketch-level, but a grey box the tool cannot read will drift from `displays=` silently. So every
element of a wireframe declares what it is — `em="field" binds="hours"`, `em="action"
command="BookHours"`, `em="chrome"` for decoration. Then the design and the model check each other
in both directions, the same trick `displays=` plays on read models:

- a field bound to something the screen doesn't declare → **error**. The design shows data the
  system cannot supply.
- a declared attribute the wireframe never draws → **warning**. Its View is over-specified.
- an action naming a command the screen has no edge to → **error**. The button and the arrow
  disagree.

Wireframes are **optional and late**: a screen with none is fine, and `field-not-drawn` only fires
once a screen has started to be drawn. Drawing one before the completeness check passes commits to
showing fields that may turn out to have no source.

```
node tools/wireframe.mjs scaffold <file>   # grow the UI lane, shift everything below, bind a cell
                                           # per attribute, read the action off the real edge
```

That is a **scaffold, not a design**. The stacked layout it produces asserts nothing about the real
arrangement — its value is that the cells exist, are bound, and are checked. Rearrange them
afterwards. It is a tool rather than a hand edit because it touches every y and every routing point
in the file.

Keep the wireframe **low fidelity**: no colour, no type, no imagery. It stays legible at model scale,
it cannot be mistaken for the design, and it does not fight the sticky-note grammar.

### Eight skills, and the line between them is what each may invent

| Skill | Scope | Invents | Gate |
| --- | --- | --- | --- |
| `event-model` | once per context | layout only — never a domain fact | the completeness check, deterministic |
| `add-slice` | per slice | layout only — never a domain fact | the same check, plus the ripple reported |
| `scaffold` | once per **system**, then after any model change | nothing — it runs the generator | **the skeleton compiles, 0 errors 0 warnings, and the tests run** |
| `architect` | once per **system**, before the first slice | nothing — it answers what the model leaves open, from the docs mirror | every question has a decision, a reason and a stated cost |
| `styling` | once per **system**, then per new screen | tokens, palette, spacing, components | the human likes it |
| `codegen` | per slice | nothing — it reads the compiled IR | that slice's tests pass |
| `journey` | per **system**, once two slices are `in-review` | nothing — the user names the journeys worth walking | the journey passes AND every slice test still does |
| `ui-journey` | per **system**, once two slices **with screens** are built | nothing — except the navigation, which the model cannot hold and the user must state | the browser walk passes at both viewports against **compose**, and the slice suite still does |

**The order, and the two places it is not obvious:**

```
event-model  →  scaffold  →  architect  →  codegen  →  journey
```

**`scaffold` is separate from `codegen` because they have different gates.** `tools/codegen.mjs` is the
*scaffolder* — it emits the skeleton and no business logic — while the skill named `codegen` is what fills
it. Run as one step, the skeleton's own gate never got enforced: nothing in the kit built generated code,
and two defects shipped through that hole (**W6**, an automation label of more than one word emitted as a
C# class name; **W9**, a domain type emitted verbatim as a C# type — 68 errors). `scaffold`'s gate is
`dotnet build` at 0 errors and 0 warnings, and that is the check that was missing.

**`architect` is really two steps, and they sit on opposite sides of `scaffold`:**

```
event-model  →  architect record + answer  →  scaffold  →  architect tests  →  codegen  →  journey
```

**`record` needs only the model, so it goes first — and for `type-binding` it MUST.** `architect.mjs tests`
is the half that writes race tests into the test project and refuses when there is nothing to write into,
so that half necessarily follows `scaffold`.

**This used to say the opposite, and the correction is measured.** It claimed you could scaffold first and
re-run afterwards because *"everything depending on the bindings is `emit`, and a second run overwrites
cleanly."* **That is false: views, aggregate folds and GWT tests are all `scaffold`**, so they are KEPT on
the second run with the unbound type baked in. Reproduced on the cart fixture — pass 1 reports
`UNBOUND TYPE` and fails with 68 errors, bindings are then recorded, pass 2 reports nothing and still fails
with **20**, all `CS0246` inside kept view files. Recording the bindings *before* the first scaffold builds
clean at 0/0. KIT-FINDINGS **Z6**.

So `UNBOUND TYPE` on a first pass is not "the report working" — it is a project you must regenerate from
scratch, and the report goes quiet on the second pass precisely while it is still true.

**`event-model` and `add-slice` are two directions into one artifact, not two stages.** `event-model`
asks and the user answers — the exploratory path, eleven phases, a whole context. `add-slice`
transcribes a brief the user dictates, one slice, into an empty folder or a model with N slices
already in it. Neither owns the file and a model can alternate between them. What they share is the
rule: **layout is invented, a domain fact never is.** `add-slice` keeps that honest with a **gap
list** — every attribute must trace to a sentence in the brief or to an answer the user gave, and
the remainder is asked, not filled.

**All of the geometry is `tools/slice.mjs`'s, none of it the skill's** — same reasoning as
`wireframe.mjs`: it touches every y and every routing point, and an insert touches every x too. It
emits `TODO:<kind>` placeholders with no `fields=`, because a label is a domain fact. Specified in
`tools/slice.spec.md`; the regression suite is `tools/fixtures/cart-replay.mjs`, which builds the cart
model of *Understanding EventSourcing* ch. 12–17 as the nine successive appends those chapters are —
0 errors at every round, byte-identical on re-run. **The insert is not the exotic case:** ch. 16's
Inventories view feeds the Cart Page in column 1, and a View → Screen edge may not point left, so it
has to go in at position 0 and shift everything. Appending is easy arithmetic and appending is not
what a growing model needs.

**Appending is not a local edit, and that is `add-slice`'s real content.** Ch. 14 of *Understanding
EventSourcing* adds one slice and discovers a missing `aggregateId` that then has to be defined
*"consistently throughout the Event Model"*; ch. 16 runs it backwards, a new View needing a field that
must then be added to an existing event *and* its command. So the completeness check is the append's
**engine**, not just its gate. The little book, ch. 12, gives the mechanic: *"I treat changes to
existing Slices like new Slices… I typically make a screenshot and set it back to Status 'Created'.
Also for example Read Models impacted by new Events. So one change could have impact on several
Slices."* Here that means **an impacted slice past `in-design` goes back to `in-design`** — a View that
gained a field is no longer the View that was signed off.

**`styling` delegates aesthetic judgement to Anthropic's official `frontend-design` plugin** rather
than reinventing design taste — install via `/plugin`. That plugin already supplies the token-system
spec (4–6 colours, 2+ type roles, one signature element), the anti-templated-default heuristics, and
the restraint discipline; its workflow even asks for screenshots to self-critique with, which is
exactly what `tools/design.mjs` provides. `styling` adds only what the plugin cannot know: the field
contract from the model, the `designs/<screen-slug>.html` convention, and the review loop.

The wireframe belongs to `event-model`, and the boundary is not obvious: `binds=` and `em="action"`
carry **business information** — which fields a screen shows, which are typed, and which action it
offers. That last one is a domain fact, not decoration. Colour, type, spacing and components carry
none, so they live in `styling`.

**A dependency graph, not a pipeline.** Styling gates only *frontend* codegen. A model with no
screens is backend-only and can go straight to codegen with no design in existence — a notification-only
context is typically exactly that. Same for any View or Automation slice.

**`architect` is the one step that gates the BACKEND, and it runs once per system rather than per slice.**
It answers the concurrency and consistency choices the model deliberately leaves open, and it has to happen
**before the first slice** — a system-scoped decision made per slice is a decision made four times and
reconciled never. See *Concurrency is not a modelling concern* below. It invents no domain facts and never
edits the model; the one exception is a wrong stream key, which is a domain fact and goes back to
`add-slice`.

**`journey` and `ui-journey` are the two skills nothing schedules, and that is deliberate.** Which stories are
worth walking is a domain answer: it cannot be derived and must not be invented, so nothing runs them for you
and nothing gates on a journey existing. What the kit does instead is **prompt at the moment you can answer
it** — `codegen` prints `NO JOURNEY TESTS` once two slices are claimed and `NO UI JOURNEY` once two of them
have screens, stays silent below that (where a journey is not missing but impossible), and the `codegen` skill
asks before it stops. `ui-journey` is additionally **only ever run when the human asks**, because it starts
containers and drives a browser; the prompt is a prompt and not a queue.

**They share one cell and split on the wire.** A story named once as `em="journey"` is walked through HTTP by
`journey` and through the browser by `ui-journey` — never two cells for one story, because that is the second
place a fact would live. A journey whose slices have no screens is backend-only, which `uijourney.mjs plan`
says out loud rather than reporting as a gap.

The styled design is found **by convention, not by an attribute**: `designs/<screen-slug>.html`. The
slug already exists, so a `design=` attribute would be a second place the same fact lives — the thing
this kit refuses everywhere else. That gives a three-way check, which is `styling`'s to run:

```
displays= / inputs=   ↔   wireframe binds=   ↔   HTML data-em
```

All three must agree on *which fields*. Layout and style are free to differ — that is the point of
keeping them in separate artifacts.

### A design nobody has looked at is worth exactly as much as unrendered XML

*"Never hand over diagram XML you have not rendered"* applies unchanged to CSS. **A human cannot
read a stylesheet and picture the result, and neither can Claude.** So the design gets the same
closing loop the model has, via headless Chrome — already on this machine, no Playwright, no
Puppeteer. (That holds for **shooting a URL**, which is all this and `review.mjs` do. `ui-journey`
does bring Playwright in, because it **clicks** and nothing else here does — see the UI-journey
section above.)

```
node tools/design.mjs sheet
```

It produces three things, and each answers a different reviewer:

| Artifact | For | Why it exists |
| --- | --- | --- |
| `_shots/<screen>-<viewport>.png` | the record | one file per screen per viewport, so a finding can name the one that broke |
| `_shots/contact-sheet-<viewport>.png` | **looking** | every screen at **1:1** in one image. A folder of PNGs has the same defect as a folder of HTML — you open them one at a time |
| `index.html` | the human | live iframes plus a full-size link. A screenshot cannot be hovered, tabbed through, or resized |

**One sheet per viewport, at native width.** A 1440px shot scaled into a shared column is
illegible, which defeats the point of looking; and the sheet is captured at whatever size fits all
its rows, because a fixed height silently crops the last one. Both of those were real defects caught
by rendering the sheet and looking at it.

Always shoot at least a desktop and a mobile width. A single desktop screenshot hides half the
problems.

**A mobile screenshot below 500px used to be a lie, and that is now fixed in one place.**
`chrome --headless=new --window-size=390,…` reports `innerWidth=500`: Windows will not make a real
window narrower than about 500px, so Chrome laid the page out at 500 and cropped the image to 390 —
inventing clipping that did not exist and hiding clipping that did. It cost one wrong diagnosis and two
rounds of CSS "fixes" to a page that was already correct. `tools/shoot.mjs` now renders the page inside
an `<iframe>` of the requested width, which gets a real layout viewport, and **both `design.mjs` and
`review.mjs` capture through it** — which is also the only reason a design shot and an implementation
shot are comparable at all. `--headless=old` is not a way out; modern Chrome ignores it.

### And a design is not the software. Shoot the built thing too.

```
node tools/review.mjs shot http://localhost:8080/ --screen recipes --state default
node tools/review.mjs sheet
```

Lands in `<project>/review/` — gitignored, like `designs/_shots/`, because it is regenerable evidence
rather than source. `review/index.html` puts the **agreed design beside the built software**, same
screen, same width, 1:1, which is the only view in which "does the build match what we agreed" is a
question a human can answer. `--state` names anything with no design counterpart: `rejected`,
`pending`, `empty`, `page2`.

**This is a codegen deliverable, not an optional extra.** A static design page cannot show a wrong API
path, an unapplied seed, a state the port forgot, or a layout that only breaks once real data of real
length arrives. It found one within a minute of existing: shots of `/` and `/?page=2` came back
**identical**, because the pager is component state and never reaches the URL — so a page cannot be
linked, bookmarked or refreshed. Nothing in the test suite had noticed.

**That class of bug now has a test rather than only a screenshot**, and `ui-journey` exists because of this
one: click to the state, assert the URL changed, reload, assert the state survived. `review.mjs` remains the
thing that *shows* a human the result — and `ui-journey` shoots into the same folder, so the states only a
click can reach finally turn up in the same sheet.

## Many small models, one system

> *"It is perfectly fine to have more than one model on a board. In fact, this is the rule rather
> than the exception for me. I prefer having many smaller models over one large model… I aim to
> capture one business context in each model, so I can read it from left to right without any
> visual interruptions."* — Understanding EventSourcing, ch. 18

Four levels, only two of them files. **The project is the system** — one kit copy, one project, one
system, so there is no `<system>` folder to name and nothing repeats the project's own name. A
**model** is one `.drawio` in `<project>/diagrams/`: one business context, one flow. A **slice** is a
slice cell, as always. *Chapters* (Dilger's blue arrows grouping slices inside a model) are the
fourth, and deliberately not built — they solve the same problem as splitting at a smaller scale, so
**prefer splitting.**

```
acme-shop/                        <- the PROJECT is the system, and its own git repo
  inbox/                          <- raw input: briefs, mail, screenshots. The phase-0 baseline
  diagrams/
    ordering.drawio               <- one business context
    fulfilment.drawio
    notifications.drawio
    ordering.errors.drawio        <- an alternative flow of ordering.drawio
    _context-map.drawio           <- GENERATED. Never hand-edit; leading _ excludes it from validate
  designs/<slug>.html
  build/                          <- derived IR, gitignored
  generated/<System>/             <- code and tests, committed
  OPEN-QUESTIONS.md
```

A project that genuinely grows a second, independently-deployable system gets a **second project
folder and a second kit copy**. Splitting one project's diagrams into two systems inside one folder
is not supported, and should not be needed before the point where they want separate repos anyway.

**No manifest file.** No `system.yml`, no index. The diagram is the single source of truth; a
manifest would be a second place facts live. Every fact sits on a cell and anything system-wide is
*derived*. (The kit's `project.json` is not a counter-example: it holds a filesystem path, not a
domain fact, and lives in the kit rather than the project.)

**Each model names itself with a model cell** — `em="model"`, `context=`, `system=`. This is
Dilger's pink "Model Context" sticky, drawn top-left above the lanes. Same precedent as the slice
cell: identity is a cell, not a filename. `context=` must match the file name.

### Only an event crosses a model boundary

Ch. 15 is explicit that you never let another model rebuild your state from your internals. So:

> **A model's only public surface is an event marked `public="true"`. A consumer imports it as a
> yellow external declaring `from="<context>"`.**

Nothing else crosses — no read model, command, screen or unmarked event. A View belongs to the
context that reads it; if two contexts need the same projection, each builds its own from the
events it imports.

An external event now answers *where it came from*, and the two answers are checked differently:

| | Means | Checked |
| --- | --- | --- |
| `from="fulfilment"` | published by a sibling model in this system | **yes** — the label must exist there, be `public="true"`, and its `fields=` must cover what we consume |
| `origin="Google Calendar"` | a genuine third party | no — a claim on record, exactly as before |

That first row is checking power a single model cannot have. Inside one file an external is terminal
by construction; across a folder the producer is present, so an import nobody publishes is an
**error** rather than a note.

Direct consumption between contexts of one system is allowed — the book is explicit that a context
is *not* a microservice and that you should *"not split but keep everything in one system until you
know more."* Full ch. 15 translation (View → automation → command → external event) is for a real
system boundary. What the kit insists on is that the coupling is **declared**: undeclared is an
error, declared is a note on the context map. Same treatment as a Conway split.

### There is no size budget, and there used to be one

**What makes a model is one business context — never a width.** Splitting is a judgement about the
business, and some business processes are long. A long process is **one** model; splitting it because
it got wide manufactures a context that is not a context, which is the opposite of what ch. 18 asks
for.

`model-too-wide` warned above 3200px and has been **removed**. It conflated a symptom with a cause,
and no rule can tell *"wide because this is one long process"* from *"wide because two contexts got
merged"* — so it could only guess, and it guessed wrong on any honest long model. The bar here is that
a rule never produces a false positive; that one produced them structurally.

`validate` still **prints** each model's width on its summary line. A number with no verdict attached
is information; the verdict was the part that was wrong.

**`crop.mjs` is therefore an inspection tool, not a smell.** It used to be documented as proof a model
was too big. A wide model may be perfectly correct, and cropping is simply how you read a wide
picture — the same way you scroll one.

The real reasons to split are unchanged and are all about *content*: a second business context, or an
alternative flow that would disrupt the story.

Alternative flows are the other splitting axis: *"pick one flow and model it… Most of the time, it's
easier to define a dedicated model"* for the error cases that would disrupt it. Cheap ones stay GWTs.

**Slice names are unique across the system** — a slice is a branch and a ticket.

## Conway: who can actually build a slice

The other half of step 7, and the one a swimlane is *not* about.

> *"Ideally, each Slice should be owned by a single team… What if the UI and backend are owned by
> different teams? … An Event Model often exposes organizational challenges — this is Conway's Law
> in action. If it's not possible to assign a Slice to a single team, that's a direct result of the
> company's structure."* — Understanding EventSourcing, ch. 43

`owner=` goes **on the lane**, because the usual fault line is UI vs backend. An element may
override its lane; a slice cell may declare `owner=` for accountability and `owners="a, b"` to
acknowledge a genuine split. The rule then **computes** which slices need more than one owner
rather than trusting a label.

This does not forbid a split — the book says it is often unavoidable. It makes you say so out
loud, because discovering it during implementation costs far more than during modelling. An
unacknowledged split is a **warning**; an acknowledged one is a note.

Here `owner` is the **agent** that generates the slice, not a human team: `frontend-agent` on the
UI lane, `backend-agent` on Commands and Event Stream. **The GWT band is deliberately unowned** —
the business rules are the contract *between* the two, and belong to neither.

**`owner=` answers "who BUILDS it", and nothing here answers "who USES it."** Those are two different
questions and the book keeps them apart: Conway/teams is ch. 43, while **actor lanes** — *"we clearly
show which actor is responsible for a specific screen or action"* — are ch. 40. **The kit has no actor
notation at all**; `em="actor"` does not exist, and `terminal="x:actor"` records that a value arrives
from the authenticated principal without being able to say who that is. It has cost nothing so far
because every model built to date has exactly one actor, and actor lanes exist to *separate* flows. It
becomes real at two. KIT-FINDINGS **Y2/Y3**.

The result is structural rather than accidental: **every State Change slice crosses the line and
no other slice does.** A State Change slice is screen → command → event by definition, while Views
and Automations never touch a screen. So in this model 7 of 19 slices need both agents, and the
7 are exactly the command-pattern slices.

## Time runs left to right, and Event → View is the only way back

*"The goal is to read the system from left to right. It should be a story that makes sense to
everybody."* A connection pointing left is a connection nobody can read, so `flow/backward-connection`
is an **error**.

The single exception is **Event → View**. A read model is necessarily fed by events that occur
after the point it is first drawn — a view is fed by the correction event that the very next slice
produces. The alternative is redrawing the View everywhere it is read, which is the canonical
form but doubles the width of the model. The exception is deliberate; anything else pointing left
is a layout bug, and the fix is to reorder the columns.

In practice this bites where a **screen reads a View drawn to its right**. Put the View's column
first: the screen feed then runs forward, and the event feeding the View runs back under the
exception.

## Actor lanes: who USES it — and the word "swimlane" means three things

**Read this before touching either kind of lane.** The two primary sources use "swimlane" for different
things, and the kit implements both under different names:

| | Where | Over what | Means | In the kit |
| --- | --- | --- | --- | --- |
| Dymitruk **§3 "The Story Board"** | **top**, the UI lane | wireframes | **ACTORS** | **actor lane**, `actor=` |
| Dymitruk **§6 "Apply Conway's Law"** | bottom, the event lane | events | **TEAMS** | `owner=` on a lane |
| *Understanding EventSourcing* **ch. 7** | bottom, the event lane | events | **STREAM BOUNDARIES** | **swimlane**, `streams=` |

So `owner=` answers *who builds it*, `actor=` answers *who uses it*, and `streams=` answers *which
stream*. Three questions, three notations, and the fact that two of them were once one word is why the
actor half went unbuilt for five runs.

```
node tools/slice.mjs actorlane <file> --actor "Approver" [--kind person|system]
node tools/slice.mjs add <file> --slice x --pattern state-change --aggregate A --actor "Approver"
```

**A screen's y IS its actor**, exactly as an event's y is its stream — derived from geometry, never
declared twice. `--actor` places a screen the same way `--aggregate` places an event: the user supplies
the domain fact, the tool supplies the geometry. With two or more lanes drawn, **`add` refuses to guess**.

**Actor lanes subdivide the UI lane only.** §3 puts them there and never extends them below, which is
also the only reading that does not collide with the stream bands inside the event lane. Adding one
grows the UI lane and cascades everything below it, exactly as `swimlane` does for the event lane. **The
first lane is placed to contain the screens already drawn**, so adopting a single-actor model costs no
cell moves.

**An actor may be a system** — *"different people (or sometimes systems) interacting with our system"*.
A warehouse feed is an actor. Never assume a person.

Four rules, and they are **opt-in**: a model with no actor lanes gets no findings at all, which is what
keeps every model built before this byte-identically green.

| | |
| --- | --- |
| `screen-outside-actor-lane` | **error** — a screen nobody owns, once the model draws lanes |
| `screen-actor-disagrees` | **error** — cells sharing a `screen=` slug in two lanes. *"Instead of merging these flows into a single screen, I clearly separate them"* — if two people need the page, that is two screens |
| `actor-lane-empty` | note — normal while modelling, and normal for ever for a system actor |
| `actor-is-a-system` | note — the choice made visible to a reader |

**Do not model technical roles.** *"how do we specify that the technical role 'admin' is necessary…
Short answer: Typically I don't. That's an implementation detail."* An actor lane is a **business role**;
*"you must hold the approver role"* is not model content. A rule about **identity** — "an approver may
not approve their own claim" — is domain and belongs on a GWT.

## Swimlanes: stream boundaries, not team boundaries

A swimlane is **not** an org chart. *"Swimlanes define stream boundaries. Typically, all events in
one swimlane end up in a physical stream"* — Understanding EventSourcing, ch. 7. One horizontal
band per business capability, drawn **inside** the Event Stream lane, declaring which aggregates
it holds:

```xml
<object id="swim-entries" label="Entries stream" em="lane"
        streams="Entries" identity="subjectId, period">
```

An event's **y is its stream**, not its column. Its `aggregate=` must match the band it is drawn
in, and an event drawn in no band has an undefined stream — both are errors.

### `identity=` — what keys ONE stream, and why it is a domain question

Marten keys a stream. Without `identity=` a generator has nothing to append to, and every attribute
rule can pass while the model stays silent about it — which is exactly what happened on the worked model,
right up to the point of writing code.

`identity=` is **required on any band holding events we write** (`band-needs-identity`), and every
name in it must appear on **every** owned event in that band (`identity-not-on-every-event`). Bands
holding only imports or foreign events are exempt: we project from those streams, never append.

**That exemption is a statement about the boundary, and `external-in-written-band` enforces it.** A foreign
event sharing a band with events we write says the other system's event lands in a stream of *ours*, which can
only be true if something of ours appends it — and an event store is append-only, so their schema is then in
our history for ever. That is the coupling a Translation exists to prevent.

| | |
| --- | --- |
| the foreign event has **its own band** | silent. It needs no `identity=`, because we never start that stream |
| it shares a band with events we write | **warning** `external-in-written-band` — give the source system its own band |
| `ingested="true"` on the external cell | acknowledged: we deliberately record arrivals as events of ours. A note, and a claim a reviewer can disagree with |

A warning rather than an error because the inbox pattern is legitimate, and because **`slice.mjs add
--pattern translation` puts the external event in whatever band already exists** — with one band, yours. Same
house style as `joins="none"`. The book's own ch. 16 sketch draws them together, so `cart-replay.mjs` warns
here; that is the rule working, and the fixture gates on errors.

This rule exists because accepting that default once produced a reference implementation that compiled, passed
fifteen tests and ran correctly against real Postgres while persisting another system's events into our stream.
Nothing caught it — not a rule, not the compiler, not a green suite, not a live run. A human asked a question.

The choice decides **which business rules are real invariants**, so it is not a technical detail:

| Entries keyed by | *"at most N per day"* is |
| --- | --- |
| `entryId` | not an invariant — a check against an eventually-consistent projection, and two concurrent writes can both pass |
| `subjectId, period` | a true aggregate invariant, enforced inside the transaction |

The worked model chose `subjectId, period`, which **required adding `period:string` to all four of that
stream's events and their commands** — the key has to be on every event or the event cannot say
which stream it belongs to. Expect that ripple; it is the normal cost of the decision.

The rule worth enforcing is the little book's, ch. 11:

> *"A single command should never interact with multiple swimlanes or aggregates. The moment you
> do this, you introduce the need for a transactional boundary around the operation."*

So `command-crosses-swimlane` is an error, not a warning. Two effects that must happen atomically
are not two aggregates — they are one.

**A swimlane is not a lane**, and `buildIr` deliberately keeps it out of `lanes`. `laneOf()` takes
the first containing match, and `parseCells` returns every `<object>` before every bare `<mxCell>`
— so a swimlane authored as an object would be found ahead of the lane containing it, and every
event would look misplaced. Anything spanning the model must also be clamped in `tools/crop.mjs`
or it blows out the export bounds.

**The validation test is manual and worth doing.** From the same chapter: hide every swimlane but
one, read its events left to right to someone from the business who cannot see the model. They
should form a compelling narrative. If the story does not hold, the stream boundary is wrong — and
nothing automatic will tell you.

### `status` turns the gate from global into per-slice

`in-design` → `ready` → `in-progress` → `in-review` → `closed`.

A slice cannot leave `in-design` while its own cells still carry errors, or while a State Change
slice has no GWT. This is the book's gate applied per slice rather than to the whole model, which
is what makes thin-slice-first delivery possible — one unresolved attribute in a far corner no
longer blocks work that is genuinely ready.

**`in-progress` is advisory, not a lock.** A `.drawio` in git provides no mutual exclusion: two
agents on two branches can both set it, both succeed, both merge. Real exclusion comes from the one
atomic operation git has — creating a ref. **One branch per slice.**

### Labels are not unique, and nothing may assume they are

One event type reachable from two slices is drawn as two cells with the same label; screens repeat
across every slice that triggers from them. A `label -> element` map keeps only the last of each.
The three GWT fields therefore resolve at different scopes:

| Field | Scope |
| --- | --- |
| `when` | this slice only — it must be this slice's Command |
| `then` | this slice first, then anywhere — the event this slice's Command emits |
| `given` | anywhere — prior events almost always come from *earlier* slices |

Scoping `given` to the slice would break every honest GWT.

## The information completeness check

The point of the whole method, and a **gate** rather than a report: *"The implementation cannot
begin until this check is passed."*

> "For every attribute in an Element, you should always verify that the data is provided by the
> connected sources."

It applies to every element, not just read models:

| Element | Its attributes must be supplied by |
| --- | --- |
| Read model | the Events pointing at it |
| Event | the Command that triggers it — *"Commands generally have to provide all data necessary to persist an event"* |
| **External event** | **nothing — it is terminal.** We have neither control over it nor knowledge of what produced it; that is what `external` means. Reported as a note, not an error, so the upstream contract still gets confirmed once |
| Screen (`displays`) | a View feeding the screen. No View means the screen cannot know it |
| Command | the triggering screen's `displays` + `inputs` |
| Automation's command | the todo-list View the automation watches — an automation types nothing |

GWTs are checked for referential integrity too: `when` must name a Command in the same slice, and
`given`/`then` must name Events that exist. A GWT naming an event that isn't in the model is a
rule nobody can implement, and it reads as perfectly correct on the canvas.

Failures are marked **on the connection**, in red: *"If any data is missing, the connection is
automatically highlighted in red… you can quickly confirm that all the arrows are black."* We also
badge the failing element, because a red arrow alone doesn't say which attribute is unsourced.

Business rules are captured as GWT, one cell each, in the band below the slice:
`GIVEN a set of Events, WHEN a Command, THEN a new set of Events`. Ten or more per slice is
normal — *"Don't save on GWTs."*

### A State View slice takes a GIVEN/THEN, and there is no WHEN

A read model only ever reads events that **already exist**, so there is no command to be the WHEN:

```
GIVEN a set of Events   THEN the read model shows <this>
```

*Understanding EventSourcing* ch. 3 is explicit — *"you typically do not use GWTs but **GTs (Given -
Then)**. Read Models only rely on previously stored events, so there is no 'When' part necessary"* — and
the little book says a State View scenario is **always** a GT. Ch. 13 widens it: *"For read model **and
automation** tests, the 'When' step is typically omitted."* An automation therefore takes both — a GT for
the infrastructure half, a GWT for the domain half of the command it issues.

**A GT is the same `em="gwt"` cell with `when=` left off.** No new cell type: the absent `when=` is what
makes it a GT, exactly as the book presents it — a GWT with the middle step omitted, not a different
animal. `then=` names the **View** rather than an event, which `model.mjs` has always allowed on a slice
with no command. `enforce=` is meaningless on a GT, because there is no command to reject anything.

The generated test's shape, and the reason to bother writing the GT down at all:

1. **GIVEN** — append the events, with concrete example values. Ch. 13 asks for exactly this: *"we can
   even extend the scenario with clear example data."*
2. **THEN** — assert **through the read endpoint**, not against the document store. That covers the
   projection *and* the query surface, which is what a caller actually gets.

**Write them before implementing.** Adding GTs to a slice already past `in-design` generates live tests
nobody has written and turns the suite red — correct behaviour, avoidable cost. ANTI-PATTERNS.md #13.

**The one GT worth writing above all others says what the view IGNORES.** *"GIVEN RecipeCreated then
IngredientAdded, THEN the list still shows one unchanged row"* asserts that the view is fed by only one
of them — which the drawing already claims, and which is the single thing a projection can get wrong that
no other test would notice.

## The four building blocks and the four patterns

Source: the [Event Modeling Cheat Sheet](https://eventmodeling.org/posts/event-modeling-cheatsheet/).
These are the whole grammar. A connection that is not part of one of these four patterns is a bug.

Blocks: **Trigger** (a user at a screen, an external API call, *or an automated process*),
**Command**, **Event**, **View** (a read model / report).

| Pattern | Sequence |
| --- | --- |
| Command | `Trigger -> Command -> Event(s)` |
| View | `Event(s) -> View` |
| Automation | `Event(s) -> View -> Automated Trigger -> Command -> Event(s)` |
| Translation | `Event(s) (source system) -> View -> Automated Trigger -> Command -> Event(s) (other systems)` |

**An automation is a Trigger, not an event handler.** It is a peer of a user at a screen: it
*looks at a View* and *issues a Command*. It never receives an event and never emits one.

`Event -> Processor -> Event` is a classic anti-pattern. The View an automation watches is a
**todo list**: the event puts a row on it, the automation works the row and issues a command, and
the resulting event ticks the row off. Skip the view and you lose both the record of pending work
and the thing that stops the processor working the same row twice.

Per the same source, if there is no view and no conditional logic, it is not an automation at all
— it is just a command that emits several events.

### That pattern has a name, and it is the reason this kit needs no saga notation

The paragraph above is **Dilger's "Processor-TODO-List" pattern**, *Understanding EventSourcing* **ch. 35**
(pp. 490–504) — an entire chapter the kit had been paraphrasing without citing. Its two framing questions
are the ones to ask of any automation:

> *"How does the Processor get a new task to execute? … What needs to happen for this task to get checked
> off the Processor-Todo-List?"*

**And it is explicitly the answer to "where are the sagas?"** Ch. 35 asks *"How does this relate to the
Saga-Pattern?"* and answers:

> *"We do not define a specific Process-Orchestrator or Saga-Process-Definition but simply act on the
> facts in the system. That's it."*

Dymitruk says the same on the notational side — *"any of these where you find these larger patterns,
they're always replaced by this to-do list pattern"* — and the cheat sheet this kit already cites for the
four patterns carries it: *"the view that the automated process monitors is a simple todo list."*

**Neither of them says a saga is wrong, and the kit must not either.** Dymitruk keeps sagas as an
*implementation* detail deliberately hidden from the notation — *"you don't have to throw that in the
garbage"* — and Dilger hedges every time he states his preference: *"I typically don't use Sagas at all"*,
*"I personally don't use Sagas most of the time"*, and immediately *"only because I like to use this
approach doesn't mean it is the best approach. Make your decisions on a case by case basis."*

So the kit's position, which is now stated rather than accidental: **a saga is an implementation of an
automation slice, exactly like the four wakeup mechanisms** in `reference-implementations/automation/`.
It gets no notation for the same reason concurrency gets none — it is technical, and the model carries
domain knowledge and information flow. `pattern="automation"` is the contract; a saga library is one way
to honour it, and a todo View is the one both authors reach for first.

**Compensation is not an exception to this**, which is the part worth knowing before anyone reaches for a
saga framework. Ch. 35 works the canonical distributed rollback — order → payment → inventory — entirely as
todo lists: `InventoryReservationFailed` is translated into `PaymentRefundRegistered`, which *opens* a todo
for the refund processor; the command issues, `PaymentRefunded` *closes* it, and **a refund that fails
simply leaves the row open to be retried on the next schedule**, dead-lettering to a human if it never
succeeds. That is the compensating transaction, with the retry semantics falling out of the pattern rather
than being written.

Two smaller things from the same chapter, neither adopted here:

- **The "back-channel" dotted line.** Dilger draws the tick-off edge (`Event → todo View`) dashed, *"to
  indicate that this is not part of the Flow but just updating the data of the Read Model."* The kit's
  grammar already permits that edge — it is the single `Event → View` exception to left-to-right — but does
  not distinguish it visually. Cosmetic, and a real reader aid on a busy automation slice.
- **Replay safety is the pattern's own argument for itself.** Ch. 33 notes an `@EventHandler` action fires
  again on replay and names ch. 35 as *"one solution"*: a todo list recomputed from current state has
  nothing to re-fire. That is the same conclusion `architect`'s `replay-safety` question reaches from the
  other direction.

### A pattern is a contract, not an implementation

The four patterns say **which blocks connect, and in which direction**. They say nothing about which
library recipe realises them, and every one of them has more than one honest implementation on this
stack:

| `pattern=` | What is genuinely a choice | Built and measured in |
| --- | --- | --- |
| `state-change` | the aggregate handler workflow vs. explicit `FetchForWriting`; an HTTP endpoint vs. a message handler; `StartStream` for a slice that creates the stream | `reference-implementations/state-change/` |
| `state-view` | six Marten recipes — live aggregation, single-stream, `EventProjection`, multi-stream, flat table, composite — and `Inline` vs `Async` | `reference-implementations/state-view/` |
| `automation` | what wakes the trigger: event forwarding, `ISubscription`, `RaiseSideEffects`, a clock | `reference-implementations/automation/` |
| `translation` | the automation choice, plus **how the foreign event lands**: a webhook, a table they write, a broker, or a poll of their API | `reference-implementations/translation/` |
| a **composition** of the above — e.g. the book's Reservation Pattern | which stream the first step writes to; whether the second step runs **in the same web request** or is woken later; and what the compensating path costs | `reference-implementations/reservation/` |

**A named pattern from either book is usually a COMPOSITION, not a fifth `pattern=` value.** Ch. 36's
Reservation Pattern is a state change followed by an automation, with a second automation for the
compensating path — built as exactly that, at 0 errors and 0 warnings, with the completeness check
accepting it untold. What makes it *the Reservation Pattern* is which stream the reservation writes to,
and that is `identity=` on a swimlane. **If a run finds itself wanting a new `pattern=` value, that is a
finding about the pattern rather than a gap in the grammar** — and the burden is to show which of the four
sequences the drawing violates.

Two consequences, and the second is the one that keeps being learned the hard way:

**Nothing catches a wrong choice.** No rule family, no compiler, no test. The model validates, the code
compiles, the suite is green, and the slice is still built on the wrong recipe. So the choice has to be
**stated out loud in the slice and in the commit**, because that sentence is the only artifact that will
carry the reasoning.

**A reference implementation is a worked example, not the menu.** Each folder under
`reference-implementations/` records what some choices *cost* on the model they were built against —
which is exactly why copying one blind is dangerous. The *set* of options lives in the library's own
docs. So: **`reference/llms/` for what the library offers, the reference implementation for what it
cost.** The kit has already made this mistake once, generalising "a sweep on a clock" into the only
correct automation from a sample of one model. The correction is written below, and the general form of
it is this paragraph.

### Concurrency is not a modelling concern — the `architect` step, and why it is not a rule

**The event model's responsibility is domain knowledge and how information flows. That is all.** Optimistic
locking, projection consistency mode and snapshots are technical, and both books say so outright:

> *"Snapshots are a pure technical tool and are **neither modeled nor mentioned in an Event Model**
> typically."* — Understanding EventSourcing

**The same ruling covers security and transport, and it was checked rather than assumed.** Ch. 40 asks how
to specify that the role `admin` is needed to block a customer and answers *"**Typically I don't. That's an
implementation detail.** The required role can change without affecting the overall flow"* — because *"the
more implementation details you include, the harder it becomes to focus on the essential information."*
Measured across the whole book: `endpoint` appears 4 times and **every one is in Part III**, `route` never,
and neither book has a single non-functional requirement. **So RBAC, roles, routes and HTTP status codes get
no notation, and asking for one is answered.** KIT-FINDINGS **Y1**.

The little book files its Live-Model vs Database-Projection trade-off under *"Implementation Hints"*. So
**none of this becomes notation, and no grammar rule is added for any of it.** `gwt-multiple-whens` stays an
error: a race is not a business rule. The business rule is *"one member per desk per day"* — the business does
not care about instants. Getting this wrong is finding **T0** all over again, where an implementation concern
climbed into the domain model as a business rule and then validated, generated a test and passed.

**What the model does carry is the boundary, and that is enough.** Both books say the aggregate *is* the
transactional consistency boundary; here that is `identity=` on the swimlane. And the one consistency rule
either book states *as a rule* is already an error — the little book's *"if a single command touches multiple
aggregates or swimlanes… these aren't two separate aggregates—they're one"* is `command-crosses-swimlane`.
Choosing eventual consistency is likewise a modelling act, not a setting: two effects that need not be atomic
are **two slices with an automation between them** (the books' hotel/car and bank-transfer examples).

Once the boundary is right, concurrency stops being a design question:

> *"we apply optimistic locking not on the entire Event Store, but on **individual event streams**."* — ch. 4

### …and a stream is the DEFAULT consistency boundary, not the only one

**This section used to stop at the line above, and read as "a stream is the boundary, so a rule spanning
streams cannot be an invariant."** That is false, and it is now measured false — four mechanisms, all
green, in `reference-implementations/cross-aggregate-invariant/`, with a control proving the race
reproduces deterministically without them.

The organising sentence is Marten's own, and it generalises well past DCB:

> *"the side-table mechanism **converts the predicate read into a row-level write conflict**, so concurrent
> boundary saves serialize on a row lock at `READ COMMITTED` — no `SERIALIZABLE`, no advisory locks."*

**Optimistic concurrency was never the problem; the thing being versioned was.** A version has to sit on
something *both writers write*. Two writers on two streams share no row, so no stream's version can see
them — but a document row, a unique index, a lock, or a DCB tag all can:

| Mechanism | Serialisation point | Loser gets | Needs Marten 9? |
| --- | --- | --- | --- |
| **guard row** | one `IRevisioned` row per boundary, via `UpdateRevision(doc, doc.Version + 1)` | `Conflict`, retry | no |
| **reservation row** | a unique index on `(boundary, sequence)`, via `Insert` | `Conflict`, retry | no |
| **advisory lock** | `pg_advisory_xact_lock`, taken **before the read** | **the ordinary rule** — no retry | no |
| **DCB** | `mt_dcb_tag_version`, maintained by Marten | `DcbConcurrencyException`, retry | yes |

**`Store()` cannot conflict**, and that one fact cost three failed attempts: on an `IRevisioned` document it
supplies the version the entity *already has*, while rejection needs the stored version to be **equal or
greater** than the one supplied — so it asserts something already true. The `+1` is the mechanism.

**None of this becomes notation**, and the rule above is unchanged: concurrency is not a modelling concern.
The model already states the rule — a GWT whose GIVEN names another stream *is* the cross-stream invariant —
and `architect` chooses the mechanism. `command-crosses-swimlane` also stands: these commands **append** to
one stream and merely **read** across, which is why the worked model validates at 0 errors.

**DCB is additive, not a re-modelling.** The event is still appended to its own stream with the tag
attached; the tag is a boundary marker, not a stream key. An existing model keeps its stream layout and
gains the boundary.

**The gap was that nothing read the model and ASKED.** That is the `architect` step: it derives six families
of question from the IR, answers none of them, and the skill answers them against `reference/llms/` — writing
each decision, its reason and **its cost** into `<project>/ARCHITECTURE.md`.

```
node tools/architect.mjs questions   # what the model implies and cannot answer
node tools/architect.mjs record      # a section per question, for the decision
node tools/architect.mjs check       # unanswered, still TODO, or orphaned by a model change
```

| Question | Why the model cannot answer it |
| --- | --- |
| `stream-boundaries/<ctx>` | the boundary map — every stream, its key, its writers. A rule inside one key is a true invariant; the same rule against a wider key is a projection check two writers both pass |
| `no-stream-key/<lane>` | events we append with no `identity=`: no boundary exists at all |
| `contended-invariant/<slice>/<gwt>` | **a rejection depending on state in the stream its own command appends to** — two callers at the same instant can both pass it. Gets a **race test**, because every generated GWT is sequential |
| `cross-stream-rule/<slice>/<gwt>` | **the sharpest.** A GIVEN in a stream the command does not write, so enforcing it means *reading* another stream, and no stream's version covers it. **Four mechanisms close it** — guard row, reservation row, advisory lock, DCB — and a rejection here now gets its own generated race test, with a **control** |
| `stale-read/<View>` | fed by more than one stream type (**Marten defaults multi-stream to `Async`**), or read by a screen that also feeds it — read-your-own-write |
| `view-identity/<View>/<field>` | a key value no feeding event carries. Metadata means **append** time (ANTI-PATTERNS #15) |
| `replay-safety/<slice>` | an automation or translation: a replay, a redelivery and a restarted sweep all run it twice |
| `type-binding/<ctx>` | **what a domain type IS, in C#** — see below. The model may not answer this, because the model does not know what a C# is |

### The model is stack-agnostic, so `UUID` is not a C# type and nobody may pretend it is

`fields="aggregateId:UUID"` is the **business** saying *"a universally unique id"*. It is not a claim about
.NET, and it must not become one: the model outlives whichever stack builds it, which is the entire reason
`model.mjs` holds **no list of C# types** and never will. Both books write `UUID` and `Double`, and the
kit's own fixture quotes them deliberately.

So something has to translate — and **codegen may not be that something**, because a translation it invents
is a decision nobody reviewed. `Double` or `decimal` for money is a *rounding* question, not a typo.

That makes it `architect`'s, like everything else with a cost:

```
node tools/architect.mjs record    # proposes a binding per distinct type, records the cost
```

The decision lives in `ARCHITECTURE.md` as a fenced ` ```type-bindings ` block, `codegen` reads it, and
`tools/type-bindings.mjs` is the one definition of the format so the two cannot drift. Child group names
(`CartLine`) are excluded — codegen emits those records itself, so there is nothing to bind.

**An unbound type is emitted verbatim and REPORTED by name**, which is the whole point:

```
UNBOUND TYPE — 2. ...
  UUID     first used by Cart Cleared.aggregateId
  Double   first used by Cart Submitted.totalPrice
```

The fallback stays the identity rather than an error, so a project whose model already speaks C# needs no
record at all and every reference implementation keeps working untouched. What changed is that the failure
is now named **before** the build instead of arriving as CS0246 sixty-eight times with nothing pointing at
the cause. KIT-FINDINGS **W9**.

**It is a step before codegen rather than part of it, and that is load-bearing.** These decisions are
*system*-scoped: if slice 1 picks `Inline` and slice 4 needs `Async` they conflict after both are green. Same
reasoning that keeps `journey` out of codegen. `codegen` reports `ARCHITECTURE DECISIONS MISSING` rather than
enforcing it.

**The read side has three options and the book names the costs of each** — accept it (`Async`, and tests must
wait); make it immediately consistent (`Inline`, which costs independent scalability, lets a projection error
abort the business transaction, and slows the write per projection); or a **partial live model** over the
projection (`FetchLatest` filling the gap, in-memory so lost on restart). **The generator now takes option 1
for a multi-stream view and option 2 for a single-stream one**, following Marten's own guidance rather than
the kit's former habit of `Inline` everywhere — so `stale-read` asks whether that is right for *this* view,
not whether to depart from a kit default. The third option is *not* in the six-recipe menu as a combination,
and that is a gap in the reference implementations rather than in the grammar.

**The one answer that IS a model change** is a wrong boundary: if the stream key does not contain the
contested thing, the fix is the swimlane, because a stream key is a domain fact. Expect the ripple — the key
goes on every event of that stream and on the commands.

**And for growth, the book prefers a business period to a snapshot outright:** *"better to limit the length of
a stream naturally by understanding the business processes"* — banks close the books after a day or a month,
the stock market settles each trading day. Snapshots are *"the exception, not the rule"*. Whether a stream
grows without end is not derivable, so it is folded into the boundary map as a prompt rather than claimed.

**Nothing checks whether any of these answers is right** — not a rule, not the compiler, not a test. The model
validates, the code compiles, the suite is green, and the choice can still be wrong. That is the entire reason
the reasoning is written down rather than merely made.

### What makes an automation actually run — and why there is no single answer

The model constrains the **contract**, not the mechanism. `Event(s) → View → Trigger → Command` says the
trigger decides from *accumulated state* rather than from one event's payload, and that it issues a command
rather than appending one itself. It says nothing about what wakes the trigger, and — this is the part
easy to get wrong — **it does not require the View to be a materialised projection.** A subscription's
checkpoint is a record of what has been worked. A durable inbox is a list of pending work. The green box
on the diagram is the concept, and the Event Model and its implementation are allowed to differ.

So `pattern="automation"` reads as *"this slice reacts to accumulated state without a human"*, and the
implementation is a **choice with a decision rule**:

**Ask two questions, in this order: is the trigger event ours to append, and can you afford to lose one?**
The second is the one that usually decides it, and it is not the same question as "does ordering matter".

| When | Implementation | Why |
| --- | --- | --- |
| the trigger event is **ours**, losing one is survivable, and cheap + immediate wins | **event forwarding → a doorbell handler** | ~1s, no daemon, one class. But a delivery that never happens is lost — no record of intent outside the moment |
| ours, and **losing one is unacceptable** | **Marten `ISubscription`** | durable checkpoint, so a host that was down catches up. Ordered, and coalesces one wakeup per event *page*. Costs the async daemon |
| the trigger event is **foreign but WE INGEST IT** — the normal shape of a `translation` | **whichever of the two rows above the durability answer picks** | once we append it, it is ours from that moment: there IS a transaction of ours to hook |
| the trigger event is **foreign and never ingested** — nothing of ours ever appends it | **sweep a todo View on a clock** | genuinely no transaction of ours to hook |
| there is **no event at all** — the trigger is *time* | **sweep** | nothing to subscribe to |
| "is there work?" genuinely means "did this row change" | **projection `RaiseSideEffects`** | fires on the row, already knowing. The only one that reaches INTO the read model. It does NOT force the view Async any more: side effects are processed only during async processing **by default**, and running them on an `Inline` projection needs `opts.Events.EnableSideEffectsOnInlineProjections = true` |
| the trigger event is ours and the **same request** may as well finish the job | **run the trigger in the request that appended it** | no daemon, no subscription, no clock — and **no record of intent outside the moment**, so a process that dies mid-cycle leaves the work undone with nothing to recover from. The book licenses it for the Reservation Pattern specifically; measured in `reference-implementations/reservation/` |

The first four are **built and measured** against one shared model in
`reference-implementations/automation/` — read that before writing one.

**On a translation slice, do not ask this question at all — ask how the foreign event gets here.** The four
mechanisms above all wake a trigger off events **already in our event store**, and a translation's trigger event
never is one: it is the other system's event, it belongs in its own foreign band, and *we do not append it.*

**A foreign event is not persisted by us, and both identity rules already say so.** `band-needs-identity` and
`identity-not-on-every-event` filter to `kind === "event"` and exclude `external` — "*we never start those
streams, we only project from them.*" A band holding only foreign events is exempt from `identity=` because
there is nothing of ours to key. Our event store is our history, and it is append-only: a foreign schema written
into it is in our history for ever, which is precisely the coupling the translation exists to prevent.

So for a 1:1 translation **the arrival is the wakeup**. The notice lands in the transport's durable inbox, a
handler translates it and issues the command, and the decider appends the one event we own. No subscription, no
forwarding, no clock, no async daemon. The **inbox is also the todo View** — pending work, with retries and
dead-lettering nobody wrote — which is the automation folder's "the green box is the concept" doing real work
rather than being quoted. Here a materialised View is not merely unnecessary but impossible: no Marten
projection can fold an event that is never in the store.

A translation needs a wakeup from the table above only when it is **conditional** — deciding from several
notices accumulated over time rather than mapping one. That needs a todo View fed by events of ours, and every
row above applies again.

The one decision that is genuinely this pattern's own is the arrival, and nothing in the kit generates a seam
for it, so it is entirely hand-owned:

| When | Landing | Cost |
| --- | --- | --- |
| they call us, and a lost call is **their** retry to make | an HTTP endpoint | nothing to re-read if the call never arrives. The route also exists whether or not you chose it, so "not choosing" means refusing |
| they can **INSERT** into our database | `ListenForMessagesFromExternalDatabaseTable` | durable with no durability code of ours — inbox, dead letters, advisory lock. A table the far side owns |
| they publish to a **broker** | a Wolverine listener + `DefaultIncomingMessage<T>` | broker durability, plus an envelope mapper if their headers matter. The likely production shape; the one row not measured |
| they offer only a **query API**, or push nothing | poll on a clock | a high-water mark of our own — a row that can be wrong. But it **cannot deliver out of order**, which some of the others can |

Built and measured against one model in `reference-implementations/translation/`.

Whichever it is, all three end up sending **one message** — the seam that keeps three transports from each
growing their own copy of the translation. Their vocabulary reaches exactly as far as that message and the
trigger that handles it; the rename lives on the way into the command, which is what `mappings=` records.

**Dedupe on a value carried by OUR OWN event**, and note this is the one place a foreign id legitimately crosses:
at-least-once is the normal case for every landing mechanism, and a black box re-sending after a reconnect is
ordinary rather than exceptional. A transport inbox catches its own redelivery for free and is pruned, so it
cannot be the durable answer — the notice id on our event is. One correlation value is not their schema.

**Then run it and look**, for the same reason as an automation: nothing in the model or the generated code makes
an arrival happen, so a completely disconnected feed leaves a green suite green.

**The foreign-but-ingested row was missing, and its absence was worse than a gap.** A translation slice
matched *"the trigger event is foreign"* on the surface criterion while failing its stated reason — the
model draws the external event inside one of our own swimlanes with `aggregate=` set, so something of ours
appends it, so there *is* a transaction to hook. As written, `translation` had **no correct row**, and the
row it did match sends you to a clock you do not need. Anyone reading the verdict rather than the
justification writes a sweep, and everything stays green.

**And durability is now a criterion in its own right**, because *"can you afford to lose one?"* is the
question that actually decides a foreign notification, and the table previously only asked it obliquely as
"ordering or replay". A black box that *"notifies us whenever a change occurs"* and never re-sends means a
dropped notification is permanently wrong data — which is a durability argument and says nothing about
order.

`PrepareEmail → EmailPrepared → [subscription] → SendEmail → EmailSent` is an automation. It is drawn
`EmailPrepared → EmailsToSend → EmailProcessor → SendEmail`, and no `EmailsToSend` document has to exist
for the drawing to be honest.

**The earlier version of this section said a sweep was the only correct answer.** That was generalised
from a single model whose automations happened to be foreign- or time-triggered — three of four — which is
a property of that model and not of the pattern. Nothing in the grammar or the checker catches an
implementation chosen for the wrong reason, so the choice has to be stated out loud in the slice.

**Whatever wakes it, the trigger is a message handler and not an HTTP endpoint.** If the trigger *is* an
endpoint, the test seam and the production mechanism are the same thing — so "nothing ever wakes this in
production" is invisible to a green suite, which is exactly how one shipped once. Give it a message; let an
operator route *send* that message when a manual run is useful.

Rules that hold for every implementation:

- **The trigger returns `Task`, never its run report.** Wolverine treats a handler's return value as a
  *cascading message* with no opt-out, so a report returned fire-and-forget is unroutable and takes the
  whole outgoing batch down with it. Put the work in a plain method; an HTTP return is a response body.
- **Log every run, including one that did nothing**, or "alive with no work" and "dead" are byte-identical.
- **`IQuerySession`, not `IDocumentSession`** — then "a trigger never appends" is a compile error. The
  cost is that with no Marten transaction there is no outbox commit.

### If you choose the sweep, the clock is a loop

**Wolverine has no cron.** The obvious substitute is a durable self-rescheduling message — the handler
schedules its own successor, so the beat survives a restart. **It does not work on this stack, and it
fails silently.** Six attempts, each with logging that proved the message had been created:
`bus.ScheduleAsync` inside the handler, `DeliveryMessage<T>` via `DelayedFor`, `OutgoingMessages` +
`.Delay()`, a fresh DI scope, scheduling before the work instead of after — and finally Wolverine's own
debug trace ending `Enqueued for sending` → nothing. Scheduling from *outside* a message context always
persists; from *inside* a durable local-queue handler it never does.

**And it turned out not to be needed.** A sweep's work is not carried in its message — it is recomputed
from the todo View every time, so those pending rows *are* the durable queue, built from the event store.
Kill the process mid-run and the next start reads the same rows. Durable scheduling earns its keep for
deferred **one-shot** work ("remind me in three days"), where losing the message loses the intent.

**A clock is safe because it is absent in tests.** The danger was never the timer, it was a timer in the
*test* host: a run firing mid-test turns every other slice's GIVEN into a race. Gate it on configuration,
and have tests send the same message to the same handler — so the production path stays tested and only
the clock is missing. A clock is the one part of an automation a test must control rather than observe.
What a test *can* assert is that **running twice is safe**, which is what makes the interval a free choice.

**Then run it and look.** Every bug above survived a green suite, and only starting the app found any of
them. **Two runs with nobody calling anything is the proof; one is not** — a mechanism that fires at
startup and then dies produces exactly one, and reads as success. An unrun automation fails exactly like
unrendered CSS. See ANTI-PATTERNS.md #14.

## Layout grid

Time flows left to right. Three lanes, plus a GWT band below them because GWTs are drawn
vertically under the pattern they describe.

| Band | y | Height | Holds |
| --- | --- | --- | --- |
| *model context note* | 30 | 90 | the pink cell naming this model |
| UI | 160 | 390 | screens, 300 tall so a wireframe fits inside one |
| *UI routing strip* | 500 | 50 | horizontal runs of View → Screen feeds, below the screens |
| Commands / Views | 550 | 180 | commands, read models, automations |
| *forward routing band* | 730 | 140 | horizontal runs of long Event → View feeds |
| Event Stream | 870 | grows with the swimlanes | events, split into one band per stream |
| *backward routing corridor* | event lane bottom + 10 | 200 | horizontal runs of edges pointing left |
| GWT | event lane bottom + 240 | grows down | one `gwt` cell per business rule |

Lanes start at x=40. Columns are 320 apart — x=100, 420, 740, 1060, … — with elements 180 wide,
events and commands 60 tall, **screens 180×300** (a screen has to hold its wireframe, and 180 wide
is not a choice: a wider screen would overflow its 220-wide slice band).

**Every long edge gets its own y in a routing band.** One y per *target* is not enough: several
events feeding the same View then share a horizontal run and the picture becomes unreadable.
Allocate sequentially — forward at `forwardBand + 6 + 8n`, backward at `eventLaneBottom + 15 + 9n`,
View → Screen at `uiLane + 345 + 8n`. No band holds a box, so a routed edge never cuts through
anything.

**Events stacked in one column need a left corridor, not a vertical run.** Several externals in the
same column feeding the same View cannot all go straight up — the lower ones would cut through the
ones above. Send them out the left edge and up a corridor at `columnX - 30 - 12n`.

GWT cells are 300 wide (they hold sentences) and 120 tall, left-aligned to their slice's column,
first row at **y=1375** and every 140 after. 300 + 20 fits the 320 column pitch exactly, so a
slice's GWTs never collide with the next slice's. **Put the rule text in the label**, not only in
`rule=` — several GWTs in a slice share a `given/when/then` triple and differ only in the case they
describe, so without it they render as identical grey boxes.

Add a column by widening the page and every lane, rather than stacking a second row into a routing
band. Page width = `40 + laneWidth + 60`.

These numbers move whenever a swimlane is added. Read them off the model rather than trusting this
table; `tools/model.mjs` derives everything from geometry and never hard-codes a y.
