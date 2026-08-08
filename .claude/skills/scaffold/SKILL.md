---
name: scaffold
description: Generate the deterministic skeleton of a system from its event model — solution, projects, event records, aggregates, view types, validators, the test harness and one failing test per GWT — and prove it compiles and runs. Use after the model validates and after `architect record`, or when the user says "scaffold", "generate the skeleton", "set up the project", or invokes /scaffold. Writes no business logic and spawns no agents; every hole is left marked TODO for codegen.
---

# Scaffold session

You run the generator and **prove the skeleton stands up**. That is the whole job.

You write no business logic, you fill no `TODO(codegen)`, and you spawn no agents. If you find
yourself making a judgement call about the domain or the stack, you are in the wrong skill.

## Why this is its own step, and where it sits

**`tools/codegen.mjs` is the scaffolder.** It emits everything mechanically derivable from the IR —
the solution, both projects, `Program.cs`, the event records, the aggregate folds, the view types,
the validators, the Alba harness and one test per GWT — and **no business logic at all**. The skill
called `codegen` is the one that *fills* it. Those are two different jobs with two different gates,
and running them as one hid both:

| | Produces | Gate | Judgement |
| --- | --- | --- | --- |
| **scaffold** (you) | the skeleton, every hole marked | **it compiles, and the tests run** | none |
| **codegen** | the business logic, one slice at a time | that slice's tests pass | the recipe, per slice |

**`architect` straddles you.** `architect.mjs record` needs only the model and must run FIRST (see the
type-binding note below). `architect.mjs tests` writes race tests **into the test project** and refuses if
there is none — `generated/<Sys> does not exist — run codegen first` — so that half follows you. The order:

```
event-model  →  architect record + answer  →  scaffold  →  architect tests  →  codegen  →  journey
```

**`architect record` must have run BEFORE you, for `type-binding`.** Views, aggregate folds and GWT tests
are all `scaffold`, so an unbound type baked into them on your first pass is KEPT on every later one and
`UNBOUND TYPE` goes quiet while it is still true — measured at 68 errors then 20 (KIT-FINDINGS Z6). If you
see `UNBOUND TYPE`, stop: record the bindings and regenerate from an empty `generated/`, do not re-run over
the top.

**Re-run after any model change**, and after `architect tests` — both are safe, because everything a
later run changes is `emit`. What is *not* safe is re-running to fix an unbound type, per the paragraph
above: that one needs an empty `generated/`.

## The steps

```bash
node tools/model.mjs validate          # 1. zero errors, or stop
node tools/model.mjs compile           # 2. -> <project>/build/<system>.ir.json
node tools/codegen.mjs                 # 3. the skeleton. Reports "N written, M kept"
cd <project>/generated/<System>
dotnet build                           # 4. THE GATE
dotnet test                            # 5. the second gate — needs Docker
```

**Do not skip 1.** Generating from a model that has not passed its own gate is building on a guess,
and the completeness check is the one thing standing between a wrong model and a wrong system.

`M kept` is hand-owned work the generator refused to clobber. On a first run it is 0. On a re-run it
should equal everything anybody has filled in — **if a re-run reports fewer `kept` than you expect,
stop and find out what was overwritten** before doing anything else.

## The gate — and it is the one the kit did not have

**`dotnet build` must return 0 errors and 0 warnings.**

That claim is written in CLAUDE.md as though it were a property of the generator. It is a *claim*, and
until this skill existed **nothing in the kit ever tested it**: `cart-replay.mjs` exercises the model
half and stops at the `.drawio`, and the reference implementations are committed C# that is never
regenerated. Two separate defects shipped through that hole and are recorded as KIT-FINDINGS **W6**
(an automation label of more than one word emitted as a C# class name) and **W9** (a domain type
emitted verbatim as a C# type, 68 errors). **Your build is that missing check.**

Then `dotnet test`, and read the counts rather than the colour:

| | Means |
| --- | --- |
| `Failed: N` where every failure is `NotImplementedException` / an unfilled scaffold | **correct.** One live failing test per GWT on a claimed slice is the contract in executable form |
| `Skipped: M` | slices still `in-design`. `status=` bakes the skip in at scaffold time, and the skip count is the honest measure of what is left |
| a failure that is **not** an unfilled scaffold | a real defect in the generator or the model. Report it, do not work around it |
| `DockerUnavailableException`, failing in ~1ms | **environment, not a finding.** Say Docker is down and move on |

If the build fails, **the defect is in the generator or in the model — never in the output.** Do not
hand-edit a generated file to make it compile: `emit` files are overwritten on the next run, so the
fix would vanish, and a `scaffold` file that needs editing to *compile* is a generator bug. Find the
cause, say where it is, and fix the tool.

## Reports to act on, not to skim

`codegen.mjs` prints these because they name things a green build cannot see:

| | |
| --- | --- |
| `UNBOUND TYPE` | a domain type with no C# binding, emitted verbatim. **Always a defect** — `architect record` should have run first. Do not re-run over the top; record the bindings and regenerate from an empty `generated/` |
| `GWT WITHOUT A TEST` | a rule added after the test file was scaffolded. Test files are hand-owned, so the generator will not append — write it by hand |
| `TESTS STILL SKIPPED ON A CLAIMED SLICE` | the skip was baked in while the slice was `in-design` and never came off. Delete the `Skip` argument |
| `IMPLEMENTED BUT STILL UNCLAIMED` | the work is done and `status=` never moved |
| `VIEW WITH NO REGISTRATION` | the projection exists and nothing runs it. No symptom whatsoever: clean build, clean startup, no table, and a load returns null |
| `AUTOMATION NOT WOKEN` | nothing runs the slice in production, and its tests still pass |
| `ARCHITECTURE DECISIONS MISSING` | expected on the first pass — `architect` has not run yet |

**Report every one of them to the user.** Several are *correct* at this point in the workflow, and
saying which are expected and which are not is most of your value.

## What you must not do

- **No business logic.** Not even an obvious one-liner. Every hole stays `TODO(codegen)`.
- **No agents.** `backend-agent` and `frontend-agent` belong to `codegen`, per slice.
- **No model edits.** If the model is wrong, say so and hand it back to `add-slice` or `event-model`.
- **No architecture decisions.** If the skeleton raises a consistency or concurrency question, that is
  `architect`'s, and it runs next.
- **No hand-editing generated files**, for the reason above.

## Report

- `N written, M kept`, and the file count by kind
- **the build result verbatim** — errors and warnings, not "it built"
- the test counts, and which failures are unfilled scaffolds versus real
- every report that fired, each marked *expected here* or *needs attention*
- what the model made impossible to generate, if anything

Then say the next step out loud: **`architect tests`**, because the system now has somewhere for its
race tests to live.
