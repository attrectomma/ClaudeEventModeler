# The live recipe demo — presenter's runbook

**Kit copy points at:** `C:/Repos/Attrecto/ForLiveDemoRecipe` (`node tools/project.mjs where`)
**Rehearsed end to end on 2026-08-13.** Every number below was measured on that run, not estimated.

**The point of the demo is one thing: the audience watches the information completeness check find a
hole nobody noticed, and watches the hole get walked backwards until it is closed.** Everything else
— the wireframes, the GWTs, the code, the page — is the setting that makes that moment mean something.

---

## HOW THIS RUN IS DRIVEN — stop at every gate, and wait

**Read this first if you are the Claude driving the demo.** This run is paced for a room, not for
throughput. There are marked gates below (**⏸ GATE**), and at each one:

1. Say in one or two lines what just happened and what comes next.
2. **Stop. Produce no further tool calls.** Hand the floor back.
3. The presenter will say something like *"go on"*, *"next"*, or *"continue"*. **That is the whole
   instruction.** It is permission to proceed, not a review, not feedback, and not a request to change
   anything. Do not ask a follow-up question at a gate and do not offer options — just continue.

**Do not batch two gates into one turn**, and do not run ahead because the next step is obvious. The
pause *is* the demo: it is when the presenter turns to the audience and explains what they are looking
at. Running two phases together takes that away and cannot be undone.

**The single most important stop is ⏸ GATE 4 — after `validate` reports the error and the red arrow is
on screen, BEFORE anything is fixed.** The presenter needs unhurried time there to show the diagram,
trace the arrow, and explain what the check just did. Fixing it in the same turn as finding it destroys
the only moment the demo exists for. If in doubt anywhere else, stop anyway; a needless pause costs
five seconds and a missed one costs the point.

### The gates, in order

| | Gate | The presenter is explaining |
| --- | --- | --- |
| 1 | after the brief is read back | what the requirements say — and, unknowingly, the hole |
| 2 | after the events + storyboard are drawn | the timeline, left to right |
| 3 | after screens, commands, views and slices exist | the two slices, one shared screen, the column order |
| **4** | **after `validate` fires and the arrow is RED — nothing fixed** | **the completeness check. THE moment. Take as long as needed** |
| 5 | after each backward step (event, then command) | the arrow moving one hierarchy up |
| 6 | after `validate` reaches 0 errors | that green is not the same as right — the form still has no prep-time box |
| 7 | after wireframes | dashed = displayed, white = typed, read off the model |
| 8 | after the GWTs and GTs | rejections, and that a GT has no WHEN |
| 9 | after `architect` records its answers | Inline vs Async, and why this model has no contended invariant |
| 10 | after `scaffold` → **7 red tests** | one failing test per GWT, generated from the model |
| 11 | after the design is shot | the design beside the model's field contract |
| 12 | after each agent reports | what `backend-agent` / `frontend-agent` chose, and why |
| 13 | after the page runs under compose | the working thing, and the two journey prompts that close the demo |

---

## 0. Before you start — RESET, or the demo is already over

**One command now, and it does the reset the four-line version did plus the warming.**

```
node tools/demo-reset.mjs --warm        # run this AFTER a rehearsal, ideally the day before
node tools/demo-reset.mjs               # and again just before you start, if anything ran since
```

`--warm` builds the compose images from the finished tree **first**, so the docker layer cache survives
the clean; then it resets, re-inits, and pulls the five base images. The reset itself is exactly what it
always was — `git reset --hard demo-start && git clean -fdx` — so **every artefact still comes back from
scratch**, which is the point. Only the caches outside the repo are kept, and none of them changes a byte
of what gets generated. Measured: a cold `docker compose up --build` was ~3 minutes of the rehearsal.

It refuses on a bad `--tag` **before** deleting anything, and refuses outright if the project is not a git
repo.

