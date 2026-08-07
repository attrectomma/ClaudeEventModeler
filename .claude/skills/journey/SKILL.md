---
name: journey
description: Write the backend journey tests for a system — one test walking several slices end to end through the real API. Use when two or more slices are in-review and the user wants composition tested, says "add a journey", "journey tests", "test the whole flow", or invokes /journey. Runs AFTER codegen for the slices it walks. It never appends an event, and that restraint is the whole point.
---

# journey — the layer above a slice

**Every other test this kit produces is a single slice's scenario.** A GWT appends its GIVEN straight to the
stream and asserts one outcome; a GT appends events and asserts one read model. That is the right shape for a
slice, and it means **no generated test has ever driven two commands in a row through HTTP.**

So a slice pair that each pass alone and cannot be **composed** has nowhere to be caught:

| | |
| --- | --- |
| an id minted in one shape and read in another | every GWT starts from a hand-appended GIVEN, so nothing ever consumes a real response |
| a projection current for its own slice and stale for the next | each slice asserts its own view, in its own test, with its own events |
| a rule that only bites on the **second** command in a sequence | a GIVEN is history, so the first command is always the first command |

All three pass a green per-slice suite. That is what this skill is for, and it is the kit's own documented
KNOWN GAP.

**Backend only, and this skill does not write the other half.** The UI journey layer is `ui-journey`, which
walks the **same `em="journey"` cell** through a browser instead of through HTTP — one story, one cell, two
wires. Write this one first: a browser walk that fails because two slices cannot compose is the most expensive
possible way to learn that.

## When to run

**After two or more slices are `in-review`.** Earlier and the journey fails for reasons that have nothing to do
with composition — `journey-slice-in-design` warns about exactly that.

A journey belongs to the **system**, not to a slice, which is why neither `codegen` nor a slice's own agent
owns it. If a journey fails, the fix may be in any slice it walks, or in none of them.

## 1 — name the journey on the model

A journey is a fact about the system, so it is a cell. Never a file, never a list in a test.

```
node tools/slice.mjs journey <model> --journey <slug> --slices "<a, b, c>" \
     --then "<View(field=value, …)>" --label "<the story, in a sentence>"
```

It draws a bar below the GWT lane, spanning the columns it walks — so a journey that spans the whole model is
visibly telling you something. **`slices=` is the order**, not the geometry: a journey may revisit a column,
so position gives extent and only the list gives sequence.

**Ask the user which journeys are worth walking.** This is a domain question and the skill invents nothing.
The prompt that works: *"a new user arrives and does what, in what order, before they see something they
care about?"* One journey per story. A suite of thirty is a suite nobody keeps working.

`--then` reuses the GWT example-data grammar unchanged — a journey is a GT at system scale: GIVEN an empty
system, WHEN this sequence, THEN this read model.

Then `node tools/model.mjs validate`:

| Rule | |
| --- | --- |
| `journey-needs-slices`, `journey-unknown-slice` | error — nothing to walk, or a name that is not a slice |
| `journey-too-short` | error — one slice is a slice test, and this layer exists because those cannot see composition |
| `journey-runs-backward` | **warn** — either the columns tell the story in a different order than the journey walks it, or the journey revisits a column on purpose. Both legitimate; only one is worth reordering the model for |
| `journey-slice-in-design` | warn — walking a slice nobody has built |
| `journey-needs-then` | warn — a walk with no outcome tests only the absence of exceptions |

## 2 — generate

```
node tools/codegen.mjs
```

Scaffolds `tests/<System>.IntegrationTests/Journeys/<Name>JourneyTests.cs` — one per journey, kept on
regeneration like every other scaffold. With no journeys at all, codegen says so, because "no journey tests"
is a fact about a system worth printing rather than an absence nobody notices.

## 3 — write it, and obey the one rule

**No step may append an event.** No `Given(...)`, no `session.Events.Append`, no `StartStream`, no seeding
between steps. A slice's GWT is allowed to append its history because history is exactly what a GIVEN means; a
journey may not, because the whole question is whether step two can live on what step one **actually left
behind**.

It is an easy and tempting edit — step four fails, appending the missing event makes it pass, and the test goes
on looking like a journey while testing one slice. `codegen` reports it by name:
`JOURNEY APPENDS ITS OWN HISTORY`.

Two things that each cost a failure the first time this was written:

**Use the ids the API hands back.** Reading `messageId` out of step two's response and using it in step three
is what makes this a journey rather than three requests in a row. Assert on your own variable and the test
cannot see a slice that echoes something subtly different — which is the first failure class on the list above.

**Wait for the daemon if the outcome is an Async view.** `WhenPosting` wraps each request in Wolverine's
`ExecuteAndWaitAsync`, which blocks until all *cascading message* work is done and knows nothing about Marten's
async daemon. An `Inline` view is assertable immediately; an `Async` one needs
`await Store.WaitForNonStaleProjectionDataAsync(timeout)` — an extension in `Marten.Events.TestingExtensions`,
which no doc page states.

**The tell is a partial result, not an empty one.** The measured failure was `Queued == 1, Delivered == 0`: the
daemon had caught up as far as step two's event and not step three's. Zero for everything is a broken journey;
some-but-not-all is a wait you have not done. A journey has the longest gap in the suite between the first
write and the last assertion, so this bites hardest here and is easiest to misread as a composition bug.

## 4 — the gate

| | |
| --- | --- |
| `dotnet test` | the journey passes **and** every slice test still does |
| `codegen` | prints no `JOURNEY APPENDS ITS OWN HISTORY` |
| `model.mjs validate` | no journey errors |

**A journey that passes first time has told you something too** — that the slices compose. Do not add steps
until it fails; add the next journey.

## What this cannot do

It walks the API, so it cannot see anything between the screens: whether you can get from the list to the
modal to the created thing. The pager-not-in-the-URL bug was found by screenshotting, not by a test, and this
layer would not have caught it either.

**That is `ui-journey`'s half**, and it reads the same cell you just named — so if this story is also worth
clicking through, say so when you hand back. It is manually invoked and expensive, so offer it; never start
it.

## Worked example

`reference-implementations/state-view/campaigns/` — `campaign-lifecycle`, walking
`open-campaign → queue-message → record-outcome` and ending on the `CampaignDashboard`. Three real POSTs, the
message id taken from step two's response, an async-daemon wait, and one assertion that also happens to be the
only place in the project where two stream types are proved to roll up onto one row after a **real sequence**
rather than a hand-appended one.

Note which slice is **not** in it: `close-campaign` is drawn in column 2, beside `open-campaign`, because they
share the Campaign stream — but the story closes last, so including it warns `journey-runs-backward`. That
warning is the model telling you its columns are grouped by stream while its story runs in another order.
Neither is wrong, and it is exactly the kind of thing only a journey asks.
