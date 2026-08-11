# Kit history — the closed record

**This is the archive, not the to-do list.** Anything still open lives in
[KIT-FINDINGS.md](KIT-FINDINGS.md), which is short and is the file to read. This one is the lab notebook:
every run, in the order it happened, with the reasoning that produced each fix.

**Why keep it at all, at this length.** Three quarters of the entries below are *fixed*, and a fixed bug
would normally be git history. These are kept because in this kit the **reasoning is the artifact** — most
findings are of the form *"this looked right, compiled, passed, and was wrong"*, and the mechanism is what
stops it being rediscovered. Several entries are corrections of earlier entries (**B4**/**T8**, **T2**,
**Y5**, **AD13**); those are kept in full deliberately, because a kit that quietly overwrote its own wrong
claims would have no way to show which kinds of claim it gets wrong.

**How to read a heading.** `**BROKEN**` produced wrong output, `**WRONG**` was a false claim in the docs,
`**GAP**` is missing capability, `**NOISE**` is a false positive or cosmetic, `**MEASURED**` is a fact
established by running something. A trailing `***FIXED***` / `*not fixed*` is the status; sections are
lettered by run (**A** first, then **B**, **T**, **W**, **X**, **Y**, **Z**, **AC**, **AD**) and are
*not* in file order — use the table of contents in your editor.

---

## BN1 — `uijourney.mjs` read a field the board refactor had removed, so all three commands crashed · **BROKEN** · ***FIXED 2026-08-11***

**Every `uijourney.mjs` command died on `TypeError: Cannot read properties of undefined (reading 'filter')`
before printing a line.** The whole UI-journey layer was unreachable.

The cause is a **half-finished rename**. V19 retired `em="journey"` into `em="chapter"`, and the
folder-level IR kept a `journeys` field derived from the executable chapters — the ones carrying a `then=`.
`model.mjs` says so in a comment, and the comment ends *"so codegen and uijourney.mjs need no change at
all."* **That is true of `codegen`, which reads the folder-level IR, and false of `uijourney.mjs`, which
reads the PER-MODEL IR** (it wants each model's own edges, and says so). The per-model IR carries
`chapters` and has never carried `journeys`.

So the reassuring comment was the defect: it named the one file it was wrong about. `uijourney.mjs` now
derives journeys from `ir.chapters` itself, filtered exactly as `model.mjs` filters them, so a chapter with
no `then=` is a grouping rather than a walk at both levels.

**The lesson is the one this kit keeps relearning about `emit` vs a claim in prose.** A comment asserting
that a downstream consumer needs no change is not checked by anything. Two consumers read two different
IRs; only one of them was thought about.

## BN2 — the silent-failure guard failed a SUCCESSFUL command, because a 204 has no body to read · **BROKEN** · ***FIXED 2026-08-11***

**`watchForSilentFailure` reported `requestfailed` for a request the server had answered `204`**, and the
journey went red on a command that worked end to end — event appended, projection updated, screen correct.

Measured, with timestamps, after three wrong hypotheses (the reload aborting an in-flight POST; React
StrictMode; a duplicate click):

```
t=17332  REQ POST /charging/holdBay
t=17347  RES 204  /charging/holdBay
t=17348  requestfailed POST /charging/holdBay :: net::ERR_ABORTED
```

The response arrives, and **one millisecond later** Chrome reports the request as failed. `holdBay` returns
on `res.status === 204` without reading the body — correctly, since there is none — so nothing ever
consumes the response stream and Chrome cancels it. Every Wolverine `204` in the app is shaped like this,
which means the guard was primed to fail any state-change slice that returns no content.

**The fix is to ask whether a response exists at all.** An abort matters when there is no response —
connection refused, DNS failure, a request killed by a navigation. Once a status line exists, the
`response` handler is what judges it, and judging it twice is how a green path goes red.

**Deliberately not solved with the `allow` list**, which was the tempting one-liner: excusing
`/charging/holdBay` would also excuse a genuine `400` from that endpoint, and a refusal reaching the user
is the single thing this guard most needs to see. A workaround that blinds the check is worse than the bug.

## BN6 — `SELECTOR NOT IN THE MODEL` was scoped to the chapter's own screens, and flagged an honest walk · **NOISE** · ***FIXED 2026-08-11***

The check built its allowed set from the screens the chapter's **slices act on**, then called anything else
a stranger. `bay-out-and-back` ends by reading its stated outcome — `BayHealth(inService=true,
openFaultCount=0)` — on the **bay-health** screen, using five selectors bay-health declares and the
chapter's other three screens do not. All five were model-derived and already held in both directions by
`design.mjs check`; the report called them invented.

**The confusion is worth naming, because it is a modelling distinction and not a coding slip.** A chapter's
outcome is a **View**. The place a human reads a view is a **screen**. Reading is not a slice, so no slice of
the chapter need act on that screen — which means "declared by a screen this chapter acts on" and "declared
by this system" are different sets, and only the second one expresses the rule the check exists for: *no
invented selector*.

Now scoped to the system, with the narrower fact kept as a **note** — `READS A SCREEN OFF ITS OWN WALK`,
naming the selectors and the screen that declares them, because a walk that has quietly wandered looks
exactly the same and a reader should get the chance to disagree. `check` grew a `notes` channel for it,
printed separately so the summary line cannot lie.

## BN7 — `actionTimeout` defaults to 0, so a disabled control consumed the whole test budget · **NOISE** · ***FIXED 2026-08-11***

The scaffolded config bounded the test (**BN3**) and not the actions. Playwright's `actionTimeout` defaults
to **0, meaning no limit**, so a `fill()` on a control that is disabled and never becomes enabled waits until
the *test* times out and then reports **the test** as the failure, with no mention of the element.

Measured: three minutes of silence that read as "the browser hung". The real cause was three levels away — a
poll that had raced past the job being raised, leaving a `<textarea disabled>` — and the report pointed at
`van.close()` in a `finally`. With `actionTimeout: 15_000` the same run says *"this textarea is disabled"* in
fifteen seconds.

**A disabled control is how every screen in this kit says "there is nothing to do here"**, so a journey meets
one whenever it arrives early — which is most of the time, since arriving early is the condition these tests
exist to examine. `expect.timeout` is set alongside it for the same reason. Note `actionTimeout` belongs
under `use` and not at the top level; putting it at the top level is a **type error**, which is the one
mistake in this class the compiler does catch.

## BN3 — Playwright's 30s default test timeout silently capped a journey's own waits · **NOISE** · ***FIXED 2026-08-11***

The scaffolded `playwright.config.ts` set no `timeout`, so every `expect(..., { timeout: 90_000 })` inside a
journey was truncated to Playwright's 30s per-test default. **The failure reads as "the data never
arrived"** — a plausible, wrong diagnosis pointing at the backend — rather than "the test ran out of its own
budget". A journey is longer than a test by construction: it crosses async projections, sweeps on clocks,
and here a whole context boundary. The template now sets `timeout: 180_000` and says why.

---

## V19 — a journey could not cross a model boundary · **GAP** · ***FIXED 2026-08-11, and the whole board refactor existed for it***

**The finding.** The `journey` skill said *"a journey belongs to the **system**"*; the implementation bound it
to a **model**. `journey-unknown-slice` read *"is not a slice in **this model**"*, because `byName` was built
per model inside the per-model pass. At one model those statements coincide, which is why five runs never
noticed. At two they do not — and the walk that proves two contexts compose was **unavailable precisely where
composition is most at risk**, since the two sides were modelled, generated and implemented separately.

**The cause was one departure from the books**, traced in `BOARD-REFACTOR.md`: `UES` ch. 18 says a **board**
holds many models; the kit made one file per model. Two files are two coordinate spaces, so there was no bar
to draw. Everything else followed from that — the missing alternative-flow link marker, chapters stopping at
the file edge, and `_context-map.drawio` existing only because the files were separate.

**So it was not fixed; it was dissolved.** Steps 2–7 of the refactor: `model.mjs` reads a board (a region is
the band between consecutive model cells, a cell joins by **midpoint**, and the one-model case is the
**identity function**); `slice.mjs` writes regions; every model set migrated; `chapter` absorbed `journey`
per ch. 18; `contract="true"` made the boundary real; and the cross-context chapter became a rectangle.

**Closed by `estate-to-driver`** — `open-site → commission-bay → publish-bay-offered` (estate) then
`translate-bay-offered → bay-availability → hold-bay` (charging). **203 tests, 0 failed.**

**Two refusals had to be opened, both built deliberately in step 3 and both correct until now:**
`slice.mjs` refused `--slices` naming cells in two models, and `chapter-unknown-slice` resolved against one
region. A chapter is now **the one write allowed to cross**, drawn in region 1's strip and spanning the x
range of every slice it names. Two dependent checks moved with it: `chapter-slice-in-design` went board-wide,
and **`chapter-runs-backward` was scoped to a single model**, because two regions have independent column
grids and comparing x across them compares two unrelated rulers.

**It passed first time and was therefore mutated rather than trusted.** Removing the single line that sends
the publisher its trigger turned it red in exactly the right place — `BayListed` empty, no contract crossed.
The walk genuinely depends on the real publisher, the real durable queue and the real translation handler.
**It also asserts the negative before publishing**: charging must not see the bay yet. That line is what
separates *"the contract carried it"* from *"the fold saw it anyway"*, and it is the standing guard against
the false pass this journey existed to expose — a false pass that had been **real**, and inverted the moment
the read side was re-pointed.

**`codegen` needed no change**, which was the risk worth checking: it reads the IR's `journeys` list and the
slice names, and nothing in the emitter cares which model a slice lives in. One cosmetic inaccuracy recorded
rather than fixed: the IR gives a chapter `context=`, which is merely **where the cell is drawn**. For a
crossing chapter that field is arbitrary and must not be trusted; it is harmless today only because journey
tests land in a context-agnostic `Journeys/` folder.

**Also worth keeping:** of the four errors hit on the way, one was **V3 exactly** — `WaitForNonStaleProjectionDataAsync`
needing `using Marten.Events;` — the finding that exists because a generated hint once named a static class as
a namespace. A finding re-encountered by a fresh session is the clearest evidence that writing it down was
worth it.

## V23 — THREE parsers read one file, and the strict ones DELETED what they could not match · **BROKEN** · ***FIXED 2026-08-10***

Found during the board refactor's step 3, cured in step 3b, **before** step 4 reformatted every `.drawio` in
the repo — which is the condition that would have made it fire at maximum exposure.

**The defect.** `model.mjs`, `slice.mjs` and `wireframe.mjs` each carried their own `.drawio` parser. The two
writers anchored on **8-space indentation**, and each rewrote the whole `<root>` from the blocks it matched —
so a cell they did not match was **not merely unparsed, it was deleted**, with no error and no diff anybody
reads. `model.mjs` parsed indentation-agnostically and read the same files perfectly.

**Filed as "two parsers"; it was three.** `wireframe.mjs` had the identical `BLOCK_RE` and the identical
rewrite, so leaving it would have made the cure incomplete.

**The divergence, measured on one file.** De-indent one `<object>` by four spaces in a two-region board:

```
model.mjs validate  ->  0 error(s), 6 warning(s), 25 note(s)   2 models / 13 slices / 58 elements
slice.mjs promote   ->  silently dropped both model cells, collapsing the board to one region
```

One tool called the file perfect; the other destroyed it — **on a `promote`, an attribute edit that touches no
geometry at all.** Nothing caught it, because `validate` then read the wreckage and was happy: the cells it
needed were the ones still present.

**Why it was the most dangerous shape in the findings file.** It is the *inverse* of the "check goes quiet"
family (V5, V9, V13, V17, V18). There, a check stops reporting a real problem. Here, **a check reports success
on a file the other half of the kit will destroy.** Both are silence where a warning belongs; this one also
loses work.

**The cure, and the reason it was not simply "use `model.mjs`'s parser".** `tools/drawio-xml.mjs` (89 lines)
is now the only parser, and it had to be **both** things at once, which neither original was:

| | |
| --- | --- |
| **tolerant** | indentation, attribute order and self-closing style are free — `model.mjs`'s behaviour, the well-tested one |
| **lossless** | every cell carries `raw`, its exact source span including leading indentation and trailing newline |

The second is why the writer grew its own in the first place: `slice.mjs` does not just read, it **splices raw
block text back**, and that byte-identity is what keeps a `.drawio` diff reviewable. A parser returning only
attributes could not have served it. Recognising that the shared parser needed a property *neither* original
had is the part worth keeping.

**Two adjacent hazards of the same shape, fixed while there.** Both writers' `<root>` rewrite used a pattern
that, on a miss, **returned the string unchanged** — so the write silently did nothing and reported success.
Both now refuse. And both used string replacements, where a `$&` or `$'` in cell text would be *substituted*
rather than written — and GWT example data already contains `$SeedName`, so the function form removes the
class rather than the instance.

**Geometry is deliberately NOT shared**, and the reason is recorded in the module: the two readers genuinely
disagree. `slice.mjs` returns `null` when a geometry declares neither `x` nor `width` — a relative edge
geometry, not a box, and one that must not be moved — while `model.mjs` reads it as a box at `0,0`. Each is
right for its caller, and `model.mjs`'s result is serialised into the compiled IR. V23 was never about
geometry; it was about **which cells exist**.

**`assertNothingDropped` is kept even though it should now be unreachable**, and was proven not to be dead
code: an unterminated `<object>` still trips it. Its message no longer blames indentation, because
indentation is no longer the cause. It is the tripwire if the split ever returns.

**Verified before either caller was switched:** the new parser reproduces both old parsers — same blocks, same
order, same exact text for the writer; same cell-id set for the reader — across all 15 `.drawio` in the repo.
Afterwards: `cart-replay` byte-identical and idempotent, all 12 validate targets unchanged in text and
`--json`, the step-3 writer table 10/10 with membership by cell id, `wireframe.mjs` byte-identical on six
models, and a board reformatted **the way draw.io actually reserialises** — halved indentation, `id=` moved
last on every `<object>` — read, written and re-read identically. Before the cure that file would have been
gutted.

---

Everything the kit got wrong, everything the runs taught, and every decision parked for the human.

**Five runs so far.** The first (CPOC01, *Recipe Box*) took a business brief through the whole workflow to
a clickable Docker app. The second (CPOC02, the book's shopping cart) was a deliberate verification on a
domain the kit had never generated from, chosen so that the **book** supplies every domain answer and the
kit can be scored against a documented expected outcome. The third built
`reference-implementations/translation/` — the last of the four patterns — model → generator → implementation
→ run, and is section **T** below. The fourth (CPOC03, the book's cart again, but as a **live walkthrough**
for a coworker) drove all eleven `event-model` phases in one session and is section **W** — two `BROKEN`
findings, both fixed mid-run because each one blocked the next phase. The fifth is three parallel runs
(CPOC03/04/05) of one demo-sized brief — same input, twice on Opus and once on Sonnet — built specifically
to answer *is the generated code reproducible, and does the model tier change that* and is section **X**.

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
**3500px, past the then-current 3200px readability budget**. Recorded in
`reference-implementations/README.md` so the next person does not re-litigate it.

**Superseded in part by AD8:** the width budget has since been removed, so the *width* is no longer the
argument. The decision stands on its own merit — one model teaches one thing, and a seventh recipe is a
separate teaching point rather than a tenth column.

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

## KNOWN GAP — CLOSED AT BOTH ENDS

**Both halves are now built.** `journey` walks slices through the real API; `ui-journey` walks the same
`em="journey"` cell through a browser with Playwright. One cell, two wires — never two cells for one story.

| | Skill | Tool | The one rule |
| --- | --- | --- | --- |
| behind the API | `journey` | `slice.mjs journey`, `codegen.mjs` | no step may **append an event** |
| in front of it | `ui-journey` | `uijourney.mjs plan/scaffold/check` | no step may **fake the backend**, and none may **skip the navigation it is testing** |

**What the UI half derives, and the one thing it cannot.** `plan` reads the compiled IR for the ordered
screens, each screen's `displays=`/`inputs=`/commands, the exact `data-em` selectors the port is allowed to
have, and every rule name a rejection can surface with the wire shape `enforce=` implies. With no journey named
it derives the **candidates** from real edges — slice A leads to B when an event A appends feeds a view that
feeds B's screen — and prints the `slice.mjs journey` command for each. What it cannot derive is **how a user
reaches a screen**: there is no notation for *"the modal opens from the list"*, so `plan` flags every screen no
data path reaches and asks. On CPOC01 that fired on `new-recipe` immediately, which is correct — it is a modal.

**Playwright, and the "no Playwright" rule is intact.** That rule is about `design.mjs`, where shooting a URL
needs nothing but the installed Chrome. A journey clicks. Two things come with it that are not conveniences: a
real 390px layout viewport from device metrics, so **A1's sub-500px lie does not arise and the iframe workaround
is not needed**; and retrying assertions, which are the only way to distinguish *eventually consistent* from
broken. An assertion that only passes on retry is a finding, not a pass.

**And it buys back the capability this file recorded as lost.** B3 and `frontend-agent` both say headless Chrome
shoots a URL and does not click, so click-only states were unlookable. `journeys/_shot.ts` writes into
`review/_shots/` under the name `review.mjs` already parses, so they land beside the agreed design with no extra
step — which is often the largest single thing a run produces.

**Deliberately not scheduled and deliberately not a gate.** It starts containers and drives a browser, so
`codegen` prints `NO UI JOURNEY` once two claimed slices have screens and stops. Honest scope of "green" now:
**every slice works, the named journeys compose behind the API, and the named journeys are walkable in front of
it** — anything not named, and any screen state not walked, is still a human clicking. See ANTI-PATTERNS #16.

**Two false positives caught by running the new checks before believing them**, which is this file's own
standing lesson (C11) applied to itself: the content checks all fired on the scaffold `scaffold` had just
written, and the console/network check demanded a literal `page.on()` while the scaffold correctly calls the
supplied `watchForSilentFailure` helper. Fixed by skipping any spec still carrying its `TODO(uijourney)`
markers, and by teaching the check about its own helper. A check that does not know its own scaffold is worse
than no check.

### The original finding, kept because the reasoning is the record

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

## CC — a concurrency invariant IS testable on this stack · ***PROVEN BY RUNNING, 2026-08-07***

**The human refused to start CPOC03 until this was proven**, against my report that nothing in the kit could
test *"two members at the same instant must not both succeed"*. That report was half right: **no kit-generated
test can, and the stack can perfectly well.** `probes/concurrency-invariant.cs` — 43 races, 270 writers per
run, three consecutive identical runs, exit 0.

### It is TWO mechanisms with two exception types, not one

The single most useful finding, and neither the mirror nor I had it right:

| The contested operation | Refused by | Exception |
| --- | --- | --- |
| **creating** the stream — the first booking of a desk-day | the stream table's primary key, in Postgres | `ExistingStreamIdCollisionException` |
| **appending** to a stream that exists — a re-booking after a cancellation | the optimistic version check | `EventStreamUnexpectedMaxEventIdException` |

Both matter for desk booking, and a generated test has to expect the right one. **The mirror names neither for
the append case:** `scenarios/command_handler_workflow.md` says a stream that moved under `FetchForWriting`
fails with *"a Marten `ConcurrencyException`"*, and on Marten 8.37.4 with `StreamIdentity.AsString` it does
not — it throws the type the older `aggregates-events-repositories.md` page names. A test must accept either.

**This does not break the "docs win" rule (MD); it delimits it.** That rule is about which **design** to
adopt. For an **observable runtime fact** the kit's own escalation applies — read the mirror, grep the `.xml`,
then **compile** — and the compiler is the tiebreaker. Worth stating because the two rules point opposite ways
and it would be easy to cite the wrong one.

### `Task.WhenAll` is not a race, and my first attempt passed for the wrong reason

Attempt 1 reported `won=1` and looked like a success. It was not: `refused-by-rule=9,
concurrency-conflict=0`. Ten writers were released together and then each did its **own** `FetchForWriting`
round trip, so the database serialised them and nine read the state *after* the winner committed. They were
refused by the business rule; the concurrency guard was never exercised. **A test that green-lights a race it
never ran is worse than no test.**

**The fix is to split read from write.** Every writer reads and decides first — so all N observe the same
state — and only then does a `TaskCompletionSource` fire the starting gun for the writes. That is
simultaneously deterministic *and* genuinely parallel, and it moved the result to `concurrency=9`.

### The control had to be the BOUNDARY, not the guard — and that is the real lesson

My first control dropped `FetchForWriting` and expected both writers through. It failed: **in Rich append
mode (the Marten 8 default) even a bare `Append` carries a client-assigned version**, so the second writer
still lost. The protection is stronger than the thing I was trying to remove.

So the honest control is the **modelling** decision, not a library setting: key the stream **per booking**
instead of per desk-day, and there is no shared stream to serialise on. Measured: **10 winners, 10 bookings
for one desk-day.** Same rule, same library, two boundary choices — one enforceable and one not.

That is `stream-boundaries` from the `architect` step made executable, and it is the best evidence the kit has
that the boundary question is the one that matters. CLAUDE.md has claimed exactly this in prose since it was
written; now it has a number.

### What this changed about the kit · ***BUILT INTO `architect` the same day***

The human's call on where it belongs: *"it's the architect's job to find exactly points like this where it can
say write a concurrency test."* So the architect now does both halves — it **derives** the contention points and
**scaffolds** the tests.

- **A seventh question family, `contended-invariant`.** A *rejection* whose GIVEN is in the very stream its
  command appends to — the class of rule two callers at the same instant can both pass. Filtered to
  `enforce=aggregate` with a **non-empty** given, because a periphery rule is settled by the request alone and
  a rejection with no given has no accumulated state to race over. Without that filter it asked for a race
  test on *"a campaign with no name is refused"*, which is noise. On `campaigns` it finds exactly 2.
- **`architect.mjs tests`** emits `Concurrency/ConcurrencyHarness.cs` (overwritten) and scaffolds one
  `<Slice>ConcurrencyTests.cs` per invariant (kept). Two tests each: a **deterministic** multi-session race,
  which is the primary assertion and cannot flake, and an **HTTP** race asserting *at most* one success —
  deliberately "at most", because racing requests cannot be guaranteed to overlap and "exactly one" would
  flake while "at most one" is true either way.
- **`check` reports `RACE TEST NOT WRITTEN`**, and codegen surfaces it through `ARCHITECTURE DECISIONS MISSING`.
- **Still not model notation.** `gwt-multiple-whens` stays an error (AR). The model says *"one member per desk
  per day"*; the race is how that is enforced.

**Verified by compiling AND by running, because a harness that compiles is not a harness that works.**
`dotnet build` on the generated `campaigns` project: 0 warnings, 0 errors with the harness and both scaffolds
in it. Then `probes/harness-check.cs` — which copies `RaceAsync` and `Classify` **verbatim** from what the tool
emits — races the real thing: one winner and `StreamCollision=9` on a new stream, one winner and
`VersionConflict=9` on an existing one, `RefusedByRule=6` when the desk-day was already booked (no refusal
misreported as a conflict), and 30/30 alternating rounds with no hang. Three consecutive runs of both probes,
identical.

**Two bugs found while wiring it, both worth recording:**

- **`pascal()` had to be copied from codegen, not approximated.** A scaffolded race test names types codegen
  generated, so a different casing rule produces a reference to a type nobody emitted.
- **The system name must be `pascal()`-ed before it names a folder.** A model cell saying `system="campaigns"`
  put the tests in `generated/campaigns` while codegen writes `generated/Campaigns` — on Windows the same
  folder, on a case-sensitive CI a different one, and the namespace was wrong either way. **`uijourney.mjs`
  had the identical latent bug** and only worked because that system name was already PascalCase; fixed in
  both.

- **`probes/` is a new kit folder** for runnable proofs of stack behaviour, with the three file-based-app
  rules that cost a build each: `PublishAot=false`, types after top-level statements, and **document types
  must be `public`** or Marten's runtime codegen fails with a wall of generated C# instead of the real cause.

## MD — where the kit and the critter-stack docs disagree, the docs win · ***STANDING RULE, and the first audit***

**The human's rule, and it means the kit gets CHANGED rather than documented as different.** These libraries
move faster than model knowledge — the entire reason `reference/llms/` exists — so a kit holding its own
opinion beside theirs is a second source of truth nobody reconciles, and the difference becomes a bug in
generated code that compiles and passes.

**It was prompted by a claim of mine that turned out to be wrong in three ways at once.** I had reported that
*"the kit's default and Marten's disagree — the kit picks `Inline`, Marten registers multi-stream `Async`"*.
Audited against the mirror:

| The kit claimed | The docs say |
| --- | --- |
| Marten *"registers multi-stream projections `Async` by default"* | **there is no default.** `ProjectionLifecycle` is a required argument, and **22 of 22** `Projections.Add` call sites in the mirror pass it explicitly |
| `Inline` *"invites concurrent writes stomping each other into apparent event skipping"* | *"event skipping"* is an **async-daemon high-water-mark** phenomenon (`async-daemon.md`), so it was attributed exactly backwards |
| `Inline` everywhere is a reasonable default | the multi-stream page states the shape outright: *"Register the lookup projection **inline** and the multi-stream projection **async**."* |

**So `codegen` was changed to follow the library: single-stream `Inline`, multi-stream `Async`.** Verified on
`campaigns` — `CampaignDashboard` (fed by 2 stream types) now registers `Async`, `MessageStatus` and
`MessageMetrics` stay `Inline`, and the two views with no slicing rule keep their commented-out registration
but now suggest the right lifecycle.

Three consequences the change had to carry, none of them optional:

- **`ConfigureStore` now starts the daemon** — `marten.AddAsyncDaemon(DaemonMode.Solo)` — but *only* when a
  view is actually registered Async. The first version named every multi-stream view including the two whose
  registration is commented out, which would have sent a reader looking for a projection `Register()` never
  adds. `DaemonMode` is in `JasperFx.Events.Daemon`, stated by no doc page and confirmed from a file in this
  repo that compiled.
- **The GT test hint now branches on the lifecycle.** An Async view is not current when the append returns, so
  the hint carries `await Store.WaitForNonStaleProjectionDataAsync(...)` and says that asserting without it
  fails intermittently and looks exactly like a broken projection. Without this the change would have turned a
  correct generator into one that hands you flaky tests.
- **The multi-stream test is now defined once** and shared by the lifecycle and the projection base class. Two
  copies could disagree, and a view registered Async while declared `SingleStreamProjection` is a worse bug
  than either half.

**A second stale claim found by the same audit:** *"`RaiseSideEffects` forces `Async` outright"* — repeated in
five places. It is now only the **default**: `opts.Events.EnableSideEffectsOnInlineProjections = true` runs
side effects on an `Inline` projection. Corrected in CLAUDE.md, ANTI-PATTERNS #14, `backend-agent`, and two
`add-slice` references.

**One claim audited and upheld:** *"Wolverine treats a handler's return value as a cascading message with no
opt-out."* `return-values.md` confirms it, and `[EmptyResponse]` is an HTTP-response concern rather than a
message-handler opt-out. Worth recording that the audit was not a rout.

**And a defect this did NOT fix, by design:** `ViewRegistrations.cs` is a `scaffold`, so **the four existing
reference implementations keep their `Inline` registrations.** That is the *"the generator does not reach
backwards"* rule working as intended — regenerating them would change measured behaviour in folders whose
tests assert immediately. Their editorial refresh belongs to the future skill that keeps them current.

**What to audit next, and how to choose.** The claims worth re-checking are about **defaults and behaviour**,
not API names: a wrong method name fails to compile, while a wrong default ships. Search for *"by default"*,
*"defaults to"*, *"forces"*, and any sentence attributing a behaviour to Marten or Wolverine.

## AR — the architect step: concurrency belongs to the implementation, not the model · ***BUILT 2026-08-07***

**Raised by the human, as a correction to a proposal of mine that was wrong.** I had said the first thing to
fix for CPOC03 was that `gwt-multiple-whens` blocks a concurrency scenario — *"two members book the same desk
at the same instant, exactly one wins"* — and that the grammar should relax to allow it.

**That is finding T0 all over again**, and the human named the principle instead: *the event model represents
domain knowledge and how information flows through the system, and that is its sole responsibility.*
Concurrency is technical, so **nothing about it enters the model or its grammar.** Consistency enters only as
modelling done right — swimlanes and stream boundaries drawn properly, closing-the-books shapes recognised —
which is judgement, not a rule to enforce. What was missing is a step that *reads* the model, notices where it
implies a concurrency or consistency problem, and checks the **real backend stack** for how that is handled.

**Both books back it, and one line settles it:**

> *"Snapshots are a pure technical tool and are **neither modeled nor mentioned in an Event Model** typically."*

The little book files Live-Model vs Database-Projection under *"Implementation Hints"*. And the business rule
in this domain is *"one member per desk per day"* — the business does not care about instants. So
`gwt-multiple-whens` stays an error and the proposal is retracted.

### What the books actually say on the implementation side

Researched from the local extracts rather than the web, per A7b. Ch. 4 of *Understanding EventSourcing* is
titled **"CQRS, Concurrency, (Eventual) Consistency"**:

| | |
| --- | --- |
| **concurrency** | *"we apply optimistic locking not on the entire Event Store, but on **individual event streams**"* — version = the index of the last event; the fix is refetch and reapply. So **once the stream boundary is right, concurrency is mechanical** |
| **the boundary** | *"the aggregate basically defines a transactional consistency boundary protecting business invariants"*; little book: *"An aggregate is a consistency boundary"*, and *"if a single command touches multiple aggregates or swimlanes… these aren't two separate aggregates—they're one"* — which the kit **already** enforces as `command-crosses-swimlane` |
| **eventual consistency** | three options with named costs: accept and document; make it immediately consistent in one transaction (*not independently scalable; a projection error can abort the business transaction; each added projection slows the write*); or a **partial live model** over the projection, an in-memory cache of the newest events filling the gap |
| **who decides** | *"This issue should be discussed with the subject-matter-experts during one of the Event Modeling sessions… it could lead to hard-to-find bugs that are nearly impossible to reproduce"* — the **question** belongs to the session, the **answer** to the implementation |
| **growth** | *"better to limit the length of a stream naturally by understanding the business processes"* — closing the books beats snapshots, which are *"the exception, not the rule"* |
| **replay** | an event handler triggering an action *"might be triggered again during an event replay… not a problem in general if the changes are idempotent"* |

Two findings fall straight out: **the kit's read-side default and Marten's disagree** — the kit picks `Inline`,
Marten registers multi-stream projections `Async` — so `Inline` is a decision the kit was presenting as a
default. And **the partial live model is not in the six-recipe menu as a combination**; the table offers live
aggregation *or* a projection, never both layered, which is the book's way to close the staleness window
without paying `Inline`'s price. A gap in the reference implementations, not in the grammar.

### What was built

`tools/architect.mjs` (`questions` / `record` / `check`) plus the `architect` skill. It derives six families
of question from the IR, **answers none of them**, and never touches a `.drawio`. Same split as
`slice.mjs`/`add-slice`. A step **before** codegen rather than part of it, because these decisions are
system-scoped: slice 1 picking `Inline` and slice 4 needing `Async` conflict after both are green. Decisions
land in `<project>/ARCHITECTURE.md` as **Decision / Because / It costs**, and `codegen` reports
`ARCHITECTURE DECISIONS MISSING`.

**Validated against `state-view/campaigns/`, chosen because its real decisions are already documented** — so
the questions could be scored rather than admired. Six questions, and every one maps to a decision that
folder actually had to make:

| It asked | The folder's documented reality |
| --- | --- |
| `cross-stream-rule` on *"a message cannot be queued to a closed campaign"* | the command appends to **Message**, the GIVEN lives in **Campaign** — a genuine read-then-append window, and the kit already documents `FetchLatest` as the mechanism while nothing asked whether the race mattered |
| `stale-read/CampaignDashboard` | fed by 2 stream types, so Marten defaults it `Async` — this is the view whose journey test needed `WaitForNonStaleProjectionDataAsync` |
| `view-identity/SenderMonthly/month` | **finding #1 of that folder**: seed data stamped `queuedAt = 2026-01-15` produced a row keyed `2026-08`, because the key came off the envelope |
| `view-identity/DeliveryLog/recipient` | correctly identified as *probably a fan-out* of `recipients`, naming the candidate — the legitimate case, distinguished from the bug above |

**Three defects in my own first version, all caught by running it:**

- **It iterated the letters of a key.** A swimlane's `identity=` is an array in the per-model IR but an
  element's is still the raw string, so `view-identity/CampaignDashboard/a` was asked about a view keyed
  `campaignId`. The system IR splits it; the per-model one does not.
- **It cried wolf: 17 questions on a nine-slice model**, because `stream-boundary` and `stream-growth` fired
  per stream unconditionally — two of them amounting to *"is one campaign the right scope for one campaign"*.
  Collapsed into **one boundary map per model**, with the specific problems (`cross-stream-rule`,
  `no-stream-key`) left per-occurrence where they are actionable. 17 → 6.
- **A `continue` skipped the highest-value check.** The staleness guard sat above the identity check, so
  every single-stream view with no screen was skipped — including `SenderMonthly`, the one real documented
  bug in that model.

**And the staleness check that every write-once file in this kit needs** is there from the start rather than
retrofitted: sections are keyed by a stable question id, so `check` separates a question with no section
(the model grew) from a decision still `TODO` from an **answer to a question nobody asks** (the model changed
under it). Verified both ways by editing a model and re-running.

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

**The `then=` question is decided: no.** A read model is not a legal outcome on a slice that has a Command,
and it should stay that way. The human's call, and both books agree — the little book's automation shape is
*"Given these 2 Events, we expect the automation to run automatically… and result in **another Event**"*. What
such a slice promises is the events it appends; the View it consults is machinery, which is exactly why the
automation folder can satisfy the drawing with a durable inbox and the translation folder must.

Nothing is lost by it. A todo View's fold has observable consequences and they are all events — get
`StockNoticesToApply.status` wrong and either a second `StockLevelSet` appears or a refusal does, both already
pinned by `gwt-translate-2`. So a derived field on such a View is now the note `derived-on-todo-view`, asking
the question that actually matters: would getting the fold wrong change which events appear, and would a GWT
catch it? **All four reference implementations now validate at 0 errors, 0 warnings.**

**Not promoted to error, and what blocks it is now exactly two cases** — `Submit Cart.orderedProducts` and
`Cart Submitted.totalPrice` in `tools/fixtures/cart/`. That fixture reproduces the book, and the book's model
does not say how `totalPrice` is computed or with what numbers. Filling them in means inventing domain facts,
which is the one thing this kit refuses everywhere else. **The warning is correct; promotion waits for someone
with the book, not for a change to the rule.**

**And a bug worth recording about the tooling rather than the kit:** the first implementation wrote a NUL byte
instead of a space into a template literal, so the "has this field got an example?" key never matched and the
rule would have fired on every derived field, including ones with examples. It surfaced as `grep` reporting
`model.mjs` as a binary file. Caught by checking why, rather than working around it.

### T1 — The generator emits no ingest seam for a foreign event · **GAP** · ***FIXED 2026-08-09***

**Fixed by generating the seam, not only the report.** The decision that made it straightforward was choosing a
default: *a foreign event arrives as a message on a durable local queue.* Once that is assumed, everything the
generator needs is derivable — `codegen` scaffolds `Landing/Ingest<Event>Handler.cs`, one per foreign event
rather than per slice, named `*Handler` so conventional discovery finds it with no `Discovery.IncludeType`. The
body is `TODO(codegen)` and is reported as `INGEST NOT WIRED` until closed.

**It needed no new configuration**, which is the sign the default was the right one: `Program.cs` has set
`opts.Policies.UseDurableLocalQueues()` since long before this, so the envelope is persisted on arrival,
retried on failure and dead-lettered on repeated failure with nothing written. That queue is exactly the
"durable inbox as the todo View" the translation folder had argued for in prose.

Tests reach it through a new `WhenReceiving(message)` on `IntegrationContext` —
`IHost.InvokeMessageAndWaitAsync(object, int)`, confirmed against the mirror's testing page **and** against
`WolverineFx 6.25.1`'s own `Wolverine.xml`, which carries the exact `(IHost, object, int)` overload matching
`WhenPosting`'s existing millisecond convention.

**The generated handler's signature is not a guess**: `Handle(TNotice, IMessageBus, ILogger, CancellationToken)`
is byte-for-byte the signature of `StockTranslator` in this folder, which passes 15/15 against real Postgres. So
the shape was proven by running code before the generator emitted it.

Measured: regenerating this model from scratch produces the handler and builds **0 errors, 0 warnings**; a
second run keeps it and prints both `AUTOMATION NOT WOKEN` and `INGEST NOT WIRED`.

**Two things this deliberately does NOT close.** The transport in front of the queue is still hand-owned — a
webhook, a table they INSERT into, a broker, a poll — because who is responsible for a lost notice is a
durability decision the model cannot make. And **T4 stands unchanged**: a feed wired to nothing at all still
leaves the suite green, because a test hands the notice to the queue itself. The report says both out loud
rather than implying the path is complete.

**The related correction:** the `<Slice>Wakeup` scaffold's decision table said *"the trigger event is FOREIGN
→ sweep the View on a clock"*, which sends a 1:1 translation to a clock it does not need and cannot use. It now
says the arrival is the wakeup, and a translation slice's `RegisterServices` TODO says that deleting it and
leaving every hook empty is the normal answer.

---

**The original finding, as filed:**

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

### A8 — `wireframe.mjs` draws every screen title twice · **NOISE** · ***FIXED***

`tools/wireframe.mjs` emitted a chrome cell carrying the screen's own `label`, which the screen box
already renders at the top with `verticalAlign=top; spacingTop=6`. Every scaffolded wireframe overlapped
its own title, rendering `Cart PageCart Page`.

**Fixed in the CPOC03 walkthrough.** The title chrome is gone; the screen cell's own label *is* the
title, and `TITLE_H` is still reserved so the rows start below it rather than through it. Verified by
re-scaffolding and looking: 36 cells instead of 40, one title per screen. See **W1**, which is why this
had to be fixed by hand in CPOC01 rather than caught by re-running the tool.

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

**D2 — Rename `pattern=` to the canonical terms** · ***DONE 2026-08-07***. `state-change` / `state-view`
instead of `command` / `view`, as a **hard cutover with no deprecated alias** — the old values are now
`slice-unknown-pattern` errors.

**Done deliberately with no project attached**, which is what made it cheap: it touches every model, so
after CPOC03 exists it would have been a migration rather than a rename. Both POC projects were archived
first (`_archive/CPOC01-recipe-box`, `_archive/CPOC02-shopping-cart`), so nothing live read the old
vocabulary.

**What the rename was really about.** `command` and `view` were already taken by **element kinds** — a blue
Command cell is `em="command"`, and `command=` on a wireframe action names the command it issues. So
`model.mjs` had `s.pattern !== "command"` and `cmd.kind !== "command"` *two lines apart, meaning different
things*, and `slice.mjs` had `command: [… ["command", 0, 0] …]` where key and value were unrelated
concepts. The new values also agree with `slices[].kind`, which the IR has always derived as
`state-change` / `state-view` — and that agreement is the point rather than a coincidence, because
`slice-pattern-mismatch` exists precisely to catch declared and derived disagreeing.

`automation`, `translation` and `upstream` were already canonical and did not move.

**Scope, measured:** 7 code sites (4 in `model.mjs`, 3 table keys in `slice.mjs`; `codegen.mjs` needed
nothing — it only interpolates `s.pattern` into a comment and filters on `automation`/`translation`),
29 `pattern=` attributes plus their slice-cell labels across 8 `.drawio` files, ~31 doc and skill
mentions, and **two skill reference files renamed** — `add-slice/references/command.md` → `state-change.md`
and `view.md` → `state-view.md`, because that skill resolves `references/<pattern>.md` *by convention from
the pattern name*, so leaving them would have silently broken the lookup.

**Verified behaviour-preserving rather than assumed.** Every fixture reports byte-identical diagnostic
counts before and after, checked by running HEAD's `model.mjs` against HEAD's fixtures: `gaps` 4/2/1,
`resolved` 0/1/0, `unsourced` 1/1/0. `cart-replay.mjs` is 0 errors in all ten rounds and byte-identical on
re-run, ending 0/7/20 exactly as before. All four reference implementations remain 0 errors, 0 warnings.
And `slice.mjs add --pattern command` now fails with `unknown pattern "command". One of: state-change,
state-view, automation, translation, upstream.`

**Two traps worth recording**, both of which a blind find-and-replace would have walked into:

- **`CLAUDE.md`'s `em=` table and the `command=` attribute row must NOT change**, nor `README.md`'s colour
  table — those three say `` `command` `` meaning the element kind. Caught by reading each hit rather than
  by counting them.
- **The slice cell's `label=` renders the pattern on the canvas** (`add-entry&#10;command · in-design`), so
  a migration that changed only the attribute would leave every band captioned with the old word. Matched
  on the `&#10;` entity so it could not touch prose.

**One stale claim found on the way and fixed:** `README.md` advertised
`validate tools/fixtures/resolved.drawio  # 0 / 0 / 0`, and it has been 0 errors / **1 warning** / 0 notes
since `slice-needs-gwt` started covering view slices (B-1). Confirmed pre-existing, not caused by the
rename.

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

---

## W. Findings — the CPOC03 walkthrough run (2026-08-07)

A **fourth run**, and a different shape from the first three: a live demo for a coworker, driven through
all eleven `event-model` phases in one session against `CPOC03/inbox/01-shopping-cart.md`. The model is
`CPOC03/diagrams/shopping-cart.drawio` — 7 slices, 19 elements, 3 swimlanes, 31 GWTs, **0 errors and
0 warnings**.

**These were fixed during the run, not after it** — the opposite of the CPOC01 policy, and deliberately
so: W1 blocked phase 8 outright and W2 blocked phase 9, so there was no way to finish the walkthrough
without them. Both fixes were verified against the kit's own regression suite before continuing.

### W1 — `wireframe.mjs` has never run on any file in this kit · **BROKEN** · ***FIXED***

`tools/wireframe.mjs` reports **`no screen cells — nothing to scaffold`** on every model in the kit,
including the fixture that demonstrably has four:

```
$ node tools/wireframe.mjs scaffold tools/fixtures/cart/cart.drawio
tools/fixtures/cart/cart.drawio: no screen cells — nothing to scaffold.
  (fixture has 4 screen cells)
```

**Cause.** Its `BLOCK_RE` alternatives all end `</object>\n` / `</mxCell>\n`, and **every `.drawio` in
this kit is CRLF** — the template, the fixtures, all four reference implementations, and therefore every
model grown from one. `</object>\r\n` does not match `</object>\n`, so `matchAll` returns **zero** blocks.
Unlike `slice.mjs` and `cart-replay.mjs`, which both normalise on read and restore on write,
`wireframe.mjs` did neither.

**Why it stayed hidden.** The failure mode is not a crash but a *plausible sentence*. "No screen cells"
reads as a modelling mistake — as if the screens were not annotated yet — so the natural response is to
go and check the model, which is fine, and then to draw the wireframe by hand. Which is exactly what
CPOC01 did (see **A8**: *"worked around by hand"*). The workaround concealed the tool.

**Fixed.** Normalise on read, restore the original line endings on write. Verified: the fixture now
scaffolds 4 screens / 28 bound fields / 36 cells, stays CRLF, and still validates at 0 errors.

**The lesson is bigger than the bug.** A tool that reports a *domain-shaped* reason for a *plumbing*
failure will be believed. Any "nothing to do" exit path should be able to distinguish *I looked and
found none* from *I could not read the file* — `blocks.length === 0` on a file that plainly contains
`<object` is the second, and should say so.

### W2 — A GWT step could not have both a parenthesised label and example data · **BROKEN** · ***FIXED***

`CLAUDE.md` states the rule plainly: *"A label may legitimately contain parentheses — the book's own
model writes `Inventory Changed (external)` — so parentheses alone do not make example data; an `=`
inside them does."* Both halves worked; **the combination did not.**

```
given="Stock Level Changed (external)(productId=$Widget, quantityOnHand=5)"
  -> ERROR [gwt/gwt-unknown-event] given="Stock Level Changed", which is not an Event in this model.
```

**Cause.** `parseSteps` anchored on the **first** parenthesis: `/^([^(]*?)\s*\((.*)\)\s*$/`. `[^(]*?`
cannot contain a `(`, so the label stopped at `Stock Level Changed`, and `(.*)`
greedily swallowed `external)(productId=$Widget, quantityOnHand=5` — which contains an `=`, so it was
accepted as example data and the label lost its suffix.

**Fixed.** Anchor on the **last** paren-free group instead: `/^(.*)\s*\(([^()]*)\)\s*$/`. All five cases
now parse correctly — bare label, label + example, label with parentheses, label with parentheses **+**
example, and a plain command with example. `cart-replay.mjs` still passes with a byte-identical fixture,
and all four reference implementations still validate at 0 errors / 0 warnings.

**Why it stayed hidden.** It needs a *foreign* event to appear in a GWT's `given=` **carrying example
data**. The cart fixture writes `Inventory Changed (external)` in a `given=` but never with an example;
`reference-implementations/translation/` has examples but no parenthesised label. This run was the first
to do both — which is what a translation slice with worked examples looks like, and is now the normal
case rather than an exotic one.

### W3 — `slice.mjs`'s GWT layout constants are dead, and the documented height is too small · **WRONG**

`tools/slice.mjs:39` declares `GWT_W = 300, GWT_H = 120, GWT_PITCH = 140, GWT_TOP = 30` and **uses none
of them** — grep returns exactly one hit, the declaration. GWT placement is entirely the caller's
(`cart-replay.mjs` hardcodes the same numbers), and `reflow` sizes the GWT lane from the cells it
actually finds.

That would be harmless, except the numbers are also in `CLAUDE.md`'s layout table as though they were
enforced, **and 120px is too short for a GWT carrying worked example data.** A three-line rule plus a
GIVEN/WHEN/THEN with examples runs to about ten lines at `fontSize=11`, which overflows the box —
invisible in XML, obvious the moment you render. This run used **150 tall at a 170 pitch** and every one
of 31 cells fits.

Not fixed, because the right fix is a decision rather than an edit: either delete the dead constants and
let `CLAUDE.md` say the height is the caller's, or make `slice.mjs` own GWT placement properly and raise
the default. The second is better — `reflow` already adapts — but it moves every GWT in the fixture, so
it needs the byte-identical assertion re-baselined deliberately.

### W4 — `slice.mjs add` measures its append position from *any* cell, including scratch · **NOISE**

Phases 1–2 of `event-model` are a brainstorm wall — loose stickies with no `em=`, which the checker
correctly ignores. But `slice.mjs add` computed the first column's x from the rightmost cell **on the
canvas**, so the first real slice landed at `x=1420` with a 1300px empty gutter and a page 1300px wider
than it needed.

Harmless and obvious once seen — the fix is to clear the wall before laying columns, which is what a
real team does with sticky notes anyway. Worth writing down because the skill's phase order *produces*
this situation: phases 1–2 draw cells that phases 4–6 replace, and nothing says so.

### W5 — the UI routing strip overflows past 7 View→Screen feeds · **NOISE**

Two of this model's eight `View → Screen` routes were allocated the **same** y:

```
Stock Levels  -> Cart Page: UI routing strip y=553
Cart Contents -> Cart Page: UI routing strip y=553
```

The strip is documented as y=500 height 50, and allocation is `uiLane + 345 + 8n` — so n=0..5 fits
(505..545) and n=6 onward is already outside it. Two views feeding four cells of one screen is eight
routes, which is not exotic: it is what `joins=` exists to describe. The lines are 8px apart so nothing
is *unreadable*, but two edges genuinely share a run, which is the exact defect the per-edge-y rule
exists to prevent. Either widen the strip or fall back to a second corridor past n=5.

### W6 — the generated project did not compile: an automation's label used as a C# class name · **BROKEN** · ***FIXED***

`dotnet build` on a freshly generated CPOC03 failed with four syntax errors:

```
StockFeedTranslator.cs(32,27): error CS1514: { expected
public static class Stock Feed Translator
```

**Cause, and it is the interesting part: this bug was already known, already fixed, and the fix was
half-applied.** `tools/codegen.mjs` carries a comment saying exactly this —

> *"pascal(a), NOT a. An automation's label is a DOMAIN label and may contain spaces… Used verbatim it
> produced a file called `Inventory Processor.cs` containing `class Inventory Processor`… Latent until a
> model used a label of more than one word; every earlier one happened to say `EmailProcessor`."*

— and the file name and the `typeof()` in `Program.cs` were duly `pascal()`ed. **The class declaration
eleven lines below was not.** It still read `public static class ${a}`.

**Why it stayed hidden after being found.** Same reason as the first time, one layer down: the only
automation labels in the kit are `Email Processor` in the automation reference implementation and
`Inventory Translator` / `Price Translator` in the cart fixture — and the fixture is a `.drawio` that is
never generated from. Nothing in the kit's own suite runs `codegen.mjs` and then `dotnet build`, so a
generated project that does not compile is not something any check can currently notice.

**Fixed**, and verified by regenerating and building: 0 errors, 0 warnings.

**The lesson is about the comment, not the code.** A note saying a bug is fixed is not a test that it is,
and this one actively cost time — reading it, the natural conclusion is *"this cannot be the problem, it
is handled"*. Against **CLAUDE.md**'s standing claim that *"`dotnet build` succeeds with 0 warnings"*: that
claim is measured on one model, and it is the kind of claim the docs-win rule exists to re-check.

### W7 — race tests ignore `status=`, so unclaimed slices turn the suite red · **BROKEN** · ***FIXED***

`node tools/architect.mjs tests` scaffolded 8 race tests (2 each for four contended slices), every one of
them **live**, every one of them throwing `NotImplementedException: TODO(architect)`. All four slices are
`in-design`. The suite went from

```
Failed: 0, Passed: 3, Skipped: 28, Total: 31       <- one slice finished, and you can SEE it
```

to

```
Failed: 8, Passed: 3, Skipped: 28, Total: 39       <- red, for four slices nobody has started
```

**This is the exact failure `status=` exists to prevent**, in CLAUDE.md's own words: *"without this, one
finished slice is invisible — 55 failures look identical whether nothing is built or everything but one
thing is."* `codegen.mjs` has enforced it since it was written, via `factAttr()`. `architect.mjs` never
read `status=` at all — grep for it returns one hit, an unrelated `spawnSync` exit code.

**Fixed** by giving the race payload the slice's `status` and reusing codegen's exact `CLAIMED` set and
skip wording. Suite back to `Failed: 0, Passed: 3, Skipped: 36, Total: 39`.

**Two things this inherits, both deliberate and both worth knowing:**

- **The same trap as `TESTS STILL SKIPPED ON A CLAIMED SLICE`.** The Skip is baked in at scaffold time and
  the file is `scaffold`, so promoting a slice later leaves its race tests skipped for ever. Worse than for
  GWTs: **codegen's report only inspects GWT test files, so nothing looks in `Concurrency/` at all.** The
  report should grow to cover them, or `architect.mjs check` should.
- **Six questions, four files.** `OrderCart` and `RemoveProduct` each have two contended invariants, and the
  file is named per *slice*, so the second question of each pair is reported `kept` and its rule never
  appears in any header. Not wrong — one file per slice is the right shape — but the scaffold's
  `THE CONTENDED INVARIANT:` line then documents only one of the two rules it is responsible for.

### W8 — nothing in the kit's own suite ever builds generated code · **GAP**

W6 is a generated project that did not compile, found by a human running `dotnet build`. Nothing would
have caught it otherwise: `cart-replay.mjs` exercises `slice.mjs` and `model.mjs` and stops at the
`.drawio`; the reference implementations are committed C# that is never re-generated as part of a check.

So the kit has a regression suite for the *model* half and none for the *generator* half, and W6 is what
that costs — a bug fixed once, half-reverted, and shipped for however long it has been since. The cheapest
useful version is not a full harness: take one fixture model, run `codegen.mjs` into a temp folder, and
assert `dotnet build` returns 0. That alone would have caught it.

### W9 — codegen emits `fields=` types verbatim as C# types, and the kit's own fixture does not compile · **BROKEN** · ***FIXED***

Found by doing W8's proposed check by hand on a **second** model. `cart.drawio` — the kit's own
regression fixture, the model `cart-replay.mjs` builds and asserts byte-identical every run — generates
a project with **68 compile errors**:

```
$ node tools/codegen.mjs --project <tmp>
37 file(s) written, 0 kept
$ dotnet build
Contracts/Events.cs(11,34): error CS0246: The type or namespace name 'UUID' could not be found
  ... 67 more, all the same cause
```

**Cause.** `codegen.mjs` passes the type half of `fields="name:Type"` straight through as a C# type
name, with no validation anywhere in the pipeline. `model.mjs validate` does not check that a type is
real either — it checks name-matching and, for `mapping-crosses-types`, that two declared types agree
with each other. Nothing asks whether the type *exists*.

The fixture writes `aggregateId:UUID` because that is the book's vocabulary, quoted deliberately. It
survives every model-level check. `Double` in the same fixture is fine by accident — `System.Double` is
a real C# type — which is exactly the kind of near-miss that makes the failure look arbitrary.

**Why it stayed hidden: W8.** Nothing in the kit has ever built generated code, so "the fixture cannot
be generated from" was not a fact anything could observe. `cart-replay.mjs` asserts the fixture's
*model* is correct and stops there.

**Fixed, and the human's framing is what made it the right fix rather than a patch.** Three answers were on
the table and they are not equivalent:

- **`model.mjs` rejects an unknown type.** Strongest, and consistent with the kit's house rule of erroring
  by default — but it hard-codes a list of C# types into the model layer, which is meant to be
  stack-agnostic. It would also fail the fixture, so the book's vocabulary would have to be abandoned or
  the fixture re-baselined.
- **`codegen.mjs` maps aliases** (`UUID`→`Guid`, `Boolean`→`bool`, …). Keeps the model stack-agnostic and
  puts stack knowledge in the stack layer, where it belongs. Risk: a silent mapping is a silent
  assumption, and a typo (`Guidd`) still reaches the compiler.
- **`codegen.mjs` refuses and names the field.** Emits nothing and says
  `UNKNOWN TYPE — Item Added.aggregateId:UUID is not a C# type`. Consistent with how the generator already
  handles what it cannot decide, and the only option that cannot guess wrong.

**All three were wrong, and the human named why: the model must stay stack- and implementation-agnostic.**
`UUID` is not a mistake in the model — it is the *domain's* word for a universally unique id, and the model
is not entitled to know what a C# is. Rejecting it in `model.mjs` would put the stack inside the artifact
whose whole value is outliving the stack. Mapping it silently in `codegen.mjs` would make a decision nobody
reviewed. And the fixture is not wrong either, so re-baselining it would have destroyed evidence.

**The missing thing was a LAYER, and the kit already has one for exactly this: `architect`.** A domain type
becoming a C# type is a decision with a cost — `Double` or `decimal` for money is a rounding question
somebody has to own — and decisions with costs live in `ARCHITECTURE.md`. So:

- `tools/type-bindings.mjs` — the shared format, so architect and codegen cannot drift. It also holds the
  proposal table, which is stack knowledge and therefore correctly **not** in `model.mjs`.
- `architect.mjs` grows a seventh question family, `type-binding/<ctx>`, deriving every distinct scalar
  type (child group names excluded — codegen emits those records itself). `record` writes a fenced
  ```type-bindings``` block pre-filled for the unambiguous ones; anything with a real trade-off arrives as
  `TODO(architect)`.
- `codegen.mjs` reads the block instead of guessing, and reports **`UNBOUND TYPE`** by name before the
  build rather than letting it surface as CS0246.

Measured: the cart fixture went from **68 compile errors to 0 errors, 0 warnings**. With no
`ARCHITECTURE.md` at all it now prints `UNBOUND TYPE — 2` naming `UUID` and `Double` and where each is
first used, instead of failing mutely at the compiler.

**And the fix drew blood on the way in, which is worth recording.** The old `CS` table's entries were all
identities (`Guid -> Guid`), so two call sites read `CS[t]` *bare* and happened to work. With bindings
coming from a record that may legitimately be empty, a bare lookup returns `undefined` — which flipped
`allGuid` to false and silently re-keyed every stream from `Guid` to `string`: **0 warnings, 3 errors, and
nothing pointing at the cause.** Every lookup now goes through one `cs()` helper. A lookup table of
identities is indistinguishable from no lookup table at all until the day it stops being one.

### W10 — `reflow` grows the GWT lane straight past a journey bar and strands it among the rules · **BROKEN** · ***FIXED***

Found by rendering the demo-cut model and looking at it. The journey bar sat **on top of** a GWT cell,
on a model validating at 0 errors and 0 warnings.

**Cause, and it is a plain ordering bug.** `slice.mjs journey` places the bar at the GWT lane's bottom
`+ 40`, which is correct at the instant it runs. But the lane is *sized from its lowest GWT cell*, and
GWTs keep arriving — the template lane is 440px tall while six rules at the documented 140 pitch reach
850. So `reflow` grew the lane from 440 to 1050 and **left the bar where it was**, now 570px inside the
rules. Measured: lane bottom 2290, lowest GWT 2270, journey bar at 1720.

It needs only a journey plus more than about three rules per slice, which is not an unusual model —
the kit's guidance is *"ten or more per slice is normal"*.

**Fixed** in `cmdReflow`: it now computes the lane's *new* bottom and re-seats every `em="journey"` bar
below it, preserving order and 20px stacking, and grows the page to cover them. Verified: bar moved
1720 → 2330, below both the lane bottom and the lowest rule; model still 0/0; `cart-replay` still
byte-identical (that fixture has no journey, so the path is inert there — which is also why nothing
caught this).

**Two things worth keeping from how it was found.** It is invisible in XML and obvious in the PNG,
which is the standing "always render and look" rule earning its keep again. And while patching it I
briefly shipped the *report* without the *move* — reflow printed `1 journey bar(s) re-seated` while the
bar had not moved. A plan line that is written before the edit it describes is a lie waiting to happen;
both now come from the same `moveJourney` map.

### W11 — every contact sheet `design.mjs` has ever produced was a grid of broken image icons · **BROKEN** · ***FIXED***

The artifact CLAUDE.md calls *"the one for **looking**"* — *"every screen at 1:1 in one image"* — contained no
screens. It rendered the caption, the border and a broken-image glyph, deterministically, in every run since
the tool was written.

**Cause.** `design.mjs` writes the sheet markup to `_shots/_sheet-<w>.html`, right beside the PNGs, and then
**throws that file away and shoots a copy of its text**: `captureHtml()` writes the markup into `tmpdir()`
and screenshots from there. The sheet's entire content is `<img src="recipes-desktop.png">` — relative — so
every image resolved against `%TEMP%`, where the shots are not.

`review.mjs` builds the same kind of sheet through the same helper and is **fine**, which is what made this
confusing: it happens to emit `fileUrl(c.path)` absolute srcs. One of the two siblings dodged the trap
without either of them naming it.

**Why nothing caught it.** Chrome renders the broken glyph and **exits 0**. The PNG is produced, it is a
plausible size, `existsSync(out)` is true, the tool reports success and prints `look at this: …`. Every
automated signal is green; the only detector is a human opening the image. It also survived because the two
things that would have exposed it are the same thing — the individual shots are correct, so anyone spot-
checking a screen sees a correct picture and never opens the sheet.

**Fixed** by shooting the file it already wrote: `capture({ url: sp, … })`. No absolute machine paths get
baked into a portable artifact, and it has a second benefit — `_sheet-<w>.html` stops being a write-only
file nobody validates and becomes the thing actually rendered, so if it is ever wrong the sheet is visibly
wrong too. Verified: desktop sheet 14,145 → 32,689 bytes, and the screen is in it.

**The class, guarded rather than just the instance.** `captureHtml` now documents that relative
subresources silently fail there, and points at the two correct answers (absolute `fileUrl`, or write the
file beside its assets and use `capture`). It is a genuinely hazardous helper: any future caller with an
`<img>`, `<link>` or `<script>` in its markup gets a green run and a wrong picture.

---

## X. Determinism across independent runs, and across model tiers (CPOC03 / CPOC04 / CPOC05, 2026-08-07)

**The question.** The emit/scaffold split rests on a claim: *"anything mechanically determined is
overwritten"* — i.e. the generator's output for a fixed model is reproducible, and only the hand-filled
half varies. That claim had never been tested against a second, independent run. A second question rode
along with it, because the walkthrough above was entirely Claude Opus 5, orchestrator and both subagents:
**does the model tier change any of this?**

**The design.** One brief (`demo/00-recipe-list.md`, the trivial one-screen recipe box: one state-view
slice, one state-change slice, one journey), run through the full chain **three times**, into three
sibling projects living beside each other exactly as `CPOC03`/`04` do:

| Run | Project | Orchestrator | Backend + frontend agents | What was reused from the previous run |
| --- | --- | --- | --- | --- |
| 1 | CPOC03 | Opus 5 | Opus 5 | — (first run) |
| 2 | CPOC04 | Opus 5 | Opus 5 | model, `ARCHITECTURE.md`, `designs/recipes.html` — copied verbatim |
| 3 | CPOC05 | Sonnet 5 | Sonnet 5 (forced via the `Agent` tool's `model` param) | **nothing** — model, architecture answers, design and journey all re-derived from the brief, independently |

Run 3 is the load-bearing one methodologically: reusing run 1's artifacts would measure Opus and label it
Sonnet. Run 2 exists to separate "ran twice" noise from "ran on a different tier" before drawing any
tier conclusion from run 3.

### X1 — the generator is unconditionally deterministic, independent of model tier · **MEASURED, HELD**

Every file `codegen.mjs` marks `<auto-generated>` (never overwritten by an agent) was **byte-identical**
across all three runs: `RecipeBox.slnx`, `Contracts/Events.cs`, `Program.cs`, both `.csproj`, the command
record, `AppFixture.cs`, `IntegrationContext.cs` — 8/8 diffed clean between run 1 (Opus) and run 3 (Sonnet),
which never shared a single upstream artifact. This is the strongest form of the emit/scaffold claim: not
"the generator is idempotent on re-run" (already proven by `cart-replay.mjs`) but **"the generator is
deterministic across independent invocations on independent machines' worth of LLM output feeding it."**
The generator reads the compiled IR and nothing else; two structurally-identical IRs produce byte-identical
emit output, full stop.

### X2 — the MODEL itself converges on every domain fact, independent of who draws it or which tier drew it · **MEASURED, HELD**

Run 3's `.drawio` was not copied from run 1 — it was re-derived from the brief by an independent reading,
written in fresh prose (different labels, different GWT wording, different notes). Despite that, every
domain-fact attribute hashed identical across the two files: `fields=`, `identity=`, `aggregate=`,
`enforce=`, `terminal=`, `displays=`, `inputs=`. Only prose (`label=`, GWT rule text, `note=`) differed —
which is exactly the boundary the kit draws between a domain fact (never invented, always derivable from
the brief) and layout/wording (free to vary). A brief with a genuinely fixed answer to every field question
produces a genuinely fixed model, regardless of who — or what tier — reads it.

### X3 — the architecture decisions converged three times, independently, with no coordination · **MEASURED, HELD**

All three runs — two Opus, one Sonnet, none seeing another's answer — landed on the identical technical
shape for both slices:

| | run 1 (Opus) | run 2 (Opus) | run 3 (Sonnet) |
| --- | --- | --- | --- |
| view recipe | `SingleStreamProjection<Recipes,Guid>` | same | same |
| lifecycle | `Inline` | same | same |
| decider | `MartenOps.StartStream`, not `[Aggregate]`/`FetchForWriting` | same | same |
| contended invariants found | 0 (correctly — one event per stream, for ever) | same | same |
| GWT test scenario names | 6 | same 6 | same 6 (one reworded by the human facilitator, not the agent) |

This is not the generator being deterministic — it is three independent instances of judgement (backend
agent, twice on Opus and once on Sonnet) converging on the same answer because the brief and
`ARCHITECTURE.md` leave only one defensible answer once you take `[Aggregate]`'s composite-key limitation
and Marten's own single-stream-vs-multi-stream guidance seriously. The architecture-decisions-first
ordering (`scaffold → architect → codegen`) is what makes this possible: the decision that would otherwise
vary per slice was made once, in writing, and read rather than re-derived three times.

### X4 — where the runs DID diverge, and why none of the divergences is a defect · **NOISE, worth naming so nobody mistakes it for one**

**Response shape, and it is a visible progression rather than noise-plus-noise:**

| | shape chosen |
| --- | --- |
| run 1 | bespoke `record AddRecipeResponse(Guid RecipeId)` — no Wolverine convention used |
| run 2 | `record AddRecipeResponse(Guid RecipeId) : CreationResponse(Route)` — subclasses Wolverine's base |
| run 3 | `CreationResponse<Guid>` directly — no bespoke type, the most idiomatic form available |

Each is a legitimate reading of "return the minted id, get a 201 and a Location header." Run 2 and run 3
each read the mirror and moved closer to what `Wolverine.Http` actually offers; the improvement is not
tier-correlated (run 2 improving on run 1 was still Opus).

**Verbosity: Sonnet wrote consistently fewer lines for the same coverage.**

| file | run 1 (Opus) | run 2 (Opus) | run 3 (Sonnet) |
| --- | --- | --- | --- |
| `AddRecipeTests.cs` | 191 | 188 | 160 |
| `RecipeListTests.cs` | 134 | 115 | 118 |
| `Recipes.cs` (view fold) | 78 | 77 | 56 |
| `GenesisData.cs` | 74 | 61 | 49 |

All three pass the identical 10-test suite (9 GWTs/GTs + 1 journey). The gap is doc-comment density, not
missing assertions — confirmed by reading, not just counting lines.

**Iteration count: the one place tier showed up as cost, and it is small.** Both Opus backend runs went
green on the first `dotnet build`. Sonnet's backend needed one fix cycle — a missing `using` directive,
caught by its own build step before reporting done, not by the orchestrator. One data point; not enough to
generalise from, recorded because it is the only place in this experiment where the tiers actually differed
in outcome rather than in wording.

### X5 — wall clock: no tier effect at this size · **MEASURED**

| step | run 1 (Opus, cold) | run 2 (Opus, warm) | run 3 (Sonnet, cold) |
| --- | --- | --- | --- |
| event-model | 0m 52s | 0m 41s | 1m 33s |
| scaffold | 0m 17s | 0m 23s | 0m 33s |
| architect | 1m 35s | 1m 11s | 1m 19s |
| styling | 3m 38s | (reused) | 0m 47s |
| codegen — backend agent | 14m 50s | 13m 27s | 12m 22s |
| codegen — frontend agent | 11m 10s | 8m 21s | 9m 54s |
| journey | 1m 54s | 4m 20s | 1m 31s |
| **total** | **34m 16s** | **28m 23s** | **27m 59s** |

Run 2 and run 3 land within 24 seconds of each other, both faster than run 1 — and run 2 is Opus. Comparing
only the two genuinely cold runs (1 and 3, since run 2 reused artifacts run 3 could not), Opus's two agents
took 26m 00s combined against Sonnet's 22m 16s. At this brief's size that gap is well inside the variance
already visible between run 1 and run 2 on the *same* tier, so it should not be read as "Sonnet is faster" —
only as "Sonnet was not slower here," which was the open question worth closing.

### What this licenses saying, and what it does not

**Licensed:** the generator's determinism claim in CLAUDE.md ("the generator's diff is how a model change
gets reviewed") is not aspirational — it held across two independent LLM-driven runs on two model tiers with
zero shared state. The architecture-decisions-first ordering does what it is designed to do: it turns a
per-slice judgement call into a system-wide fact that gets read identically rather than re-litigated.

**Not licensed:** a general claim that "Sonnet is as good as Opus for this kit." Three runs of one
demo-sized, two-slice, zero-ambiguity brief is a smoke test, not a benchmark — every rejection in this
model is a periphery rule and there is exactly one contended-invariant question in the whole system
(answered "there are none"). A model with real cross-stream rules, several race conditions, and six-recipe
read-side choices with a wrong answer available has not been run on both tiers. If that comparison is
wanted, it needs a brief sized like `reference-implementations/state-view/campaigns/` or the real
co-working desk-booking brief, not this one.

---

## Y. What the books permit ON the model, and the one gap that exposed (2026-08-07)

**The question, from the human:** do either of the books allow annotations the kit currently forbids —
RBAC, HTTP endpoints, and similar metadata? Asked because run 3 (section X) showed the HTTP response
shape varying across runs, and *"add a notation for it"* is the obvious-looking fix.

**Method.** Both books are on disk and extracted to greppable text under `reference/` (gitignored —
they are purchased): `eventmodeling-and-eventsourcing.txt` (Dilger, ~547 kB) and
`the-little-eventmodeling-book.txt` (~36 kB). Searched both for the security, transport and
metadata vocabulary, then read every hit in context rather than counting.

### Y1 — RBAC, HTTP endpoints and NFRs are explicitly NOT model content · **CONFIRMED, kit already aligned**

Dilger devotes **chapter 40, *Handling Security*,** to precisely this question and answers it outright:

> *"how do we specify that the technical role 'admin' is necessary to block a customer? **Short answer:
> Typically I don't. That's an implementation detail.** The required role can change without affecting
> the overall flow."*

and gives the reason, which is this kit's standing rule in the author's own words:

> *"Adding 'implementation hints' to the model may seem useful during development, but **the more
> implementation details you include, the harder it becomes to focus on the essential information.**"*

He splits the concept rather than banning it: **business roles are modelled** (via actor lanes, Y2),
**technical roles are not** — *"I typically don't include technical roles in the Event Model at all — a
decision that initially surprises many developers."*

Transport is not model content either. Measured across the whole book: `endpoint` **4 hits, every one in
Part III** (implementation — API wrapper functions, SSE, polling), `route` **0**, `URL` **1**. The
modelling half never mentions them.

Neither book has non-functional requirements: case-sensitively, `NFR` **0** and `Non-Functional` **0** in
both. (A case-insensitive search appears to find them — it is matching i**nfr**astructure. Recorded
because it will mislead the next person who greps.)

The little book says **nothing whatsoever** about security or roles; its only `permission` hits are the
copyright page.

**Consequence for the kit: the run-3 response-shape variance cannot be fixed with notation, and should
not be.** It stays an `ARCHITECTURE.md` question — which is exactly where X4 left it. This finding is
worth recording precisely because it is a *negative* result that will otherwise be re-researched.

### Y2 — actor lanes are book-sanctioned and the kit has none · **GAP**

Prompted by the human recalling that the shopping-cart walkthrough *"failed to draw the upper aka actor
swimlanes"*, and that the run called that step the Conway phase.

**The recollection is correct, and nothing malfunctioned — there is no such notation to draw.** Verified:
`em="actor"` does not exist anywhere in `tools/`. The kit has exactly four lanes, all fixed and all about
*layer* (`lane-ui`, `lane-cmd`, `lane-evt`, `lane-gwt`), plus swimlanes inside the event lane for stream
boundaries.

**The confusion is worth naming, because the phase name invites it.** There are two different "who"
questions and the kit answers only one:

| | the question | book | kit |
| --- | --- | --- | --- |
| Conway / `owner=` | who **builds** this slice | ch. 43 | ✅ — and repurposed: CLAUDE.md says *"`owner` is the **agent** that generates the slice, not a human team"* |
| **actor lane** | who **uses** this screen | ch. 40 | ❌ absent |

Dilger: *"Using actor lanes, we clearly show which actor is responsible for a specific screen or action
in the system."* He also keeps `swimlane` strictly for streams — *"Swimlanes define stream boundaries"* —
so actor lanes are a **third** lane concept, not a renaming of either thing the kit has.

**Cost so far: none, and that is not luck.** Every model built to date — the cart, the recipe box — has
exactly **one** actor. The book reaches for actor lanes only to *separate* flows (*"Whenever possible, I
model flows from the perspective of a single actor"*), and with one actor there is nothing to separate.
It becomes live at two, which is the next brief: `demo/03-coworking-desk-booking.md` has a **member** and
an **office manager**, and parks *"should the office manager be able to book on a member's behalf?"* as an
open question — Dilger's clerk-vs-admin case almost exactly.

### Y3 — the unconnected "Logged-In User" read model, which is the other half of the same gap · **GAP**

The kit can already say a value arrives from the authenticated principal — `terminal="closedBy:actor"`,
one of four terminal kinds. But it is reported at **`severity: "info"`** and nothing can check it;
CLAUDE.md concedes as much: *"'the handler supplies this' is a claim worth a reader disagreeing with."*

The book's answer is a specific device, and it is the one read model that is deliberately sourceless:

> *"This read model differs from others in that it isn't connected to any events or event streams. Its
> primary purpose is simply to signal that the logged-in user is available from this point onward."*

paired with worked example data — *"the username from the Login is used as the clerkId in the command"* —
which is the same "example on the GWT pins what the notation cannot say" move the kit already makes for
`derived=`.

**So Y2 and Y3 are one gap, not two: the kit can say a value comes from the actor, but cannot say who the
actor is, or where they came from.** Note the completeness check would currently flag such a read model as
unsourced, so adopting this needs a rule change and not just a cell — do not treat it as free.

Dilger also keeps the login flow itself **out** of the system's model: *"Since this is purely a technical
flow meant for discussion, and not part of the system's Event Model, I typically keep it in a separate
model."* That is compatible with the kit's one-context-per-file rule as it stands.

### Y4 — three further devices the books use, for the record

- **Dotted backlinks.** *"If only the data is affected and not the flow itself, I prefer... a dotted arrow
  from the event pointing back to the affected Read Model... The dotted line indicates that this
  connection does not impact the modeled flow itself but only affects the data in the Read Model."* The
  kit has the `Event → View` backward exception but draws it identically to a forward feed, so it loses
  the distinction the dotted line carries.
- **Chapters / sub-chapters** (blue arrows, two layers, above the model). CLAUDE.md already records these
  as deliberately not built in favour of splitting — that remains defensible and is now cited.
- **Alternative-flow markers** — a sticky below a slice linking to a separate model on the board. The kit
  achieves the same end with `<model>.<flow>.drawio` and the context map.

### The standing caveat on all of Y2–Y4

Dilger closes chapter 18 by disclaiming authority for exactly these devices:

> *"The tools discussed in this chapter are **not part of the original Event Modeling definition**.
> Instead, they can be seen as practical 'extensions' to an Event Model... I didn't create these
> notations but rather selected what worked best for me."*

So chapters, model-context stickies, alternative-flow markers and backlinks are **his** additions. That is
precedent for the kit adding its own — it is **not** authority requiring the kit to adopt his. Y1 is
different in kind and should be treated as binding: it is a direct statement about what does not belong on
a model, not a proposed extension.

### Y5 — "swimlane" means three different things across the sources, and the kit implements one · **WRONG** · *supersedes Y2's sourcing*

Researched online after the human pointed out that the desk-booking run still had no actor lanes, and
asked for the primary sources rather than the books alone. **Y2 attributed actor lanes to Dilger ch. 40.
That is not where they come from, and the weaker citation understated the case.**

The canonical definition — Adam Dymitruk, *What is Event Modeling?*, the article Dilger himself footnotes
— uses the word **twice, in two different sections, for two different things**:

| | Where | Over what | Means |
| --- | --- | --- | --- |
| **§3 "The Story Board"** | **top**, the wireframe row | wireframes | **ACTORS.** *"The wireframes are generally put at the top of the blueprint. **They can be divided into separate swimlanes to show what each user sees if there is more than one.**"* |
| **§6 "Apply Conway's Law"** | bottom, the event row | events | **TEAMS.** *"Now that we know how information gets in and out of our system, we can start to look at organizing **the events themselves** into swimlanes."* |

And *Understanding EventSourcing* ch. 7 gives the event-row band a **third** meaning: *"Swimlanes define
stream boundaries. Typically, all events in one swimlane end up in a physical stream."*

**What the kit built.** Its swimlanes sit over the events — §6's *position* — carrying Dilger's *meaning*
(stream boundaries) plus `owner=` for §6's *meaning* (Conway/teams). Those two are fused into one band,
which is defensible and is documented. **What it has none of is §3: the actor lanes at the top.**

**So the human's phrase — "the conway idea, so the upper swimlanes for actors" — is not a confusion, it is
an accurate reading of a genuinely overloaded term.** §6 is literally titled *Apply Conway's Law* and is
about swimlanes; §3's swimlanes are the upper ones and are about actors. The two sit four sections apart in
one document and share a word.

**Corroborated in the community, with a worked three-actor example.** Dymitruk again: *"Wireframes or web
page mockups across the top. These can be organized in swim-lanes to show **different people (or sometimes
systems)** interacting with our system."* A published example models a fundraising order across three
lanes — Funder, Fundraising Manager, Checkin Clerk — stating *"When there are multiple actors in the story,
I use a swimlane for each type of person taking part, and for each role wireframes or mockups are drawn."*

**Two consequences the run should carry:**

- **Actor lanes divide the WIREFRAME ROW ONLY.** §3 places them there and the article never extends them
  below it; §3.1 separately forbids stacked screens. So an actor lane is a subdivision of the kit's
  `lane-ui`, not a new full-height band — which is also the only reading that does not collide with the
  stream bands already sitting in `lane-evt`.
- **An actor may be a SYSTEM, not just a person** — *"or sometimes systems"*. The cart model's warehouse
  and the desk-booking office manager are both actors in this sense, so the notation should not assume a
  human.

**This raises the priority rather than changing the answer.** Y2 called actor lanes "book-sanctioned"; they
are in fact part of the **original definition of the method**, present since 2019 and absent from this kit —
which makes them the oldest unimplemented thing in the grammar, not a Dilger extension the kit may take or
leave. The standing caveat above does **not** apply to them.

Sources: [What is Event Modeling?](https://eventmodeling.org/posts/what-is-event-modeling/) ·
[Event Modeling Cheat Sheet](https://eventmodeling.org/posts/event-modeling-cheatsheet/) (blocks and
patterns only — no lanes, no actors) ·
[What is Event Modeling? (with example)](https://www.goeleven.com/blog/event-modeling/)

---

## Z. Findings — the desk-booking run (CPOC03, 2026-08-08)

The first model with a **composite stream key**, three aggregates, real contended invariants and
multi-stream views — chosen per section X because the recipe-box brief could not distinguish
"the kit is robust" from "the brief was trivial". It found three things in the modelling half alone.

### Z1 — same aggregate is not the same stream, and the misclassification asks for a race test that proves nothing · **BROKEN** · ***FIXED***

`architect.mjs` classified *"a member may hold at most 3 upcoming bookings"* as a
**`contended-invariant`**, describing it as *"a rejection that depends on state in Booking — **the same
stream** the command appends to, keyed by (deskId, date)"*.

It is not the same stream. The GIVEN is three `Desk Booked` events in three **different** `(deskId, date)`
streams; the command appends to a **fourth**. Same aggregate, four stream instances.

**Cause.** The split between `contended-invariant` and `cross-stream-rule` compared **aggregate names** —
`givenAggs.filter((a) => !writes.includes(a))`. That was sound while every stream key was a single field
equal to the aggregate's identity, so aggregate and stream instance were the same thing. `identity="deskId,
date"` breaks the equivalence: one aggregate now spans a stream per desk per day.

**Why it is BROKEN rather than untidy — the failure is a false sense of proof.** The contended-invariant
branch instructs you to *"WRITE THE RACE TEST that proves optimistic concurrency refuses the loser"*, and
that race test **would pass**: racing two bookings of the *same* desk-day genuinely does refuse one. Meanwhile
the rule actually at risk — two callers booking a member's 4th and 5th desk on *different* days at the same
instant — both succeed, is never raced, and now carries a green test as evidence that it was checked.

**Fixed, using what the model already carries.** A GWT's example data names the stream key on both sides, so
where every `identity=` field appears in the WHEN and in a GIVEN step, the keys are compared: differ ⇒
cross-stream. The kit's own doctrine is that *"an example specifies the how well enough to VERIFY"*, and this
is that principle paying for itself. Guarded to `key.length > 1` and to steps that actually carry examples —
a single-field key cannot hit it and a model without example data keeps the old behaviour, so the cart
fixture and both recipe-box models are provably untouched (re-checked: recipe box still 3 questions, cart
still 4 write-side).

The message now names the keys rather than reading `appends to Booking but the GIVEN lives in Booking`:
`(deskId, date) = ($Window3 2026-09-01) vs ($Quiet1 2026-09-04)`.

**The general lesson, and it is the reason this run was worth doing:** every prior model keyed a stream by a
single field, so an entire class of reasoning had never been exercised. The bug was not introduced — it was
*revealed*, and it had been latent since `architect.mjs` was written.

### Z2 — a child group's fields were invisible to GWT example checking · **BROKEN** · ***FIXED***

`Day Bookings(deskLabel=Window 3)` was rejected with *"Day Bookings declares no deskLabel"* — but it does,
inside its `children="DayBookingLine: deskId, deskLabel, memberId, memberName"` group.

**Cause.** `gwt-example-unknown-field` resolved against `el.fields` only. Everywhere else flattens children —
CLAUDE.md promises *"the group is transparent to the completeness check in both directions"*, and `mappings=`,
`derived=` and `mapping-crosses-types` all work on the flattened names. This was the one rule that did not,
so **a view with a child group could not be given example data at all** — and a multi-stream view with lines
inside its row is exactly the shape that most needs a worked example.

**Fixed** by applying the same flattening the completeness check uses. A **false positive**, which the house
rule ranks as worse than a missing check.

### Z3 — a screen and a read model sharing a label resolve to whichever comes first · **NOISE**

Naming the desk catalogue view `Desks` while the admin screen was also `Desks` produced three
`gwt-example-unknown-field` errors plus three `gwt-unknown-event` errors, because `all(label)[0]` is neither
slice-scoped nor kind-filtered — the screen won, and a screen has no `fields`.

The root cause is a modelling mistake (two different things, one name) and renaming the view fixed it. But
`then=` is documented as resolving *"this slice first, then anywhere"*, and the example checker does not do
that — it takes the first global match. Worth tightening to prefer the same slice and then the expected kind;
not fixed here because the run had a correct answer available and the fix wants its own regression case.

### Z4 — a composite stream key was built culture-dependently · **BROKEN** · ***FIXED***

The first model with `identity="deskId, date"` reached a branch no earlier model could.
`tools/codegen.mjs` emitted the key by plain interpolation — `$"booking:{deskId}:{date}"` — and
`DateOnly.ToString()` follows the machine's culture. Measured on the real runtime across five cultures:

| culture | naive render | with the fix |
| --- | --- | --- |
| invariant | `09/01/2026` | `2026-09-01` |
| hu-HU | `2026. 09. 01.` | `2026-09-01` |
| de-DE | `01.09.2026` | `2026-09-01` |
| th-TH | `1/9/2569` | `2026-09-01` |
| ar-SA | Arabic-Indic digits, Hijri | `2026-09-01` |

**Two hosts would compose two different streams for one desk-day**, and the "one member per desk per day"
invariant — the entire reason the key is composite — would stop holding, with no error anywhere. A
`decimal` key part swaps its separator the same way, and a `TimeOnly` additionally *loses its seconds*.

**Fixed** with `string.Create(CultureInfo.InvariantCulture, …)` plus an explicit round-trippable format for
date-shaped parts, and the `using System.Globalization;` added only when the key is composite. Verified
across all five cultures; the regenerated skeleton still builds 0/0. Single-field keys never interpolate
and are untouched.

### Z5 — two labels that PascalCase to one identifier: one is silently dropped, and reported as `kept` · **BROKEN** · *not fixed*

Found by `kit-test` on its first ever run. `scaffold()` guards with `existsSync(p)`, so **"left over from a
previous run" and "written twice in this run" are indistinguishable**:

```
$ node tools/codegen.mjs --project $T        # FIRST run, into an EMPTY directory
33 file(s) written, 2 kept (already filled in)
  ... 4 views
$ ls generated/Drafting/src/Drafting/Views/
DraftHistory.cs  MyDrafts.cs  ViewRegistrations.cs      # 4 views claimed, 2 files exist
$ dotnet build   ->  0 Warning(s)  0 Error(s)
```

Two views gone, build green, and the message is the worst available: **`kept (already filled in)` on a
first run into an empty directory** asserts "you already filled these in" when it means "I discarded a
different view". Which definition survives is decided by alphabetical filename order.

**The trigger needs no punctuation.** CLAUDE.md endorses the exact shape — *"if two contexts need the same
projection, each builds its own"* — so two models in one system, each with a `MyDrafts`, is enough.

**Cause, two places.** `codegen.mjs`'s `scaffold()` asks the filesystem instead of tracking what this run
wrote. And `model.mjs`'s `system/event-shape-disagrees`, which is exactly the right check and whose own
comment says *"a generator picking whichever cell it met first would emit a type that is wrong for the
other"*, filters to `kind === "event" || "external"` — **read models are excluded**. Events are protected,
commands fail loudly at CS0101; the read model is the only kind that is both one-file-per-name and written
through `scaffold()`, so it is the only one whose collision is silent.

**Not fixed here, deliberately.** It is two one-line changes — track paths written this run, and drop the
`kind` filter — but it needs its own regression fixture, and four tools had already changed in this run.
**Still unproven: the same collision on automations and on slice validators.**

### Z6 — `scaffold → architect → scaffold` leaves a project that does not build · **WRONG** · ***DOCS FIXED***

CLAUDE.md claimed — in text written the same day — that re-running scaffold after architect was safe
because *"everything depending on them is `emit`, and a second run overwrites cleanly."* **That is false:
views, aggregate folds and GWT tests are all `scaffold`**, so they are KEPT with the unbound type baked in.
Measured on the cart fixture:

| | |
| --- | --- |
| pass 1, no bindings | `UNBOUND TYPE — 2`, then **68** `CS0246` |
| record bindings, pass 2 | **no report at all**, and still **20** `CS0246` inside kept view files |
| bindings recorded **before** the first scaffold | **0 errors, 0 warnings** |

The report goes silent exactly while it is still true — the pre-W9 situation the W9 fix was written to end.

**Corrected in the docs rather than the code:** `architect` is really two steps sitting on opposite sides of
`scaffold`. `record` needs only the model and must go first; `tests` needs the test project and follows.
Both CLAUDE.md and the `scaffold` skill now say so, and `UNBOUND TYPE` is documented as **always** a defect
requiring an empty `generated/`, never something to re-run over the top.

### Z7 — smaller things `kit-test` found, recorded not fixed

- **The mobile contact sheet is sized for six columns regardless of screen count** · *NOISE*. `design.mjs`
  fits height to content but not width, so one screen yields a 2508px sheet that is ~85% white space — and
  a viewer scaling it to fit makes the screen tiny, the exact failure the sheet exists to prevent. One-line
  fix identified, not applied.
- **`model.mjs mark` and `crop.mjs` write LF lines into CRLF files** · *NOISE*. `mark` → `clear` still
  round-trips byte-identical, so it is cosmetic, but a marked file's diff shows the markers as LF.
- **A `children=` collection field cannot carry example data** · *GAP*. `DraftHistory(revisions=1)` is
  rejected, so a GT whose whole point is *"shows a row with 0 revisions"* cannot state that as checked
  data — the "prose in a label is not checked" problem `derived-without-example` exists to solve.
- **No fixture in the kit has a composite stream key** · *GAP*. The Z4 branch, and the whole
  `[Aggregate]`-does-not-fit section of CLAUDE.md, have no regression coverage. CPOC03 depends on both and
  nothing the kit owns would notice if either broke.
- **`model.mjs` accepts a duplicate XML attribute** with last-wins, which real XML forbids. Plain `Edit` on
  the XML is the kit's documented default path, so a cheap check may be worth it.

### What this run demonstrated that no earlier one could

Recorded because section X could not distinguish *"the kit is robust"* from *"the brief was trivial"*.

- **The first passing race test in the kit's history — and it was mutation-checked.** Keyed per booking
  instead of per desk-day, `ExactlyOneWriterWins` reports `Won=10`: ten winners for one desk-day. What the
  test has teeth about is the **modelling** decision `identity="deskId, date"`, not a Marten setting.
- **The first `Async` views, async daemon and `WaitForNonStaleProjectionDataAsync`** — plus a consequence
  the kit's guidance does not mention: an `Async` view read by a **decider** means a **GIVEN** needs a
  daemon wait too, not only a THEN. Without it the endpoint counts zero and returns success, which reads
  exactly like a missing rule.
- **The first composite stream key**, which forced `StreamIdentity.AsString` system-wide and surfaced Z4.
- **A race test can pass vacuously.** The first HTTP race used a hard-coded date that had drifted outside
  the 30-day window, so all ten callers were refused by the *validator*: "at most one success" and "no 5xx"
  were both true and both meaningless. Only asserting the rule **name** caught it.
- **The model's absolute example dates age out.** `TooFarInAdvance` is measured from now, so
  `AFreeDeskCanBeBookedForADay` starts failing on 2026-09-01 with `DateInThePast` — reading like a broken
  validator rather than a stale example. Left as-is: relative dates would stop testing the values the model
  states. The fix is the model's, and the notation cannot yet say "N days from now".

---

## AC. Actor lanes, built (2026-08-08) — closes Y2/Y3/Y5

**What was missing**, per Y5: the original 2019 definition divides the wireframe row into a swimlane per
actor, and the kit had no notation for it. Not a Dilger extension the kit could take or leave — part of
the method as first defined, and the oldest unimplemented thing in the grammar.

### The design, and why every piece of it is a copy

The kit already had the answer in a working, tested form: **an event's y IS its stream**. Actor lanes are
that mechanism applied to the other end of the model, so almost nothing here is new invention.

| | Actor lanes | Copied from |
| --- | --- | --- |
| `actor=` makes a band an actor lane | `streams=` makes one a swimlane | same discriminator shape |
| excluded from `lanes` in both parsers | swimlanes are, for the same reason | `laneOf()` takes the first containing match, so a band authored as an object is found ahead of the lane containing it |
| a screen's y IS its actor | an event's y IS its stream | derived from geometry, never declared twice |
| `--actor` on `add` | `--aggregate` on `add` | the user supplies the domain fact, the tool the geometry |
| band insert **before** the elements | swimlane insert | mxGraph paints in document order and a band is opaque, so a band written last hides everything in it — silently, with the model still at 0 errors |
| the downward cascade | `cmdSwimlane` | growing a lane shifts every cell, every routing point and every slice cell below it |

**Three decisions that are the kit's own, and the reasons:**

- **Actor lanes subdivide the UI lane only.** §3 puts them there and never extends them below, and it is
  the only reading that does not collide with the stream bands inside the event lane.
- **The first lane is placed to CONTAIN the screens already drawn.** `add` puts a screen at `uiY + 40`,
  so a band at `uiY + 25` of height `20 + 300 + 20` swallows it. Adopting an existing single-actor model
  therefore costs zero cell moves — you draw one lane and everything is already inside it.
- **`actorKind` is `person` or `system`, and nothing else.** *"different people (or sometimes systems)"*.
  It is deliberately **not** a role: roles are the thing ch. 40 refuses outright, and a free-text kind
  would become one within a week.

### Opt-in, which is the whole safety argument

A model with no actor lanes gets **no findings at all** — the same treatment wireframes get. Verified
after the change: all four reference implementations, the cart fixture, and the desk-booking model all
report byte-identically what they reported before, `cart-replay.mjs` is still `OK` and byte-identical,
and no committed fixture moved.

### The four rules, each mutation-checked

A rule that cannot fail proves nothing, so each was made to fire and then made to stop:

| probe | fired |
| --- | --- |
| move a screen outside every band | `actor/screen-outside-actor-lane` |
| put one `screen=` slug in two bands | `actor/screen-actor-disagrees` |
| add a band with no screens | `actor/actor-lane-empty` |
| set `actorKind="system"` | `actor/actor-is-a-system` |
| control — unchanged model | *(nothing)* |

`screen-actor-disagrees` is the one that makes the notation worth checking rather than merely drawing:
it enforces *"instead of merging these flows into a single screen, I clearly separate them"* — if two
people need the page, that is two screens.

### Exercised on a three-actor model

`ConwayTest/diagrams/expense-claims.drawio` — Employee, Approver, Finance Officer, one claim moving
between them, 7 slices, **0 errors 0 warnings**. Built entirely through `actorlane` and `add --actor`,
rendered and looked at: three named bands, each screen in its owner's lane.

Two things the run confirmed beyond the notation itself:
- **`add` refuses to guess.** With three lanes drawn and no `--actor`, it dies with *"this model has 3
  actor lanes, so --actor is required: who uses this screen?"* — the same discipline `--aggregate`
  already has.
- **The identity rule stayed domain.** *"An approver may not approve their own claim"* is a GWT with
  `enforce="aggregate"`, and the screen displays `employeeId` because that rule needs it. No role, no
  permission, no technical anything reached the model — which was the other half of the test.

### Second pass — deriving from the lanes rather than only checking them

A lane that is merely drawn is worth little; what makes it earn its place is what the model can now
*derive*. Two additions:

**`slices[].actors` — who uses this slice**, read off the band each screen sits in, never declared twice.
Exactly how `aggregate` is derived, and deliberately **empty for a slice with no screen**: a View or an
Automation has no actor by construction, which is an answer rather than a gap. On expense-claims:

```
  approve-claim       Approver          my-claims           — (no screen)
  reject-claim        Approver          claims-to-approve   — (no screen)
  submit-claim        Employee          claims-to-pay       — (no screen)
  pay-claim           Finance Officer
```

**`slice-crosses-actors` — an ERROR, and deliberately harsher than its Conway twin.**
`slice-crosses-teams` is a *warning* with an acknowledged form (`owners=`), because the book says a team
split is often unavoidable and only asks you to say so. A slice crossing two *actors* is different: a
slice is *"the smallest possible work that can be handed to a developer"*, and one needing two different
people at two different screens is not one slice. So there is no escape hatch — the fix is to split it.

**`journey-crosses-actors` — a note, and the one thing the wireframes alone cannot say.** On
expense-claims it reads:

> `journey "claim-to-payment" passes through 3 actors: Employee -> Approver -> Finance Officer. That is a
> handover, and the thing most worth walking end to end.`

Which is precisely what §3's lanes exist to make visible, now stated by the model rather than inferred by
a reader.

**Both new rules mutation-checked, and the check found something worth keeping.** Dragging one
`approvals` cell into another lane fires `screen-actor-disagrees` but **not** `slice-crosses-actors` —
a state-change slice has only one screen cell, so its actor list stays length 1. The rules are therefore
**not redundant**: `slice-crosses-actors` catches the one arrangement the other cannot, a slice with two
*differently-slugged* screens in two lanes, confirmed by constructing exactly that. A rule that could
never fire would have been dead weight, and this one can.

### Still open, and one deliberate "no"

- **codegen ignores actor lanes, and should keep ignoring them.** The IR carries them and nothing
  generates from them. Pushing an actor into generated code sits right on the RBAC line **Y1** says stays
  out; the correct split is *the model names who uses a screen, the stack decides who may*. Recorded as a
  decision rather than a gap.
- **`uijourney.mjs` does not know about actors**, though "which actor walks this journey" is exactly what
  a UI journey should state — and `journey-crosses-actors` now computes it, so the wiring is short.
- **No reference implementation has actor lanes**, so the notation has the same coverage gap Z7 records
  for composite keys: CPOC03/ConwayTest depend on it and nothing the kit owns would notice if it broke.

## AD. The kit assumes stream = consistency boundary, and Marten no longer requires that (POC001, 2026-08-08)

Raised by the user during phase 3 of the neighborhood-library run, against a model where lending sits on
the Copy stream and *"at most 5 active loans per member"* spans five of them. The kit's answer was
"then it is not an invariant, hand it to `architect`". That answer is **incomplete**, and the user was
right to push on it.

### AD1 — `reference/llms/marten/events/dcb.md` exists and the kit never mentions it · **GAP**

Marten ships **Dynamic Consistency Boundary**: strong-typed **tags** attached at append time,
`FetchForWritingByTags<T>(EventTagQuery)` loading a cross-stream boundary aggregate, and
`DcbConcurrencyException` at `SaveChangesAsync` when anything matching the same tag query landed since
the read. The serialization point is a version row per tag value with `UPDATE … WHERE version =
$captured`, and the docs are explicit that it *"works at PostgreSQL's default READ COMMITTED isolation;
no SERIALIZABLE, no advisory locks."* `[BoundaryAggregate]` marks an aggregate with **no stream identity
at all** — one that exists only as the projection of a tag query.

Measured against the kit: `CLAUDE.md` builds its architecture story on *"we apply optimistic locking on
individual event streams"*, `identity=` on a swimlane is presented as what decides which rules are real
invariants, and `architect.mjs`'s `cross-stream-rule` question describes the situation as one optimistic
concurrency *cannot* close. None of that is wrong about **streams**; all of it is incomplete about
**Marten**. By the standing rule — *where the kit and the critter-stack docs disagree, the docs win and
the kit is CHANGED* — this needs a decision, not a footnote.

**Not yet checked and required before anyone builds on it:** the mirror documents `DcbStorageMode.HStore`
as Marten 9 and `mt_dcb_tag_version` as a 9.4 schema object, while TagTables mode *"shipped in Marten 8"*.
The mirror has been ahead of a pinned version before (`WaitForExecutionOf`, section on the mirror not being
infallible). Check the pinned `Marten` version first.

### AD2 — and the prior question is whether DCB is even needed · **OPEN, and it is the one to answer first**

The user's position, recorded as the brief for that investigation: **DCB is not automatically the right
implementation.** Marten should be able to enforce a cross-stream rule of this shape with **multi-stream
aggregation**, and whether it can — and at what consistency guarantee — is the thing to establish before
the kit recommends anything.

What is already known and constrains the answer: `FetchForWriting` is **single-stream only**, and
`FetchLatest` is documented as read-only — for an `Async` projection it advances the aggregate in memory
past the daemon, so it is *current* but carries **no check at save time**. Current-but-unguarded is
precisely the race. So the investigation is not "is a multi-stream projection current enough" but
"**what supplies the guard**", and it must end in a measured answer against real Postgres, not a reading.

Deliberately **not** done in the modelling session that raised it. Recorded so the next session starts
from the facts rather than rediscovering them.

### AD3 — "closing the books" is model content and the kit has no notation for it · **GAP**

Same session, and this half belongs to modelling rather than to `architect`. `CLAUDE.md` already quotes
the book — *"better to limit the length of a stream naturally by understanding the business processes"*,
snapshots being *"the exception, not the rule"* — and `architect.mjs` folds stream growth into the
boundary map as a prompt. **But nothing in the grammar lets a model say where a stream's books close**,
and nothing checks a model that claims a stream is bounded while drawing events that recur on it for ever.

On this model it produced a real defect the checker could never see: a Loan stream was introduced *in
order to* keep the Copy stream short, and does not — the lending facts stay on the Copy stream and are
**duplicated** into the Loan stream by an automation, so nothing is shortened and one episode is recorded
twice. It validates, and it would generate.

### AD4 — `reflow` grows lanes and never shrinks them, so the width budget reads stale · **BROKEN** · *not fixed*

`cmdReflow` computes `wantLaneW = Math.max(m.grid.laneW, (lastCol - LANE_X) + EL_W + SLICE_PAD)` — the
`Math.max` against the *current* width means a model that loses its rightmost columns keeps the old lane
width and the old page width for ever. Measured on `POC001/diagrams/lending.drawio`: removing a swimlane
and two columns left content ending at x=2200 while the lanes stayed 2820 wide, and `reflow` reported
`page 2920 x 2055` with no drift line at all — the command whose stated job is *"recomputes lane widths,
page width and page height from content, and reports drift"* reporting none while 640px of drift existed.

It was not only cosmetic while the width budget existed: `buildIr` measures `width` as the max right edge
of **elements *and lanes*** (`model.mjs:454`), so the stale lane *was* the measured width, and
`model-too-wide` was checked against it — a model could be told to split purely because it once was wider.
**AD8 removed that rule**, so the consequence is now confined to a stale number on the summary line and a
band of empty canvas in the render. The bug is unchanged; only its blast radius shrank.

Worked around by hand here (set every lane's `width=` and the page width, then re-run `reflow`, which
then agrees). The fix is presumably to shrink as well as grow, but note that `Math.max` may be load-bearing
for a case not tested here — a lane holding something `lastCol` does not see — so this is recorded rather
than patched mid-session.

### AD5 — the View → Screen routing strip is placed under the UI LANE, not under the last ACTOR band · **BROKEN** · *not fixed*

With **two** actor lanes, every View → Screen edge is routed straight **through the second actor lane's
screens**. Seen in the render of `POC001/diagrams/lending.drawio`, confirmed by cropping x 2200–3000: a
horizontal run crosses both `Browse Books` cells in the Member band.

The cause is one line. `route` allocates the UI strip at `nextY(m, m.grid.uiY + 345, 8, …)` —
`slice.mjs:708` — a constant offset from the **UI lane's** top. `actorlane` meanwhile stacks bands from
`uiY + ACTOR_TOP` and grows the lane, and its own comment says `UI_STRIP_H` *"reserves the View -> Screen
routing strip that must stay below every band."* The reserve is made; the allocator ignores it. With one
band (185–465) the strip at 505 is genuinely below it, which is why five earlier runs never saw this. With
two, the second band is 475–755 and 505 is inside it.

Two parts to the fix, and the second is easy to miss:

1. Start the strip from the **last actor band's bottom**, not `uiY + 345`.
2. `UI_STRIP_H` is 45, which at the 8px pitch holds **five** runs. This model has **twelve** View → Screen
   edges — one per screen cell, and a screen slug repeated across five slices legitimately has five. The
   reserve has to scale with the number of view→screen edges, or the strip overflows into the Commands lane.

Invisible in XML, obvious in the PNG — the standing "always render and look" rule earning its keep again.

### AD6 — `mapping-crosses-types` fires on every rename between a screen and a command · **NOISE**

`BorrowCopy.copyId:Guid` mapped from a view field declared `nextAvailableCopyId:Guid` was reported as
*"mapped from nextAvailableCopyId:**string**"*. The mapping's source resolved to the **screen**, whose
`displays=` is a bare name list and carries no types, so the checker read the type as `string`.

That makes the rule structurally unable to pass at that boundary — and the command layer is exactly where a
rename is most legitimate, since a command's sources are *"the triggering screen's displays + inputs"*. The
likely fix is to prefer a typed source when the screen's attribute is itself supplied by a typed View.

Worked around by moving the rename one step later: the command carries `nextAvailableCopyId:Guid` and the
**event** declares `mappings="copyId=nextAvailableCopyId"`, whose source (the command) is typed. Silent.

### AD7 — `route` refuses a same-column View → Screen because of `SCREEN_X_NUDGE` · **BROKEN** · *not fixed*

A state-view slice whose screen sits in its **own** column cannot be routed: `route` reports
`flow/backward-connection`. The screen is placed at `x − SCREEN_X_NUDGE` (10px left, to centre a 200-wide
screen on a 180-wide column) while the view sits at `x`, so the view is 10px to the **right** of the screen
it feeds and the edge reads as pointing left.

It is not a modelling error — `Event(s) → View → Screen` is the whole state-view pattern, and a read-only
screen like `member-detail` has no command slice to its right to hold the screen instead. Five of five view
slices hit it here.

`add --pattern state-view` emits no screen placeholder, which is why the kit has never produced this
geometry itself and never seen the refusal. Worked around by moving those five views to the band's left edge
(`x − 20`). A proper fix compares column membership rather than raw x, or nudges the view left by default.

### AD8 — the width budget was an invented limit on a business decision · **WRONG** · ***REMOVED***

`model-too-wide` warned above `SIZE_BUDGET = 3200` px. Raised by the user on the neighborhood-library
model, which validated at 0 errors and one warning telling it to split at 3920px:

> *"Deciding whether a model is too big and should be split into multiple models is a thing driven by
> the business. Some business processes are long, nothing to do about it. A long business process is one
> model, you can't split that because of some arbitrary budget."*

That is right, and the rule **conflated a symptom with a cause**. The book's criterion is *"one business
context in each model"* — content. Width follows from content and is not a test of it. Splitting a long
process because its render got wide manufactures a context that is not a context, which is the opposite
of what ch. 18 asks for.

The decisive property: **no rule can distinguish "wide because this is one long story" from "wide because
two contexts were merged."** Only a human reading the model can. So the check could only ever guess, and
on any honest long process it guessed wrong — a structural false positive, against a standing bar that a
rule must never produce one. It also came with a **remedy** (*"split it, or move a chapter of slices into
their own model"*), so acting on it meant damaging a correct model.

Removed from `model.mjs`, with the reasoning left in place of the constant so it is not reintroduced.
`validate` still **prints** each model's width on its summary line — a number with no verdict attached is
information; the verdict was the wrong part.

**And `crop.mjs` is reclassified.** Five documents said *"if you need `crop.mjs`, the model is too big"*,
which made an inspection tool into evidence of a defect. A wide model can be perfectly correct, and
cropping is how you read a wide picture — the same way you scroll one.

Corrected in every place the claim lived, because a removed rule still argued for in prose is exactly how
this kit ends up disagreeing with itself: `tools/model.mjs`, `CLAUDE.md`, `README.md`,
`MODEL-ORGANIZATION.md`, `ANTI-PATTERNS.md` #8 (retitled — the anti-pattern is *more than one business
context*, and nothing detects it), `.claude/skills/event-model/SKILL.md`, `tools/slice.spec.md`,
`tools/fixtures/cart-replay.mjs` and `reference-implementations/README.md`. Section **B** above and
**AD4** are annotated rather than rewritten, since they are historical records.

**What is lost, stated honestly:** nothing now notices a model that has quietly become two contexts. That
was never what the width rule detected either — it detected width — but it was the closest thing to a
prompt. ANTI-PATTERNS #8 now carries the question a human has to ask instead: *is this one story a
business person would tell in one breath?*

### AD9 — `validate` passed 0/0 on a `.drawio` that draw.io could not parse · **BROKEN** · *not fixed*

Rewriting a model with PowerShell 5.1 — `Get-Content -Raw ... | Set-Content -Encoding utf8` — corrupted
it two ways at once. `Get-Content -Raw` decodes as the **system ANSI codepage** unless told otherwise, so
every non-ASCII character in the file was mis-read and re-encoded: `·` became `Â·`, `—` became `â€"`
throughout every lane label and the model cell. The BOM round-tripped into a literal `?` at byte 0, ahead
of `<mxfile`.

**`node tools/model.mjs validate` reported `0 error(s), 0 warning(s)`.** The renderer then failed with
`Export failed`, which is the only reason it was caught.

Two findings in one:

- **The kit's own parser is more permissive than draw.io's.** `model.mjs` reads the file with regex
  surgery — deliberately, and for good reasons documented in `slice.mjs` — so a junk prolog and mojibake
  in every label are both invisible to it. A model can therefore be *validated* and *unopenable*. The
  cheap fix is a well-formedness check at the top of `validate`: the file must start with `<mxfile` and
  parse as XML. Nothing about that costs the regex approach anything.
- **Never rewrite a `.drawio` through PowerShell 5.1 text cmdlets.** Use the Edit tool, or
  `[IO.File]::ReadAllBytes` + explicit `UTF8Encoding($false)`. `Set-Content -Encoding utf8` on PS 5.1 also
  *adds* a BOM, which the templates do not have. This belongs beside the existing CRLF note.

Recovered by decoding the mojibake back through codepage 1252 and stripping the stray prolog byte.

### AD10 — a project could not pin a package version, and the MSBuild workaround downgraded silently · **GAP** · ***FIXED***

Both `.csproj` files are `emit`, so the kit had no way for a project to depart from the enforced stack:
a hand edit was reverted by the next `codegen` run, silently, with the symptom arriving later as
behaviour rather than a build error.

Forced by `reference-implementations/cross-aggregate-invariant`, which must be on **Marten 9** — 8.37.4
ships the whole DCB API without `mt_dcb_tag_version`, so the consistency check has no serialization
point and a DCB implementation can let both writers through (AD1). A folder whose entire purpose is
proving a concurrency guarantee cannot be pinned by hand to the one version where the guarantee exists
and then quietly reverted.

**The obvious fix was tried and is WRONG, which is the finding worth keeping.** A
`Directory.Build.targets` carrying `<PackageReference Update="Marten" Version="9.*" />` inside a target
`BeforeTargets="CollectPackageReferences"` reads correctly, and `dotnet restore` ignores it. Measured:
restore resolved **Marten 2.10.3** — a 2018 package carrying a **critical** CVE — plus three more
vulnerability warnings, while the targets file looked entirely correct. **A pin that fails must fail
loudly; that one failed by downgrading to something ancient and vulnerable.**

**Fixed** in `tools/codegen.mjs`: a `PACKAGES` table of defaults, overridden per project by
`<project>/package-versions.json`. Keys starting with `_` are comments — the *reason* for a pin is the
most valuable thing in the file. An unknown package name **exits 1** rather than being ignored, because
a typo in a pin is how a pin goes missing; that strictness caught its own first `_why` key before the
comment convention existed. Every override is printed on every run, so a departure from the enforced
stack is visible rather than buried.

Verified end to end: regenerate → `Marten 9.*` / `JasperFx 2.*` emitted and reported, 12 written /
13 scaffolds kept, `dotnet build` 0 warnings 0 errors, and `cart-replay.mjs` unchanged.

### AD11 — moving to Marten 9 costs three things a green build does not reveal · **MEASURED**

Taking `cross-aggregate-invariant/` to Marten 9 surfaced three breaks in a row. **All three compiled at
0 warnings 0 errors and failed at host startup** — which is the point: `dotnet build` was worthless as
evidence of compatibility here, and only running the host settled anything.

| | Symptom | Cause |
| --- | --- | --- |
| **Wolverine 5 cannot run on Marten 9** | `TypeLoadException: Could not load type 'Weasel.Core.IAdvisoryLock'` | Wolverine 5.40.1 is bound to the Weasel that shipped with Marten 8. `WolverineFx.Marten` **6.25.1** depends on Marten 9.22.2 — the Wolverine family has to move with Marten, as one |
| **Projection subclasses must be `partial`** | `InvalidProjectionException: No source-generated dispatcher found` | Marten 9 dispatches conventional `Apply`/`Create`/`ShouldDelete` through a compile-time source generator with **no runtime fallback**. `codegen.mjs` emits projection classes non-partial |
| **Wolverine 6 dropped the runtime compiler from core** | `InvalidOperationException: … no IAssemblyGenerator (Roslyn) is registered` (GH-2876) | needs the **`WolverineFx.RuntimeCompilation`** package, or pre-generated code with `TypeLoadMode.Static` |

Two consequences for the kit:

- ~~**`codegen.mjs` must emit `partial` on projection subclasses.**~~ ***FIXED (2026-08-08).*** Every
  projection is now emitted `public sealed partial class`, with the reason stated at the emit site.
  Harmless on Marten 8 — verified by regenerating `state-view/` fresh and building it at 0 warnings
  0 errors — and required on 9. Note the fix reaches **new** files only: an existing view is `scaffold`
  and is kept, so a project generated before this date still needs the one-word hand edit.
- **`package-versions.json` overrides a version but cannot ADD a package**, and Wolverine 6 needs one the
  generator has no reason to emit. Worked around with a `generated/Directory.Build.props` — which *is*
  reliable for adding, unlike the `Update`-in-a-target that AD10 records as silently downgrading. An
  `"_add"`-style key in the override file would close it properly.

### AD12 — the race test that trusted the read model would have reported the budget intact · **MEASURED**

Writing the control for `cross-aggregate-invariant/`, the first version asserted the broken invariant on
the `DepartmentSpend` projection: *committed should be 140000 against a 100000 budget*. **It failed** —
the view said 70000.

The race breaks **two** things, not one. Both writers load the same department row, both apply their own
+70k, and the second inline projection update overwrites the first, because the two transactions touch no
common stream and Postgres has no conflict to detect. So the read model **under-reports the damage**: the
store holds 140k of commitments while a dashboard shows the budget comfortably intact.

**A test asserting an invariant on a projection is asserting it on a derived artifact that the same race
corrupts.** The fix is to compute it from the event store — `QueryRawEventDataOnly<SpendCommitted>()`
summed across streams. Recorded because the wrong version *looked* more readable and would have
under-stated the bug in exactly the direction that makes it survive review.

### AD13 — DCB enforces the cross-aggregate invariant · **MEASURED** · *verdict corrected 2026-08-08*

> **The original heading read "…and it is not seamless", and that was a miscategorisation rather than a
> measurement.** Every cost it listed was the cost of moving to **Marten 9 / Wolverine 6** — which the kit
> was going to pay anyway, and has now paid: the enforced stack is current and all five reference
> implementations are re-measured green on it. Netting the migration out, DCB's own cost is a tag
> registration, `FetchForWritingByTags`, and one documented-wrong detail (the boundary aggregate needs an
> `Id`). **On the current stack DCB is additive and essentially seamless.** The migration costs below are
> kept because they are true and were expensive to find — they are just not DCB's.


`reference-implementations/cross-aggregate-invariant/`, against real Postgres:

```
15 tests, 15 passed, 5 consecutive runs, 0 flakes   (2026-08-08 — all four arms now green)

CONTROL_two_projects_both_pass_the_naive_check_and_overspend   Passed   (race proven)
CONTROL_stress_without_a_barrier_also_overspends               Passed   (race proven)
sequentially_the_naive_check_does_hold_the_budget              Passed
guard_row_*                             (arm 1)                Passed   <-- was RED; see AD14
reservation_row_*                       (arm 2)                Passed
advisory_lock_*                         (arm 3)                Passed
dcb_*                                   (arm 4)                Passed
```

**All four mechanisms hold the invariant, so DCB is not the only answer** — which is the correction to the
state this finding was first written in, when arm 1 was red and "DCB or nothing" was the tempting reading.
Arms 1–3 work on **Marten 8 with no migration at all**, and that changes the adoption question below from
*whether the guarantee is reachable* to *what each way of reaching it costs*:

| Arm | Serialisation point | Loser gets | Cost |
| --- | --- | --- | --- |
| 1 guard row | one row per department, `UpdateRevision` | `Conflict`, retry | every commit contends on one hot row |
| 2 reservation row | unique index on `(dept, sequence)` | `Conflict`, retry | a row per commit, unbounded; the sequence is an O(rows) count |
| 3 advisory lock | `pg_advisory_xact_lock` before the read | `BudgetExceeded`, **no retry** | serialises every commit; contention becomes latency, not failure |
| 4 DCB | `mt_dcb_tag_version` | `DcbConcurrencyException`, retry | needs Marten 9 + Wolverine 6 (AD11) |

Arm 3 is the odd one and worth knowing about: because it locks *before* the read, the loser sees the
winner's commit and is refused by the **ordinary business rule**. Ten writers against a budget for six
produce exactly `6 Committed, 4 BudgetExceeded` every run — no conflicts, nothing wasted, nothing retried.

Two writers, two **different** project streams, one department, one budget. The naive arm — read an
`Inline` multi-stream projection, check, append — commits both and overspends. The DCB arm lets exactly
one through and refuses the other with `DcbConcurrencyException`, and the event-store total holds.

**The shape that makes it work, and it composes with an existing model.** `FetchForWritingByTags` folds
every event carrying the department's tag across all its streams and records the tag's version; the event
is then appended to **our own project stream** with the tag attached, not routed by the tag. The docs
support this — *"every save that appends a tagged event, boundary or otherwise, also queues a
producer-side bump against the same row"* — so a system keeps its own stream layout and gains the
boundary. That matters for any kit-wide adoption: DCB is additive, not a re-modelling.

**But "seamless" would be the wrong word, and the cost is front-loaded:**

- It needs **Marten 9** (AD1) and therefore **Wolverine 6**, which cost three undocumented migration
  breaks, every one of which compiled at 0/0 and failed at startup (AD11).
- **Three public types are documented with no namespace, and none is where you would guess:**
  `[BoundaryAggregate]` is `JasperFx.Events.Aggregation`, `EventTagQuery` is `JasperFx.Events.Tags`, and
  `IRevisioned`/`ConcurrencyException` moved to `JasperFx`. All found by grepping the packages' `.xml`.
- **The identity-less boundary aggregate does not work as documented.** `dcb.md` states such a type has
  *"no `Id` property and no `[AggregateIdentity]`"*; on 9.22.5 `RegisterTagType(...).ForAggregate<T>()`
  still routes it through the document mapper and throws
  `InvalidDocumentException("Could not determine an 'id/Id' field")`. Adding an `Id` — as the docs' own
  worked example does — fixes it. **Follow the example, not the prose.**

So the recommendation for a kit-wide move is: the *capability* is proven; the *readiness* is a separate
question, and the honest input to it is that every one of the four obstacles above was a doc-versus-package
discrepancy rather than a design problem. **And with arms 1–3 green, the migration is no longer a
prerequisite for the guarantee** — it buys the version being maintained *for* you rather than by hand.

### AD14 — the guard row failed for one reason, and it was `Store()` supplying the wrong number · **MEASURED** · ***FIXED***

Arm 1 of `cross-aggregate-invariant/` was red for three prior attempts — `IRevisioned` alone, pre-creating
the row, `UseNumericRevisions(true)` — and **none of them was the cause**. All three change whether the
version column is *enforced*; none changes **which number is supplied**.

`documents/concurrency.md` says `Store()` on an `IRevisioned` document *"is essentially
`UpdateRevision(entity, entity.Version)`"* — the version it **already has**. The enforcing rule is two
sections later: a revision is *"rejected with a `ConcurrencyException` … if the version in the database is
**equal or greater** than the supplied revision."* So a writer supplying its own current version asserts
something already true, and no two writers can ever disagree. One line fixes it:

```csharp
session.UpdateRevision(guard, guard.Version + 1);   // NOT session.Store(guard)
```

Both racers read version N and both claim N+1; the first commits, and the second is rejected because
N+1 >= N+1. **The `+1` is the entire mechanism.**

Worth recording as a shape, not just a fix: **the three failed attempts all looked like configuration
problems and the answer was an argument.** The docs state both halves plainly, one page apart, and neither
half is wrong — the trap is that the sentence describing `Store()` reads as a convenience ("it does the
right thing for you") when it is really a statement that `Store()` cannot conflict.

### AD15 — `SessionOptions` resolves to the wrong type, so the error is CS0117 rather than "not found" · **MEASURED**

`documents/sessions.md` writes `SessionOptions.ForTransaction(transaction)` bare, naming no namespace. The
type is **`Marten.Services.SessionOptions`**. With `using Marten;` in scope the bare name still resolves —
to a different type — so the compiler reports:

```
CS0117: 'SessionOptions' does not contain a definition for 'ForTransaction'
```

**That is the dangerous shape.** A "type or namespace not found" sends you looking for a namespace; *"does
not contain a definition for"* says the type is right and the member is missing, which reads as a **version**
problem — and on a folder deliberately pinned off the kit's stack, "the mirror is ahead of my package" is
exactly the diagnosis the kit has already taught you to reach for (see the `WaitForExecutionOf<T>` note in
CLAUDE.md). It cost a version hunt before a `.xml` grep settled it in seconds.

Fifth entry in this folder's documented-with-no-namespace list, and the first where the misresolution is
*silent*. The standing rule holds and gains a corollary: **grep the package `.xml` before suspecting the
version, because a wrong namespace can imitate a wrong version but never the reverse.**

Marten's own mechanism is `events/archiving.md`: the built-in `Archived(string Reason)` event, appended
to a stream and processed by a single-stream projection, marks the whole stream archived; archived events
drop out of LINQ queries and the async daemon by default, and `UseArchivedStreamPartitioning` moves them
to a cold partition. The documented motivation is exactly this — *"maybe because a workflow is completed,
maybe through time based expiry rules"*. So the stack half is solved and the **model** half is not: which
stream closes, on what event, is a domain fact with nowhere to live.

### AD16 — the docs mirror is always current, so a kit a major behind disagrees with its own reference · **MEASURED** · ***FIXED***

Migrating `state-view/` to Marten 9 broke on:

```
CS0535: 'MessageToCampaignGrouper' does not implement interface member
        'IJasperFxAggregateGrouper<Guid, IQuerySession>.Group(IQuerySession, IReadOnlyList<IEvent>, ...)'
```

`IAggregateGrouper<TId>` now derives from `IJasperFxAggregateGrouper<TId, IQuerySession>` and its batch
parameter narrowed from `IEnumerable<IEvent>` to `IReadOnlyList<IEvent>`. A one-word fix — but **the mirror
had said `IReadOnlyList` all along.**

That is the finding, and it is structural rather than incidental. **`docs.mjs sync` mirrors the CURRENT
docs.** A kit pinned a major behind therefore carries a reference that describes *the next* major, so the
standing instruction — *"read the mirror before writing any generated code"* — is quietly conditional: on
the write side the mirror is ahead of what will compile. The kit had already recorded one symptom of this
(`WaitForExecutionOf<T>` documented, absent from Wolverine 5.40.1) and filed it as a curiosity rather than
as the general problem.

**Fixed by moving the enforced stack to current** (Marten 9, Wolverine 6, JasperFx 2, Alba 8), which makes
the mirror and the packages agree. The lasting consequence for the kit: **a version bump is maintenance of
the docs contract, not only of the packages** — falling a major behind silently degrades every "check the
mirror" instruction in this repo.

### AD17 — `partial` is required only for CONVENTION-dispatched projections · **MEASURED** · *refines AD11*

AD11 recorded that Marten 9 needs `partial` on projection subclasses. Measured more precisely while
migrating: it is required for projections whose `Apply`/`Create`/`ShouldDelete` are dispatched by
**convention**, because that is what the compile-time source generator emits into. A projection configured
**explicitly** does not need it.

`MessageMetricsProjection` (a `FlatTableProjection`, entirely configured in its constructor with
`Project<T>(map => …)`) was deliberately left non-partial through the migration, and all **36** `state-view`
tests pass. `codegen.mjs` emits `partial` on every projection regardless, which is correct — it is harmless
where unnecessary, and the generator cannot know which recipe a hand edit will choose.

### AD18 — the cross-stream detector could not fire on a single-field stream key · **BROKEN** · ***FIXED***

`architect.mjs` distinguishes a rule contended *within* one stream from one spanning streams, and Z1 records
why: the same-aggregate-different-stream case was being reported as same-stream, asking for a race test that
**passes** while the rule it protects stays untested. The fix compares the GWT's example data on the WHEN
against each GIVEN — and was guarded by `key.length > 1`, matching the composite-key case that prompted it.

**That guard made the detector blind to the simplest cross-stream rule there is.** `Project` is keyed by
`projectId` alone; `gwt-commit-2` gives `Spend Committed(projectId=$ProjectB)` against
`CommitSpend(projectId=$ProjectA)` — provably two streams, and the defining rejection of the
`cross-aggregate-invariant/` folder. It was classified `contended-invariant`: **exactly the
misclassification Z1 exists to prevent**, reintroduced by the guard added to fix it.

Now `key.length`. The comparison is sound for a single field and arguably more so — one value to compare, no
partial-match ambiguity.

**Worth noting how it was found: by running the tool against the reference implementation built to study the
very thing it was mis-detecting.** No test covered it, because the tool's own output was the only place the
classification is visible. A rule family whose output nothing asserts on is one nobody is checking.

### AD19 — choosing DCB changes what a GIVEN must be, and three tests passed for the wrong reason · **MEASURED**

Implementing the 13 GWTs of `cross-aggregate-invariant/` with a **DCB** production decider, one test failed:

```
SpendInAnotherProjectOfTheSameDepartmentCountsAgainstTheBudget
  Alba.ScenarioAssertionException : Expected status code 400, but was 204
```

`IntegrationContext.Given` appends straight to a stream — correct for a GWT, because *history is exactly
what a GIVEN means*. But **a DCB boundary is folded from a tag query, and an untagged event is not in it.**
So the seeded prior commitment was invisible, the boundary read zero, and the decider allowed spending it
should have refused.

**The failure was the lucky part.** The same cause was already corrupting two *passing* tests in the same
file: "committing exactly the remaining budget is allowed" and "a release frees the budget" were both green
because the boundary saw **nothing at all**, which is the same green as being allowed correctly. One
rejection caught what two positive tests could not — the standing hazard of asserting that something is
permitted.

**The rule, and it generalises past DCB:** once a slice decides on a boundary that is not a stream, its
GIVENs must be written into that boundary too, or they are not that slice's history. The same applies to a
guard row (a GIVEN that skips it leaves the guard un-versioned) and to a reservation row (a GIVEN that skips
it leaves the sequence wrong).

**Nothing enforces this and nothing can.** The compiler sees a perfectly good append; the model cannot know
which mechanism was chosen; the test reads exactly as it should. What is available is the discipline the kit
already asks for elsewhere — **mutation-check the fold.** Done here: replacing `Apply(CommitmentReleased)`
with a no-op fails exactly one test and no other, which is that test earning its place.

**Consequence for `codegen`:** the generated GWT scaffold's stream-key hint is now incomplete for any slice
whose `architect` decision picked a non-stream boundary. It says *"Stream key: `X.StreamKey(...)`"* and
should also say *"this slice decides on a `<mechanism>` boundary — a raw GIVEN is invisible to it."* Not
built: `codegen` does not read `ARCHITECTURE.md`, and making it do so is a larger change than this finding
justifies on its own. Recorded so it is a decision rather than a drift.

### AD20 — the kit already implements the saga answer and never named it · **RESEARCH** · *and corrects a claim made here*

**Prompted by a question, and it corrects something stated in this session's own summary.** The gap list
I gave after the concurrency run named *"sagas — no notation, no reference implementation, and Wolverine
has first-class support the kit has never touched"* as an outstanding capability. **That framing was
wrong**, and both primary sources say so.

#### What the sources actually say

| Source | Says |
| --- | --- |
| Dilger, *Understanding EventSourcing* **ch. 35** (pp. 490–504) | an entire chapter, *"Pattern: Processor-TODO-List"*. Asks *"How does this relate to the Saga-Pattern?"* and answers: *"We do not define a specific Process-Orchestrator or Saga-Process-Definition but simply act on the facts in the system. That's it."* |
| Dilger, same book, **p. 145 / p. 155** | *"you will learn that I typically don't use Sagas at all"*; *"I personally don't use Sagas most of the time but rely on a simple Processor-TODO List Pattern"* |
| Dilger, **eventmodelers.ai** newsletter | *"The TODO List Pattern is simple and often my first choice."* |
| Dymitruk, **SE Radio 539** | *"any of these where you find these larger patterns, they're always replaced by this to-do list pattern"* |
| **eventmodeling.org cheat sheet** — already cited by this kit for the four patterns | *"the view that the automated process monitors is a simple todo list"* |

**So the kit has been implementing ch. 35 all along without citing it.** CLAUDE.md's *"the View an automation
watches is a todo list: the event puts a row on it, the automation works the row and issues a command, and
the resulting event ticks the row off"* is that chapter, paraphrased. `saga` appeared **zero** times
anywhere in the kit before this entry.

#### The strong form of the claim is not supported, and that matters

*"The TODO list fully replaces the saga"* is stronger than either author states, and the hedges are not
throat-clearing — they are load-bearing:

- **Dymitruk's claim is about NOTATION, not implementation.** The point is to keep the pattern out of the
  diagram *"without needing to bubble up all the information about the platform to the business"*, and he
  is explicit that an existing saga implementation is fine: *"you don't have to throw that in the garbage."*
- **Dilger refuses to universalise, in the same breath every time:** *"Only because I like to use this
  approach doesn't mean it is the best approach. Make your decisions on a case by case basis."*

**The kit's position, now written down rather than merely acted on:** a saga is an *implementation* of an
automation slice, ranking beside the four measured wakeup mechanisms. It gets no notation for exactly the
reason concurrency gets none.

#### Compensation is covered, which is the part that would otherwise justify a saga

Ch. 35 works the canonical order → payment → inventory rollback purely as todo lists:
`InventoryReservationFailed` → `PaymentRefundRegistered` **opens** a refund todo → `RefundPayment` →
`PaymentRefunded` **closes** it — and *"if the refund does not work, the task will not get closed and will
be retried on the next processor schedule"*, dead-lettering to a human eventually. Retry and compensation
fall out of the pattern instead of being written.

#### What is therefore ACTUALLY missing, which is narrower than "sagas"

The kit's `automation/` folder measures **four ways to wake a trigger**. It does not demonstrate:

1. **A multi-step process** — a chain of todo lists across slices, which is the shape ch. 35 uses to make
   the saga comparison. Every automation the kit has built is one step.
2. **The failure direction** — a command that fails, leaves its row open, is retried on the next sweep, and
   dead-letters after N. This is the whole compensating-transaction story and nothing in the kit tests it.
3. **The back-channel dotted line** — ch. 35 draws the tick-off edge dashed, *"not part of the Flow but just
   updating the data of the Read Model."* Already legal in the grammar (the `Event → View` exception); just
   not distinguished.

Item 2 is the one with teeth: **"the task stays open and is retried" is exactly the property a green test
suite does not check**, and it is the same family as `NOTHING EVER WAKES THIS`.

---

# The sixth run — `reference-implementations/reservation/`, ch. 36's other half (BL)

**What was run.** A new reference implementation for the two-step **reserve → execute** workflow of
*Understanding EventSourcing* ch. 36 — the half that is a workflow rather than a concurrency mechanism.
Model authored by hand, then the kit's standing sequence: `model.mjs validate` → `architect record` +
answer → `codegen.mjs` → `architect tests` → implement → `dotnet test`. **29 tests green, 0 warnings,
0 errors, stable across three repeated runs**, every load-bearing line mutation-checked.

Full measured write-up: [reference-implementations/reservation/README.md](reference-implementations/reservation/README.md).

## BK2 — the Reservation Pattern, both halves · **BUILT** · ***CLOSED***

Ch. 36 has two halves and the kit now has both. The **mechanism** half is `cross-aggregate-invariant/`
arms 2 and 5 (a unique index; a stream-id collision), built in the previous run — arm 2 a week before
anyone read the chapter it comes from. The **workflow** half is `reservation/`.

**The headline is that nothing was added to the notation, and that was the thing being tested.** No
`pattern="reservation"`, no attribute, no marker saying two slices are a pair. It is a state change
followed by an automation, plus a second automation for the compensating path — the kit's existing grammar
covers every edge, and the completeness check accepts the composition with nothing told to it. A fifth
pattern would have been a mistake: what makes this the Reservation Pattern is *which stream the first step
writes to*, and that is `identity=` on a swimlane.

## BL1 — a primitive array on a READ MODEL crashed `codegen.mjs` outright · **BROKEN** · ***FIXED***

`fields="takenSlots:int[]"` with no `children=` — which CLAUDE.md explicitly documents as legal, *"a list
of primitives is not a group"* — killed the generator with
`TypeError: Cannot read properties of undefined (reading 'map')`.

**`[].every(...)` is `true`.** The child-group hint looked up `v.children?.[f.type] ?? []` and asked
whether every child field was supplied by the event; for `int[]` there are no children, so the vacuous
`every` matched, and `v.children["int"]` was then `undefined` when the hint tried to render it.

It had never fired because **every primitive array in the kit until now was on a command or an event**
(`recipients:string[]` in `state-view/`), and neither reaches that line. The first one on a *view* took
the whole run down. Fixed by requiring the group to be **declared** rather than merely absent:
`f.collection && v.children?.[f.type]?.length && …`. Reasoning at the emit site.

## BL8 — you cannot build a broken reserver on ONE stream, and that reshaped the control · **MEASURED**

Writing the race tests, the obvious control was the same enumerated slots appended *without*
`FetchForWriting`. **It does not reproduce a double-booking.** Marten 9 refuses the second concurrent
append with `EventStreamUnexpectedMaxEventIdException :: duplicate key value violates unique constraint
"pk_mt_events_stream_and_version"` — `Won=1, VersionConflict=1`, deterministically, with no
optimistic-concurrency API involved anywhere.

So the guarantee is in the event table's primary key, not in the API call: **`FetchForWriting` buys the
fold and a clean exception, not the safety.** Two consequences worth carrying:

- A missing `FetchForWriting` on a single-stream decider is not automatically a live over-allocation bug.
  It is still wrong — you lose the fold and get an ugly exception — but the invariant holds.
- The control had to become a different **design**: per-grant streams and a running total, where two
  writers share no row and Postgres has nothing to detect. That is arm 0 of `cross-aggregate-invariant/`
  in miniature, and it restates the pattern's whole claim from the other side.

Marten's own docs say Quick mode *"can alleviate concurrency issues from trying to append events to the
same stream without utilizing optimistic or exclusive locking"*. Read as *"concurrent appends to one
stream are permitted"*, that is wrong: they still collide on `(stream_id, version)`.

## BL9 — a create-collision guard is not enough once a unit can come BACK · **MEASURED**

`cross-aggregate-invariant/` arm 5 guards a reservation with `StartStream`, and that is correct for ch. 36's
e-mail address — claimed once, never released. **A slot that a failed execution gives back has a stream
that already exists**, so there is no creation to collide on and such a guard would let every
re-reservation through. `Two_reservers_re_taking_a_freed_unit_only_one_wins` asserts `StreamCollision == 0`
for exactly this reason: what refuses the loser is the stream's **version**, so the decider must fetch and
fold a `Held` flag.

Which is what ch. 36's own code does — `@CreationPolicy(CREATE_IF_MISSING)` plus
`var reserved: Boolean = false` — while its prose emphasises the creation trick. **Follow the example, not
the prose**, again.

## BL10 — the ch. 32 hazard, reproduced deterministically, and it changed a registration · **MEASURED**

See **BK1** and **BL2** in [KIT-FINDINGS.md](KIT-FINDINGS.md). Short version: register a todo View Async —
which is what `codegen` does for any multi-stream view, following Marten's own guidance — and a wakeup that
arrives inside the request that appended the trigger event reads an empty list and never fires again. The
reservation is never executed and never compensated. 200, clean log, green suite.

`ViewRegistrations` in `reservation/` therefore registers both todo Views **Inline**, with the reasoning at
the line, while the human-facing `PoolAvailability` stays Async. This is the standing *"where the kit and
the docs disagree, the docs win"* rule meeting its first genuine exception — and the reason it is one is
that Marten's sentence is about a view somebody **reads**, not about a view an automation's **liveness**
depends on.

## BL11 — a mutation went uncaught, and the model had already asked about it · **MEASURED**

`model.mjs validate` emits `derived-on-todo-view` for both todo Views, asking *"would getting the fold
wrong change which events appear, and would a GWT catch that?"*

Measured: break `SlotsToIssue.Apply(GrantIssued)` so a successful grant never ticks its row off, and **all
26 tests passed**. The note was right to ask, and the answer was no.

**And the note's suggested remedy does not apply**, which is the part worth recording. The wrong fold does
not change which events appear: the row stays pending, every later wakeup re-issues, `AlreadyIssued`
refuses each one, and the event stream is byte-identical. What it produces is an unbounded leak of *wasted
work* — a decider call per wakeup per grant, for ever.

So the honest answer is not an event scenario. `Automation/TodoListTests.cs` asserts on the todo rows **on
purpose**, and is deliberately outside `Slices/` because a slice's contract is its events and none of this
is part of it. With it, the same mutation fails exactly one test. **A recipe worth reusing: where a todo
View's fold has no event-level consequence, the test belongs with the machinery and must say so.**

## BL12 — what "one single web-request" actually costs

Ch. 36: *"Although it is modeled as Event, Read Model and Processor — the whole cycle of reservation and
execution can be done within one single web-request."* Both modes are built and measured; both satisfy
every GWT unchanged, because the GWTs name the command and only what *sends* it differs.

The book does not mention the price, and it is the last row of the folder's table: **in-request has no
record of intent outside the moment**, so a process that dies between the two commits leaves a unit held
for ever and nothing knows. Out-of-request keeps a pending row in a durable store and the next wakeup
executes it. That is the same property the `automation/` folder identified as what a subscription buys over
event forwarding, arriving here as the difference between recovering a crash and not noticing one.

**And "one request" is not "one transaction".** Two commits, in both modes — if reserve and execute could
be atomic there would be nothing to reserve *against*, which is why `IGrantExecutor` is an interface and
why a refusal is an **event** rather than a rejected command.

## BL13 — the reservation has no EXPIRY, and that is deliberate and load-bearing

`reservation/` has no sweep that releases stale reservations. Every mechanism it builds recovers a
*crashed* execution; none recovers an execution that was never woken. A real system needs the sweep, and it
would be a **third automation slice** rather than a new mechanism — `Slot Reserved` → a stale-reservations
View → a sweeper → `ReleaseSlot`.

It is left out because it teaches nothing the folder does not already teach, and because adding it would
make the *absence* of a recovery path invisible. **Two `accept the window` answers in that folder's
`ARCHITECTURE.md` depend on the absence**: `issue-grant` reads the Slot stream and accepts that nothing
will change it meanwhile, which holds only because the sole other writer is the compensation and the
compensation cannot run until this execution has refused. Add an expiry sweep and both answers stop being
true, with nothing to say so. That is what the file is for.

---

# The seventh run — the A-Frame correction (BM)

**Prompted by the human**, and the prompt was right: *"you probably still don't understand how to use the
critter stack properly. Wolverine has openly stated to promote the A-Frame architecture which is exactly
what the books describe."*

## BM1 — the aggregate handler workflow does NOT need a single-field key, and the kit said it did in five places · **BROKEN** · ***FIXED***

The claim, verbatim from `codegen.mjs`: *"[WriteAggregate] resolves the stream identity from a member of the
COMMAND, so the identity has to be a single value of the store's identity type. A composite key cannot
satisfy that: there is no one member to read."* It was also in CLAUDE.md, `architect.mjs`, the `architect`
skill and `state-change/README.md`. **Five runs, never tested.**

It reads a **member**, and a computed get-only property is one:

```csharp
public sealed record ReleaseSlot(Guid PoolId, int SlotNumber, Guid GrantId, string Reason)
{
    public string StreamKey => ReleaseSlotState.StreamKey(PoolId, SlotNumber);
}

public static (SliceOutcome, Events) Handle(
    ReleaseSlot command,
    [WriteAggregate(nameof(ReleaseSlot.StreamKey), Required = false)] ReleaseSlotState? slot)
```

`reservation/`'s Slot stream is keyed `(poolId, slotNumber)`, and every one of that slice's existing tests
passed unchanged against a decider with **no `IDocumentSession` in it at all**.

**The kit was disagreeing with both of its sources at once**, which is the part worth keeping. `LEB` ch. 15
is an argument for a pure command handler — *"the Command Handler is no longer 'pure' and gains unnecessary
dependencies. This added dependency complicates testing. To write effective tests, you'll need a mocking
framework"* — and its implementation example is the decider signature `(events, command) -> events`.
Wolverine's Marten page names the **Decider pattern** outright and its best-practices page says the team
*"leans hard into that A-Frame Architecture idea"*. The book and the stack agreed all along.

**How the drift happened is the more useful finding, and it is A11.** `codegen` scaffolded no decider, so
every one was hand-written from scratch, and the only worked examples to copy were the earlier hand-written
ones. The generator now scaffolds the A-Frame shape per command slice — which is why closing A11 is the fix
rather than a separate improvement.

**Two of the six folders were already doing it right.** `state-change/` and `state-view/` used
`[WriteAggregate]` on HTTP endpoints, with the reasoning recorded — including the non-obvious part, that the
kit's per-slice fold naming (`ReviseSubjectState`) defeats both of Wolverine's conventions, so the identity
must be named explicitly. That discovery is what made the generalisation to composite keys a one-line change
rather than a research project.

## BM2 — `AlwaysEnforceConsistency` makes a cross-stream READ enforceable, and it fixed a hazard shipped the day before · **MEASURED**

From `Wolverine.Marten` 6.25.1's own XML: *"Marten will enforce an optimistic concurrency check on this
stream **even if no events are appended**… useful for cross-stream operations where you want to ensure
referenced aggregates have not changed since they were fetched."* Nothing in the kit mentioned it.

`reservation/issue-grant` appends to the Grant stream while only READING the Slot stream, and
`ARCHITECTURE.md` answered that with *"accept the window"* — reasoning that the only other writer is the
compensation, which cannot run until this execution has refused. **True of the model, enforced by nothing.**

Measured with a barrier that releases the slot between the middleware's fetch and its save:

| | outcome |
| --- | --- |
| `[WriteAggregate(..., AlwaysEnforceConsistency = true)]` | `EventStreamUnexpectedMaxEventIdException` — *expected 1 but was 2* |
| the same handler without it | **the grant is issued against a unit somebody had already handed back** |

Both arms are permanent tests. The control is green while asserting the invariant breaks.

**It does NOT solve `cross-aggregate-invariant/`'s problem**, and the distinction is the point. That folder's
rule spans *every* Project stream of a Department — there is no single referenced stream to version-check, so
its five mechanisms stand. `AlwaysEnforceConsistency` answers the narrower and far more common shape: *read
one specific other stream, write this one*. Two different cross-stream problems that the phrase
"cross-stream invariant" had been hiding.

**The first attempt at this test was invalid and passing.** It raced two handlers that both only READ the
slot stream, so nothing advanced it and both correctly succeeded — a green test proving nothing, which is the
control-shaped mistake the kit already has a standing rule about.

## BM5 — with MORE THAN ONE `[WriteAggregate]`, returned events go NOWHERE, silently · **MEASURED**

The docs say it in one line — *"For appending to multiple streams though, for now you will have to directly
target `IEventStream<T>` to help Marten know which stream you're appending events to"* — and skipping it
costs a debugging round: **a clean build, no exception, nothing logged, and five tests failing with `should
have single item but had 0`**. A single-stream decider can still return its events, and does.

## BM6 — where the concurrency guard goes once middleware owns the save

Every hand-rolled decider in the kit caught `EventStreamUnexpectedMaxEventIdException` and translated it into
that slice's rejection — `AlreadySent`, `AlreadyApplied`, `AlreadyReleased`. `translation/` went further and
carried a hand-written **retry loop**: `for (var attempt = 1; ; attempt++)`, `EjectAllPendingChanges()`, an
`Attempts` constant. About fifteen lines whose entire subject was the database.

A decider in the workflow cannot catch it, because it does not save. So the generator now emits, once per
system:

```csharp
opts.OnException<ConcurrencyException>().RetryTimes(3);
opts.OnException<EventStreamUnexpectedMaxEventIdException>().RetryTimes(3);
```

On the retry the middleware re-fetches and **the ordinary business rule** refuses it. Strictly better than
the translation it replaces: one statement of the rule instead of two hand-written ones that have to agree,
and it is what the Marten page means by *"you're going to want some resiliency and selective retry
capabilities for concurrent access violations"*. Verified by the folder that produced a real double delivery
— `automation/`, 19 green including the forwarding test.

## BM7 — a scaffolded method named after its command does not compile

`public static PoolOpened OpenPool(OpenPool command, …)` inside `OpenPoolEndpoint` gives
`CS0119: 'OpenPoolEndpoint.OpenPool(...)' is a method, which is not valid in the given context` — the method
name shadows the type in `nameof(OpenPool.StreamKey)`. Slice names and command names are the same word in
this kit by convention, so this is the normal case rather than an edge one. Both scaffolds are named
`Handle`.

## What this run did not change

**The GWT tests are untouched, and that is the evidence.** Every conversion was judged by whether the
existing model-derived tests still passed — 160 across six folders, and not one assertion was edited to
accommodate a decider. The model constrains the contract; this run only changed how the contract is honoured,
which is the same claim the reference implementations make about every other choice they measure.