**The `init` step inside it is not redundant.** `git clean -fdx` deletes `diagrams/` and `designs/`, because
git cannot track an empty directory — and `model.mjs validate` then answers `not found: …\diagrams` and
exits **0**, which is a confusing first thing to have on screen. `init` is idempotent (`0 written, 5 kept`)
and **preserves the settings** in `project.json`, which it did not used to do.

### The three settings this copy runs with — check them, they change the run

```
node tools/project.mjs where
  mobile:   false   — design/review/ui-journey shoot the desktop width only
  kitFixes: false   — findings are LOGGED, not fixed; nothing under the kit is edited
  demo:     true    — one backend agent for all slices, short reports, no agent-side review loop
```

All three are for **time and tokens on stage** and none of them skips a gate — `validate` at zero errors,
`dotnet build` at 0/0, the tests and `design.mjs check` all still have to pass. The full cost table is in
CLAUDE.md under *Two settings that make a run cheaper*. Two things worth knowing while presenting:

- **`kitFixes: false` is why a generator defect does not become a detour.** On the first live run the build
  died on `CS0111` — two GWTs legitimately share a rule name and both test methods were named after it
  (KIT-HISTORY **BT12**). With the flag off, that gets **logged** and the blocking file — a `scaffold`, so
  hand-owned — gets the minimum edit, out loud. A blocking **`emit`** file is a stop, not a hand edit.
- **`demo: true` collapses the fan-out to one backend agent.** That is a real loss: the `owner=` split and
  the two agents disagreeing with the scaffold are among the best things the kit shows. If you have the
  time, set it `false` and run §6 as it was.

Four tags, each a place you can jump to if a step goes wrong on stage:

| Tag | The folder holds |
| --- | --- |
| `demo-start` | **start here.** The brief in `inbox/`, an empty project, no diagram |
| `demo-gap` | the model as the brief describes it — `validate` reports the hole |
| `demo-model` | the hole closed, 0 errors 0 warnings, GWTs written, both slices `ready` |
| `demo-built` | the whole thing: architect, scaffold, design, 7 green tests, the running page |

`git clean -fdx` matters — it removes `node_modules`, `bin`, `obj`, the renders and the shots.
Without it the reset leaves build output that makes later steps suspiciously fast.

**Also check:** Docker Desktop running (the tests and compose both need it), and the docs mirror fresh
(`node tools/docs.mjs status` — it was 4 days old on the rehearsal, which is fine).

---

## 1. Phase 0 — read the brief back (2 min)

```
node tools/project.mjs inbox
```

Reports one readable file. Read `inbox/brief.md` and say back, in your own words, what it asks for.
**Say the three list columns out loud — name, serves, prep time — and the two form fields, name and
serves.** Nobody will notice. That is the whole trick: the hole is *in the brief*, stated plainly, and
a room full of people reading it will not see it either.

The brief is written as a real kick-off note, including things that are out of scope and one thing
("should two recipes be allowed the same name?") that is deliberately left open.

---

## 2. Model it — `event-model`, mode=demo (10-15 min)

```
/event-model mode=demo
```

Scope answer: one context (`recipes`), two slices, one actor, one model.

The shape it should reach, and the column order is not arbitrary:

```
column 1                        column 2
recipe-list (state-view)        add-recipe (state-change)
  Recipes screen                  Recipes screen  (same slug!)
  RecipeList view                 AddRecipe -> RecipeAdded
```

Three things worth pointing at while drawing:

- **One screen, two slices, one slug.** `displays=` must agree across both cells; `inputs=` may
  differ. That asymmetry is a real rule and this model is the smallest thing that shows it.
- **The view column comes FIRST.** The screen reads a View, so the View must be to its left or the
  feed points backwards. That is why `recipe-list` is column 1 even though "add a recipe" happens
  first in time.
- **`RecipeAdded → RecipeList` points LEFT, and that is legal.** It is the single deliberate exception
  to left-to-right. `node tools/slice.mjs route <model> --from evt-recipe-added --to rm-recipe-list`
  puts it in the backward corridor.

---

## 3. THE MOMENT — phase 7, the completeness check (5 min, and take your time)

