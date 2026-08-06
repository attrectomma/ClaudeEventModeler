---
name: codegen
description: >-
  Implement one vertical slice of an event model as working, tested, full-stack code — .NET 10,
  Wolverine, Marten, FluentValidation, Postgres, Testcontainers, Alba, React + TypeScript. Use when
  the user wants to build or implement a slice, says "implement X", "build the <slice-name> slice", or
  invokes /codegen. Runs AFTER event-model, and after styling for any slice with a screen. Sequences
  the backend-agent and frontend-agent and enforces the gates; does not write the code itself.
---

# Codegen session

You **sequence and gate**. `backend-agent` and `frontend-agent` do the work.

That split is not an arbitrary tidiness: the model already declares it. `owner="frontend-agent"` is on
the UI lane, `owner="backend-agent"` on Commands / Views and the Event Stream, and
`conway/slice-crosses-teams` reports on every run which slices need both. Doing both halves yourself
would mean the kit computing a fact and ignoring it.

**One slice, all the way down, until `dotnet test` is green and somebody has looked at the page.** Not
one layer across many slices.

## Before delegating anything

1. **`node tools/model.mjs validate` at zero errors.** Implementing against a
   model that has not passed its own gate is building on a guess.
2. **`node tools/docs.mjs status`** — all three libraries mirrored. `sync` if not. The backend agent
   depends on this and cannot fix it.
3. **Pick the slice with the furthest `status=`** — `ready` if one exists. Set it to `in-progress` and
   **work on its own branch**: `status` is advisory, a branch is the only exclusion git offers.
4. **`node tools/codegen.mjs`** — reports `N written, M kept`. `kept` files are
   hand-owned and will not be clobbered.
5. **Read the slice's contract out of the IR** and hand it over rather than making each agent
   rediscover it:

```bash
node tools/model.mjs compile    # -> build/<system>.ir.json
```

The slice's `commands`, `emits`, `screen`, and its GWTs with their `enforce=` — plus the stream's
`identity=` — are the brief.

## The handoff

**The GWT band is deliberately unowned.** The rules are the contract *between* the two sides, and the
generated failing tests are that contract in executable form. So the handoff is not a document you
write; it already exists.

| | Owns | Needs from the other |
| --- | --- | --- |
| `backend-agent` | folds, endpoints, validators, projections, tests | nothing |
| `frontend-agent` | the React port, the API client | route, request shape, response codes, rule names |

**Backend first, then frontend** — for one slice, sequentially, because the frontend wants the real
contract rather than a predicted one and the cost of waiting is minutes.

They are *separable* though, not *ordered by necessity*: the API shape is derivable from the model
alone (command `fields` → request, view `fields` → response). That is what makes a parallel fan-out
possible later without redesigning anything, which is the standing principle — keep it simple, prepare
for evolution.

Pass each agent: the slice name, the system folder, and the relevant slice of the IR. Do not paste the
whole model.

## The pattern does not choose the implementation — make the agent choose, out loud

`pattern=` names one of the four shapes. It is a **contract**: which blocks connect, in which
direction. It never says which library recipe realises them, and for `command`, `view` and `automation`
there is a real choice with real consequences.

| `pattern=` | The choice | Worked comparison |
| --- | --- | --- |
| `command` | aggregate handler workflow vs. explicit `FetchForWriting`; endpoint vs. message; `StartStream` when the slice creates | `reference-implementations/state-change/` |
| `view` | live aggregation, single-stream, `EventProjection`, multi-stream, flat table, composite — six recipes, and `identity=` narrows but does not decide | `reference-implementations/state-view/` |
| `automation` | what wakes the trigger: forwarding, subscription, `RaiseSideEffects`, clock | `reference-implementations/automation/` |
| `translation` | the automation choice, plus how the foreign event lands | — |

Two things follow, and both are yours to enforce:

**The reference implementations are worked examples, not the menu.** They record what a choice *cost*
on the model they were built against. The set of options lives in the library's own docs —
`reference/llms/marten/…`, `reference/llms/wolverine/…` — and each reference implementation covers only
some of them. An agent that copies the nearest reference implementation without checking the mirror for
a closer fit has skipped the decision, not made it.

**A slice that does not state its choice is not finished.** No checker can see a wrong one: the model
validates, the code compiles, the tests pass. So require in the report *which* recipe, *why*, and what
it costs — a daemon, eventual consistency, a rebuild hazard. Then carry that sentence into the commit
message, because it is the only place the reasoning will survive.

## Gates — yours to enforce, not theirs to claim

| | Must be true |
| --- | --- |
| Backend | `dotnet test` green, and the slice's tests **LIVE not skipped** |
| Coverage | `codegen` prints no `GWT WITHOUT A TEST` — see below, this one is not implied by green |
| Reads | anything the screen `displays=` can actually be fetched |
| Choice | the report names the implementation recipe chosen and why. "Same as the reference implementation" is not an answer unless the mirror was checked |
| Frontend | `tsc` clean, `design.mjs check` clean, and **the render has been looked at** |
| Model | `model.mjs validate` still zero errors — implementing must not have needed a model change nobody made |

Verify these yourself. An agent reporting success is a claim, and the whole kit is built on not taking
claims for verification.

**A green run does not mean every rule has a test.** Test files are `scaffold` — written once, then
hand-owned — so a GWT added to a slice that is *already implemented* gets no test, fails nothing, and
is skipped by nothing. That is the normal case whenever the domain expert answers an open question
about a slice that is already green. `codegen` compares the model's GWTs against the kept test file and
lists the missing ones; the fix is to write them by hand, because a generator must not append into a
file somebody else owns. ANTI-PATTERNS.md #13.

Then promote the slice past `in-progress` and **stop**. Do not start a second slice in the same
session: the point of one-at-a-time is that the second one tells you what the first cost.

## What a slice legitimately needs from its neighbours

A State Change slice is screen → command → event, and the screen reads a View another slice owns. So
finishing one slice end to end may require a **minimal read endpoint** belonging to a neighbour.

Add the minimum, mark clearly which slice it belongs to, add no rules to it — so promoting that slice
later means adding its GWTs rather than undoing this work. Say plainly that you did it.

## Running the thing by hand

```bash
docker compose up -d                              # the human's Postgres, port 5433
ASPNETCORE_ENVIRONMENT=Development dotnet run --project src/<Sys>   # env VAR, not --environment
npx vite --port 5173 --prefix web                 # proxies to the API
```

Tests use **Testcontainers**; the demo uses **docker-compose**. They never share a connection string,
and nothing in the test project reads the compose file. Marten manages schema, so a test run pointed
at the demo database drops the data you were halfway through creating.

Stop everything you started before reporting.

## Report

What the slice cost, honestly, and in comparison to the previous one: files written, build and test
iterations, API facts discovered, what was reused unchanged. **That number is the measure of whether
this kit works** — the first slice cost ~16 files and eight build iterations; the second cost four
files and one.
