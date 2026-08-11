---
name: ui-journey
description: >-
  Walk a workflow across SCREENS in a real browser with Playwright — everything between the screens
  that no other check in this kit can see. Use when the user says "ui journey", "browser test", "test
  the flow in the UI", "click through it", or invokes /ui-journey. Manually invoked only, because it is
  expensive — nothing schedules it and nothing gates on it existing. Runs AFTER codegen has built two or
  more slices with screens, and after `journey` if the same story is walked at both levels.
---

# ui-journey — everything between the screens

**Never run unless the human asked for it.** This skill starts containers, drives a browser, and takes
minutes. Nothing schedules it, `codegen` does not call it, and no gate anywhere fails because a UI
journey is missing. That is deliberate, and it is the same reasoning that keeps `journey` unscheduled:
which workflow is worth walking is a domain answer.

## What this covers that nothing else does

The kit had three nets under the UI and a hole between them:

| | Holds | Sees |
| --- | --- | --- |
| `model.mjs validate` | `displays=`/`inputs=` ↔ wireframe `binds=` | one screen, in the model |
| `design.mjs check` | the model ↔ the styled page ↔ **the React port** | one screen, at rest |
| `review.mjs sheet` | the design beside the built screen, 1:1 | one screen, in a picture |
| `journey` | several slices end to end **through HTTP** | composition **behind** the API |
| **this** | several screens end to end **through the browser** | composition **in front of** it |

Every one of the first three checks a screen **at rest**. Nothing proved you could get from the list to
the modal to the created thing — and the bug that proves the hole is worth closing was found by
*screenshotting*, past 32 passing tests: shots of `/` and `/?page=2` came back **identical**, because the
pager was component state that never reached the URL. A page could not be linked, bookmarked, or survive
a refresh. No test noticed and no design page could have shown it.

**And it buys back a capability the kit had written off.** `frontend-agent` says, correctly, that
*"headless Chrome screenshots a URL, it does not click — a mode you can only reach by clicking is
unverified visually."* So a modal over a list, page 2, a rejected form and an in-flight button were
states nobody could look at. A journey that clicks can shoot them, and `journeys/_shot.ts` writes them
into `<project>/review/_shots/` under the name `review.mjs` already parses — so they turn up **beside the
agreed design** in `review/index.html` with no extra step. That is often the biggest single thing a run
produces.

## Why Playwright, when CLAUDE.md says "no Playwright, no Puppeteer"

That sentence is about `design.mjs`, and it is still true there: shooting a URL needs nothing but the
Chrome already on the machine. **A journey clicks, and nothing on this machine clicks.** Three things
come with Playwright that are not conveniences:

- **a real 390px layout viewport**, from device metrics. `shoot.mjs` needs an `<iframe>` to get one,
  because Windows will not make a Chrome window narrower than ~500px and Chrome silently lays out at 500
  and crops to 390 — every sub-500px shot this kit produced before that fix was a lie (KIT-FINDINGS A1).
  Playwright does not have the problem, so **there is no excuse for a desktop-only run.**
- **retrying assertions**, which are the only way to say *"eventually consistent"* out loud instead of
  confusing it with broken — the UI half of the async-daemon wait a backend journey needs.
- **a trace of a failing run.** A UI journey that breaks may be broken in any slice it walks, or in none
  of them; the trace is how a human finds out which.

The cost: one devDependency in the **project's** `web/package.json`, not the kit's. It runs the installed
Chrome or Edge by channel, so there is no browser download.

## 1 — find the workflow, and do not invent it

```
node tools/uijourney.mjs plan
```

**A journey is a cell on the model**, the same `em="journey"` cell the backend `journey` skill uses.
There is no separate UI-journey notation and there must not be: the story is one fact, so a story named
once is walked at both levels — through HTTP by `journey`, through the browser by this skill. A journey
whose slices have no screens is a backend journey and only a backend journey, and `plan` says so rather
than treating it as a gap.

**With no journey named, `plan` derives the candidates from real edges.** Slice A leads to slice B when an
event A appends feeds a view that feeds B's screen — that is the View pattern read forwards, not a guess.
It prints each candidate with the `slice.mjs journey` command that names it. **Bring the list to the user
and let them choose.** The prompt that works:

> *"A new user arrives and does what, in what order, before they see something they care about?"*

One journey per story. A suite of thirty is a suite nobody keeps working.

**Read what `plan` gives you before writing anything.** For every screen on the walk it prints the design
page, `displays=`, `inputs=`, the commands, and **the exact `data-em` selectors the port is allowed to
have** — plus every rule name a rejection on those slices can surface, and which wire shape `enforce=`
says it arrives in.

### The one thing `plan` cannot tell you, and it will ask

**The model does not say how a user reaches a screen.** It says which screens exist, what they show, and
what they offer; there is no notation for *"the modal opens from the list"* or *"the detail page opens
from a row"*, and this skill does not invent one. `plan` flags every screen no data path reaches — a
modal, a blank form, the entry point — and asks. **Ask the user, then write the answer into the spec's
own doc comment**, because that comment is then the only place in the system where it is recorded. Same
treatment the kit gives an implementation-choice sentence: unrecordable in the model, so state it out
loud where it will survive.

## 2 — scaffold

```
node tools/uijourney.mjs scaffold [--journey <slug>]
```

Writes, into the **project** (committed, like everything under `generated/`):

| | | |
| --- | --- | --- |
| `web/playwright.config.ts` | **scaffold** — kept | which origin is the app, which browser |
| `web/journeys/_shot.ts` | **emit** — overwritten | the shot path, the clear, the silent-failure watcher |
| `web/journeys/tsconfig.json` | **emit** — overwritten | nothing; it exists because Playwright does not typecheck |
| `web/journeys/<slug>.journey.spec.ts` | **scaffold** — kept | the walk, and every judgement in it |

Then add the dependencies the tool prints — in the project's `web/package.json`, never the kit's.

**Typecheck the specs, because Playwright will not.** It transpiles TypeScript and never checks it, so a
type error in step 4 surfaces only when step 4 runs — and step 4 is exactly what does not run when step 2
fails. The scoped tsconfig exists for this and leaves the app's own `npm run typecheck` alone (the app sets
`types: ["vite/client"]` and excludes `journeys/`, both of which are right for a browser build):

```
npx tsc -p journeys --noEmit
```

## 3 — the one rule, in two halves

A backend journey's rule is *no step may append an event*. This is the same rule on the other side of the
wire, and it has two halves because a browser has two ways to cheat:

**NO STEP MAY FAKE THE BACKEND.** No `page.route`, no `fulfill`, no `addInitScript`, no `localStorage`
seeding, no API call to set up step three — and **no `/harness/`**. That last one is the sharp one:
`web/harness/` exists precisely to make a hard state *lookable*, and it fakes transport to do it. Right
for looking; fatal here, because the question is whether the state can be **reached**.

**NO STEP MAY SKIP THE NAVIGATION IT IS TESTING.** Reaching step three by typing its URL is the exact
equivalent of a backend journey appending its own GIVEN: the test still passes and has stopped asking the
only question it was for. It is the first thing anyone reaches for when step three fails.

**A deep link is legal after a click has proved the app produces it.** That is not a loophole — it *is*
the pager test.

Both halves are reported by name:

```
node tools/uijourney.mjs check
```

### Reaching the starting position: the line is the SLICE LIST, not the transport

*"No step may fake the backend"* is about **stubbing** — `page.route`, `fulfill`, `localStorage` seeding,
`/harness/`. Using the real API to establish history is not faking, and the backend `journey` skill records
exactly that for its `open-site` call.

**That ruling was under-specified, and `check` was right where it contradicted it.** The refinement, learned
on `bay-out-and-back`:

> **A real endpoint reaching a position no slice of the chapter covers is legitimate. Reaching a position a
> NAMED slice covers is skipping the walk — whatever the transport.**

`commission-bay` was that chapter's **first slice**. POSTing to it is not faking the backend, and it is still
wrong: the chapter names the slice, so that slice's *screen* is part of what the walk exists to prove.
Clicking `estate-admin` instead cost a second, removed the argument, and made the story better — four screens
with the Estate Manager bookending it.