```
node tools/model.mjs validate
```

```
recipes — 2 slice(s), 5 element(s), 1300px  1 ERROR(S)
  ERROR  [completeness/unsourced-attribute] RecipeList.prepTimeMinutes is supplied by none of its
         sources (RecipeAdded). Walk backwards: where does this data really come from?
```

**Then draw it, because the picture is the demo and the console is not:**

```
node tools/model.mjs mark   <project>/diagrams/recipes.drawio
node tools/drawio.mjs render <project>/diagrams/recipes.drawio
```

The `RecipeAdded → RecipeList` arrow goes **red and dashed** and `RecipeList` gets a red `!`. Open the
PNG, or just let the draw.io tab redraw — it merges an external write live, so the arrow turns red on
screen with nobody touching anything.

`node tools/model.mjs clear <file>` strips the markers and restores the file byte-exactly, so mark as
often as you like.

### Now walk it backwards, one hierarchy at a time

This is the book's own worked example — *"we just moved the red arrow one hierarchy further up"* — and
it happens twice here. Re-run `validate` after each edit:

| # | The edit | What `validate` then says |
| --- | --- | --- |
| 1 | add `prepTimeMinutes:int` to **RecipeList** — already there; this is the starting error | `RecipeList.prepTimeMinutes` unsourced by `RecipeAdded` |
| 2 | add `prepTimeMinutes:int` to **RecipeAdded** | `RecipeAdded.prepTimeMinutes` unsourced by `AddRecipe` — **the arrow moved up** |
| 3 | add `prepTimeMinutes:int` to **AddRecipe** | **0 errors** |
| 4 | add `prepTimeMinutes:int` to the screen's `inputs=` | still 0 errors |

### The best beat in the demo is step 4, and it is the one the check did NOT force

**After step 3 `validate` is green and the form still has no box to type a prep time into.** Ask the
room why, then explain: a command's field may be sourced from the screen's `displays=` *or* its
`inputs=`, and the screen already *displays* `prepTimeMinutes` — in its list rows. So the checker
believes the UI holds the value. It does, for other recipes. It does not for the one being created.

**A value shown in a list ROW is not a value the FORM can submit, and only a human can see that.**

That is not a bug to apologise for — it is the honest edge of an automated check, and it is exactly why
`OPEN-QUESTIONS.md` carries a "what the checker cannot see" list. This run added a line to it. If you
want the tidy version of the demo, stop at step 3 with "0 errors" and skip this. If you want the
*truthful* version, do step 4 — it is the part people remember.

---

## 4. Finish the model — phases 8-10 (5 min)

```
node tools/wireframe.mjs scaffold <project>/diagrams/recipes.drawio
```

6 bound fields, 7 cells. The list screen's fields draw **dashed** (displayed only), the form's draw
**white on grey** (typed) — so a wireframe reads as a form at a glance, from the model alone.

Then the GWTs. Four for `add-recipe` (one happy path, three rejections, all `enforce="periphery"`) and
three GTs for `recipe-list` — a GT is the same cell with **no `when=`**, because a read model has no
command. The three GTs are worth reading out: one row, two rows, and **zero** rows.

Then Conway (`owners=` on both slice cells — both cross the UI/backend line), `reflow`, and promote:

```
node tools/slice.mjs promote <model> --slice recipe-list --to ready
node tools/slice.mjs promote <model> --slice add-recipe  --to ready
```

Ends at **0 errors, 0 warnings, 3 notes, 19 elements**.

---

## 5. Architect, then scaffold (5 min)

```
node tools/architect.mjs questions      # three questions on this model
node tools/architect.mjs record         # then answer them
node tools/architect.mjs check
```

Three questions only, which is what makes this model good for a demo: the stream boundary, how stale
`RecipeList` may be, and the C# type bindings. **No contended invariant and no cross-stream rule**,
because every rejection here is settled by the request alone — worth saying, because it shows the tool
is reading the model rather than printing a checklist.

