# Kit findings — the CPOC01 run

Everything the kit got wrong, everything the run taught, and every decision parked for the human.

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

## A. Findings

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