The backend journey's `open-site` call stays legitimate under the same rule, because `open-site` is **not** in
its slice list.

## 4 — shots are the proof of an assertion, and the folder is the last run

**Assert, then shoot, in that order, for every state the walk reaches.** An assertion is a claim the suite
can check and a human cannot see; a screenshot is exactly the reverse. Pairing them is what makes the run
reviewable — otherwise the suite goes green and the review sheet holds nothing about the states only this
journey could reach, which was the whole reason to pay for it.

**One shot per *state*, not per assertion.** Plenty of what a journey asserts has no picture: a URL that
changed, a console that stayed quiet, a button that is genuinely `disabled` rather than merely grey. So
several assertions pin a state and then one shot records it. One shot per screen walked is the **floor**,
not the target — a screen usually has more states worth seeing than one (the list, the modal over it, the
rejection, page 2).

`check` reports both directions: `SHOT WITH NOTHING ASSERTED ABOVE IT` names the line, and
`STATES ASSERTED BUT NOT SHOT` names a walk whose evidence is thinner than its screens.

**The folder is a snapshot of the last run, not an archive.**
`review/_shots/<screen>__<journey>-<state>-<viewport>.png` carries no timestamp and no counter, so a
re-run overwrites in place and nothing accumulates. The journey slug sits in the *state* segment on
purpose: `review.mjs` pairs a shot with its design **by screen slug**, so putting the journey first would
break the pairing, and putting it nowhere would let two journeys that both visit one screen silently
overwrite each other's evidence.

**Overwriting alone is not enough, and this is the part worth understanding.** If step 5 fails, steps 6–8
never shoot — so the folder would hold steps 1–5 from *this* run beside steps 6–8 from the *last* one, and
read as one coherent passing walk. That is strictly worse than accumulation, because it is plausible, and
it is the same failure as the screenshot of the state that never rendered. So the scaffold calls
`clearJourneyShots(...)` in a `beforeAll`: **a missing shot reads as missing.** It is scoped to this
journey and this viewport, because the two projects run the same file one after the other and another
journey's evidence is not this one's to discard.

**This is not `toHaveScreenshot()`, and do not reach for it.** That compares against a committed pixel
baseline and *fails* on a diff — wrong here twice over: aesthetic judgement belongs to a human with
`review.mjs`, and a pixel baseline over a real app with real data is flaky by construction. Shots are
evidence, never assertions.

## 5 — the bug cases this kit has actually met

Each of these is a measured incident, not a hypothetical. Walk the list; where one does not apply, say so
in the report rather than skipping it silently.

| | The bug, as it happened | What the journey does about it |
| --- | --- | --- |
| **state not in the URL** | `/` and `/?page=2` rendered **identically** — the pager was component state. Not linkable, bookmarkable or refreshable. 32 tests green | after every click-reached state: assert the URL changed, `reload()`, assert the state survived |
| **empty looks the same as broken** | a wrong nginx `proxy_pass` prefix made the API answer 404, and a 404 body is not a paged result — so the screen showed **an empty list with no error** | `watchForSilentFailure(page)`, and assert the screen has **real data**, not just a shell |
| **the seed never applied** | a missing `ASPNETCORE_ENVIRONMENT` left the demo seed off, giving an empty screen and nothing to explain why | identical symptom, identical guard — which is why the check is on the *absence of data*, not on the error |
| **a state that never rendered** | one state was silently not being rendered at all, so its screenshot was of the wrong thing and looked fine | **assert, then shoot** — see the section below. `check` reports both a shot with nothing asserted above it and a state asserted with no shot |
| **disabled looked live** | a disabled Cancel button looked completely enabled | assert `toBeDisabled()`. Appearance is `review.mjs`'s job; *state* is this one's |
| **stale read after write** | a view registered `Async` is stale for as long as the daemon takes; a page refetching straight after a POST renders stale data and reads as a UI bug | Playwright's `expect` retries, so this **passes and looks immediate**. If an assertion only passed on retry, **say so** — that screen needs a refetch or optimistic UI in production, which is a requirement, not polish |
| **the rule name never reaches the user** | a rejection arrives as `{errors:{Field:["Rule"]}}` from FluentValidation or `{title:"Rule"}` from the decider, and the UI must read both | assert the **rule name** is visible. Then a rejection in the browser and a failing GWT name the same thing |
| **only the dev server was tested** | Vite proxies `/api` itself, so it cannot see a wrong nginx prefix, an unapplied seed, or a runtime that cannot do Wolverine's codegen | the run that counts is against **compose**, not Vite. See step 5 |
| **mobile was never really run** | every sub-500px shot before `shoot.mjs` was a crop of a 500px layout: one wrong diagnosis, two rounds of CSS "fixes" to a correct page | run **both** projects. Playwright's 390px is honest, and responsive navigation is exactly where list → modal breaks |
| **a bad query value became a default** | `?page=abc` silently became page 1, because Wolverine returns `default(T)` for missing *and* unparseable | where a journey's screen carries query state, walk one bad value and assert it is refused rather than absorbed |