The interesting answer is the read side: **Inline**, because Kata's own sentence is *"the new recipe
appears in the list"* and Async cannot honour that. Marten's docs recommend async for multi-stream and
for single-stream projections *"that utilize enrichment"* — this is neither, so Inline is the
documented fit rather than a departure.

```
node tools/model.mjs compile
node tools/codegen.mjs
cd <project>/generated/RecipeBook && dotnet build && dotnet test
```

| | Measured |
| --- | --- |
| files | 22 written |
| build | succeeds, **0 errors** |
| tests | **7 failed, 0 passed, 0 skipped** — one per GWT, against real Postgres |

**The 7 red tests are the point, not a problem.** Each failure is a `NotImplementedException` carrying
a `TODO(codegen)` that says what to assert. Show one.

⚠ **`dotnet build` prints 2 warnings, and the kit's stated gate is 0.** Both are the same transitive
NuGet advisory: `Testcontainers.PostgreSql 4.*` floats to 4.13.0, which pulls `SSH.NET 2025.1.0`
(GHSA-q939-rpr3-3284). It is **kit-wide and not this model's** — it will appear on every project the
kit generates today. Either say that in one sentence, or pipe the build through
`grep -v NU1903`. Do not pretend it is not there.

---

## 6. Design, then build it (10 min)

```
/styling
```

⚠ **`frontend-design` is on disk but NOT ENABLED**, and enabling it before the demo is a five-second job
worth doing — see *The frontend-design plugin* at the bottom of this file. Without it `styling` invents
the aesthetics itself and the result is noticeably more templated. With it, the design step becomes a
much better thing to show.

The design is dark-first, and its signature element is derived from the brief rather than from taste —
*"twenty minutes or ninety minutes is the whole difference"* is the sentence that says what the page is
for, so prep time gets a monospace figure over a bar whose width encodes the duration. Scanning the
column answers *"what can we shoot this afternoon"*.

```
node tools/design.mjs check                       # 0 errors, 0 warnings
node tools/design.mjs sheet          # desktop only — this copy sets "mobile": false
```

**Look at the shot.** Both rehearsal runs found a defect that way and none was visible in the CSS: the prep
input sitting a few pixels above the other two, the signature bar too faint to compare, and on 2026-08-14 a
duration bar that read as an *underline of the numeral* rather than a bar you scan down the column.

**Skip the optional design states under `demo: true`** — the empty state and the refused state. They are
good design work and the frontend agent implements both faithfully, which costs time the room does not see.
**The behaviour is not skipped**: *"no recipes added — the list is empty, not an error"* is a GT on the
model and it is still one of the seven tests.

Then the code — **and this is where the kit is most worth showing, so run the real agents.**

```
/codegen
```

`codegen` the *skill* writes nothing itself. It sequences `backend-agent` and `frontend-agent`, hands
each one only its slice of the IR, and enforces the gates. The split is not invented for the demo: it is
on the model, as `owner="backend-agent"` on the Commands/Views and Event Stream lanes and
`owner="frontend-agent"` on the UI lane. Worth saying out loud — **the diagram decided who builds
what.**

| Order | Agent | Gets | Owns |
| --- | --- | --- | --- |
| 1 | `backend-agent` on `add-recipe` | the slice's IR, its 4 GWTs, `ARCHITECTURE.md` | fold, endpoint, validator, its 4 tests |
| 2 | `backend-agent` on `recipe-list` | the slice's IR, its 3 GTs | projection, registration, read endpoint, its 3 tests, the dev seed |
| 3 | `frontend-agent` on the `recipes` screen | the route, request shape, response codes, rule names | the React port and API client |

**With `demo: true` — which this copy sets — rows 1 and 2 are ONE agent**, given both slices and told
explicitly that `recipe-list` owns `GenesisData.cs`. Two agents cost ~23 minutes and ~380k tokens on the
measured run, largely because each reads the docs mirror from cold. Brief every agent with *"report in ≤12
lines: recipe, why, cost, the API contract, test counts, and any modelling gap"* — **the gap line is not
optional**, it is where the run's real findings came from. And tell the frontend agent *"shoot once at
desktop; I will run compose"*: its own review loop was **22 minutes**, the largest single item in the run,
much of it re-shooting a flaky 390px capture that `mobile: false` now removes entirely.

