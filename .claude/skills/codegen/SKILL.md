---
name: codegen
description: >-
  Implement one vertical slice of an event model as working, tested, full-stack code — .NET 10,
  Wolverine, Marten, FluentValidation, Postgres, Testcontainers, Alba, React + TypeScript. Use when
  the user wants to build or implement a slice, says "implement X", "build the book-hours slice", or
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

1. **`node tools/model.mjs validate diagrams/<system>/` at zero errors.** Implementing against a
   model that has not passed its own gate is building on a guess.
2. **`node tools/docs.mjs status`** — all three libraries mirrored. `sync` if not. The backend agent
   depends on this and cannot fix it.
3. **Pick the slice with the furthest `status=`** — `ready` if one exists. Set it to `in-progress` and
   **work on its own branch**: `status` is advisory, a branch is the only exclusion git offers.
4. **`node tools/codegen.mjs diagrams/<system>/`** — reports `N written, M kept`. `kept` files are
   hand-owned and will not be clobbered.
5. **Read the slice's contract out of the IR** and hand it over rather than making each agent
   rediscover it:

```bash
node tools/model.mjs compile diagrams/<system>/    # -> build/<system>.ir.json
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

## Gates — yours to enforce, not theirs to claim

| | Must be true |
| --- | --- |
| Backend | `dotnet test` green, and the slice's tests **LIVE not skipped** |
| Reads | anything the screen `displays=` can actually be fetched |
| Frontend | `tsc` clean, `design.mjs check` clean, and **the render has been looked at** |
| Model | `model.mjs validate` still zero errors — implementing must not have needed a model change nobody made |

Verify these yourself. An agent reporting success is a claim, and the whole kit is built on not taking
claims for verification.

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