## 6 — run it, and run it against the deployed thing

Vite first if you like, because the loop is faster:

```bash
npx vite --port 5173                                   # with the API already running
cd <project>/generated/<System>/web && npx playwright test
```

**Then the run that counts.** A static design is not the software, and *the dev server is not the
software either*:

```bash
docker compose -f generated/<System>/docker-compose.yml up -d --build
PW_BASE_URL=http://localhost:8080 npx playwright test
```

Three of the bug cases in step 5 are only reachable here. Stop everything you started before reporting.

Then put the evidence where the human already looks:

```
node tools/review.mjs sheet
```

The journey's shots are already in `review/_shots/` under the right names, so the sheet picks them up and
`review/index.html` shows them beside the agreed design — including the states that were previously
unshootable.

## 7 — the gate

| | Must be true |
| --- | --- |
| `npx tsc -p journeys --noEmit` | clean. Playwright does not typecheck, so nothing else will |
| `npx playwright test` | green at **both** viewports, against **compose** |
| `uijourney.mjs check` | no `FAKES ITS OWN BACKEND`, no `SELECTOR NOT IN THE MODEL`, no `NEVER RELOADS`, no `SHOT WITH NOTHING ASSERTED ABOVE IT` |
| the slice suite | `dotnet test` still green — a UI journey must not have needed a backend change nobody reviewed |
| `review.mjs sheet` | shots of the click-only states are in `review/index.html`, **and you have looked at them** |
| the report | says which bug cases from step 5 you walked, and which do not apply and why |

**Look at the sheet yourself before handing it over.** The shots are the evidence for every assertion the
suite just made, and this kit's oldest rule is that a picture nobody has looked at is worth nothing. A green
run whose sheet shows the wrong screen is exactly the failure the assert-then-shoot order is guarding
against — and it only reveals itself to an eye.

**A journey that passes first time has told you something too** — that the screens compose. Do not pad it
with steps; write the next journey, or stop.

## What this still cannot do

- **It cannot tell you the design is wrong.** It asserts structure and reachability; whether the page
  *looks* right is `review.mjs` and a human, and that does not change.
- **It cannot see a screen nobody modelled.** Its selectors come from `displays=`/`inputs=`/the command
  edge, which is the point — but a page with un-modelled chrome is un-walked chrome.
- **It does not know your navigation.** That fact is not in the model, is not derivable, and lives only
  in the spec's doc comment. If that comment is missing, the next person has to re-discover it by
  clicking.

## Worked example

`plan` on the CPOC01 model, with no journey named, derives four candidates and ranks
`create-recipe → recipe-list` first — the two `in-review` slices. Named as `create-and-see`, the walk is
`new-recipe → recipes`, and `plan` immediately reports that **nothing derives how the user reaches
`new-recipe`**: it declares no `displays=` and no view feeds it, because it is a modal. The likely
arrival is `recipes`, the only screen on the walk fed by a view — so the story is really *list → modal →
list*, which is precisely *"you cannot get from the list to the modal to the created thing"*, and
precisely where the pager bug lives.