Say the trade out loud if the room is technical — it is a good line: *"I am running one agent because we are
short of time; the model says two, and on a real project it would be two."*

**Backend before frontend, and one agent at a time.** The frontend wants the real contract rather than a
predicted one, and the cost of waiting is minutes. The two backend agents are *separable* but not run in
parallel here for one concrete reason: they would both want `GenesisData.cs`, so slice 2 is given it and
slice 1 is told to leave it alone.

**Ask each agent for its choice out loud.** `pattern="state-change"` is a contract, not an
implementation — the aggregate handler workflow, `FetchForWriting`, an endpoint vs a message handler and
`MartenOps.StartStream` are all honest options, and no checker can see a wrong one. Reading an agent's
reasoning back to the room is the best evidence that this is not template expansion. ⏸ **GATE 12** after
each report.

⚠ **Watch the working tree, not the launch message.** Background agents in this kit have died silently
at launch before, and more than about two at once did. If the slice's files still hold their
`TODO(codegen)` a couple of minutes in, the agent is gone — relaunch rather than wait. First writes have
landed as late as **420s**, so silence at two minutes means nothing on its own.

### THE AGENT STEP IS THE ONLY PART OF THIS DEMO THAT DEPENDS ON CAPACITY YOU DO NOT CONTROL

Everything else here — `validate`, `mark`, `render`, `scaffold`, `build`, `test`, `compose` — is local and
deterministic and will behave the same on the day. The fan-out is not: on the rehearsal it took **three
launches**, the first two dying instantly on `API Error: 529 Overloaded` while the driving session's own
calls kept working fine. That is Anthropic-side load, and no amount of prompt fixing touches it.

**So decide the fallback before you are in front of people, not during:**

| | |
| --- | --- |
| first 529 | relaunch, say "the API is busy" in four words, carry on. Costs nothing |
| second 529 | relaunch once more, and start talking through what the agents *would* do while it runs |
| third 529 | **stop retrying.** Say the fan-out is capacity-bound today, `git checkout demo-built` where the agents have already done it, and walk the result instead. Retrying live is dead air |

A relaunch needs no cleanup, and that is worth knowing rather than hoping: the agents fill `scaffold`
holes, and a `scaffold` file is untouched until something writes to it, so every retry starts from a
byte-identical tree. Verified across all three rehearsal launches.

**Have `demo-built` open in a second window before you start.** It is the whole answer to any live
failure in this section, and reaching for it should take five seconds rather than a search.

Then the port and the run:

```
cd <project>/generated/RecipeBook && dotnet test        # 7 passed
cd web && npm install && npm run build
node tools/codegen.mjs                                  # now emits nginx + the web service
docker compose -f <project>/generated/RecipeBook/docker-compose.yml up -d --build
```

**Run against compose, not Vite** — Vite proxies `/api` itself and therefore cannot see a wrong nginx
prefix, a missing `ASPNETCORE_ENVIRONMENT`, or a runtime that cannot do Wolverine's codegen. All three
render as an empty screen with no error.

Then open **http://localhost:8080** and add a recipe. Measured on the rehearsal:

```
POST /recipes/addRecipe        204, and the row appears immediately (Inline)
GET  /recipes/recipeList       5 recipes, ordered by name
POST with name=""              400  {"title":"NameRequired", ...}
POST with servings=0           400  {"title":"ServingsMustBePositive", ...}
GET  /recipes                  the SPA, NOT a 404
```

That last line is worth a sentence: `/recipes/` is the API prefix and `/recipes` is a screen route, and
codegen's emitted nginx handles the collision with an exact-match `location = /recipes` block. It knows
because it read the routes actually in the tree.

```
node tools/review.mjs shot http://localhost:8080/ --screen recipes
node tools/review.mjs sheet
```

`review/index.html` puts the agreed design beside the built software, same screen, same width, 1:1.

---

## 7. Stop here

```
node tools/codegen.mjs
```

prints exactly two prompts and nothing else:

```
NO JOURNEY TESTS, and 2 slices are claimed.
NO UI JOURNEY, and 2 claimed slices have screens.
```

**That is the end of the demo.** Both are real gaps and both are deliberate: which stories are worth
walking is a domain answer nothing can derive, and a browser walk starts containers and costs minutes.
Reading those two prompts aloud is a good close — the kit is telling you what it cannot know.

Tear down: `docker compose -f <project>/generated/RecipeBook/docker-compose.yml down -v`

---

## Timing, and what to cut

| Section | Rehearsed |
| --- | --- |
| 1-2 read the brief, model it | ~15 min |
| **3 the completeness check** | **~5 min — never cut this** |
| 4 wireframes, GWTs, Conway | ~5 min |
| 5 architect + scaffold | ~5 min |
| 6 design, code, running page | ~10 min |

**Short on time, in cutting order:** the design (§6 first half — jump from `demo-model` to
`demo-built` and just show the page), then the wireframes, then architect. **Never cut §3, and never
cut step 4 of §3** — the check finding a hole *and* then failing to find the last one is the honest
picture of what this tooling is worth.

## Things that will go wrong

| | |
| --- | --- |
| Docker not started | the tests and compose both die. Start it before you begin; it took ~40s on the rehearsal |
| you forgot to reset | `git reset --hard demo-start && git clean -fdx`, and start §1 again |
| 2 build warnings | the SSH.NET advisory above. Expected, kit-wide, say it in one sentence |
| an open draw.io tab | fine. It merges external writes live with no prompt — that is the demo's best visual. Just do not Ctrl+S in it, which reformats all 479 lines |
| the model looks wrong after an edit | `node tools/slice.mjs reflow <model>` re-derives every lane and routing y |
| an agent dies with **`API Error: 529 Overloaded`** | transient and server-side, nothing to do with the prompt. **Just relaunch it** — happened once on the rehearsal. Say "that's the API being busy" and move on; it is not a kit failure and not worth debugging on stage |
| an agent seems slow and says nothing | check the slice's files for `TODO(codegen)`. Still there after ~2 min = it died at launch **silently**, which is the other failure mode. Relaunch; do not wait |
| either way | the scaffold is untouched, so a relaunch starts from exactly the same place. Nothing needs cleaning up first |

---

## The frontend-design plugin — enable it before the demo

**It is on disk and not enabled**, which is why the rehearsal ran without it. The official Anthropic
marketplace is already added, so the plugin's files are cached locally:

```
~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/
  skills/frontend-design/SKILL.md
```

But it was **not in the session's available skills**, so `/styling` could not delegate to it. Enable it
with `/plugin` → `claude-plugins-official` → `frontend-design`, then reload the window.

**What the kit expects it to supply.** `styling`'s own instruction is *"delegate the aesthetics, own the
contract"*: it deliberately holds **no** design taste and adds only the field contract from the model,
the `designs/<slug>.html` convention and the review loop. The plugin holds the other half — the
token-system spec, deliberate display/body type pairing, "the hero is a thesis", grounding the design in
the subject's own materials and vernacular, an explicit instruction to *take one real aesthetic risk you
can justify*, and a list of templated AI defaults to avoid.

**What its absence cost on the rehearsal.** The design is defensible and passes the three-way field check
at 0/0, and its signature element is derived from the brief rather than from taste — *"twenty minutes or
ninety minutes is the whole difference"* becomes a monospace prep-time figure over a duration bar. But
the type is `system-ui` and a monospace stack, i.e. the safe default, and no real aesthetic risk was
taken anywhere. That is exactly the gap the plugin exists to close.

`styling` already says to tell the user when it is missing rather than pretend otherwise, which is what
happened — but for a demo whose purpose is showcasing the kit, running the design step *with* its
intended collaborator is plainly better than explaining why it is absent.
