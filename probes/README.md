# probes — runnable proofs of stack behaviour

A probe answers *"does this stack actually do X?"* by **running**, not by reading. `CLAUDE.md`'s escalation
is **read the mirror → grep the package `.xml` → compile**, and a probe is the last step made repeatable.

These are kept rather than thrown away when what they proved is something a future session would otherwise
have to rediscover — or when the probe is the template for a shape the kit should generate.

| Probe | Answers | Needs |
| --- | --- | --- |
| `concurrency-invariant.cs` | can *"two members at the same instant must not both succeed"* be tested? Yes — in **two** forms, with a control that proves the tests bite | Postgres on 55432 |
| `harness-check.cs` | does the `ConcurrencyHarness` that `architect.mjs` scaffolds actually work, rather than merely compile? | Postgres on 55432 |
| `rejection-shape.cs` | does an ASP.NET ProblemDetails customiser fire on the path Wolverine's FluentValidation middleware takes, and does it leave `errors` intact? **Yes to both** — so a periphery and a decider rejection can be made to agree on `title` | nothing — no Marten, no Postgres |
| `conflict-status.cs` | does a lost race on the HTTP arm actually return **409** rather than 500? **Yes** — measured on the wire with a control that reproduces `500 x7` first, then `409 x6` with the emitted handler and the winner still 204 | Postgres on 55432 |
| `retry-budget.cs` | how many concurrent writers to ONE stream survive the emitted `RetryTimes(3)`? **Four–five.** Above that work is silently lost, and `RetryWithCooldown` moves the cliff by one writer rather than fixing it. **Partitioned local messaging fixes it outright — 16/16 — but only with an EXPLICIT `ByMessage` rule**: `UseInferredMessageGrouping()` alone yielded `group=(NONE)`, which makes Wolverine pick a queue at random and is worse than not configuring it (KIT-FINDINGS **V12**) | Postgres on 55432 |

## Running one

They are .NET 10 **file-based apps**, so there is no project to restore:

```bash
docker run -d --name em-probe -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concpoc -p 55432:5432 postgres:16-alpine
dotnet run probes/concurrency-invariant.cs
docker rm -f em-probe

dotnet run probes/rejection-shape.cs    # no container: it starts two Kestrel hosts on 5199/5200
```

Exit code 0 means every check passed; the output names each one either way.

## Three file-based-app rules, each paid for once

- **`#:property PublishAot=false` is mandatory for anything touching Marten.** File-based apps disable
  dynamic code generation and Marten's `StoreOptions` constructor reaches `Reflection.Emit`. Without it:
  `PlatformNotSupportedException` (KIT-FINDINGS A2).
- **Every type declaration goes AFTER the top-level statements**, or `CS8803`.
- **Document types must be `public`.** Top-level types in a file-based app are implicitly internal, and
  Marten generates a *public* storage provider over the document type — so an internal one fails runtime
  codegen and surfaces as a wall of generated C# rather than as the real cause.

## Why a probe rather than a test

A test belongs to a project and asserts that project's behaviour. A probe asserts the **library's**
behaviour, so it has no project to live in and no model behind it — and it is the right answer to *"the
docs say X, is X true on the version we pinned?"*. `concurrency-invariant.cs` exists because the docs said
`ConcurrencyException` and the runtime says otherwise.

## A probe that answers "did my fix work?" MUST CARRY THE CONTROL

Every probe here asserts the *before* as well as the *after*, in the same run, and that is not thoroughness
— it is the only thing separating *"the fix worked"* from *"there was never anything wrong."*
`rejection-shape.cs` is the clean case: had its control failed to reproduce the two different response
bodies, KIT-FINDINGS **BP1** would have been the mistake and the customiser would have been a fix to
nothing. The probe says so out loud rather than only exiting 0.

The sibling rule: **assert the payload, not the status code.** Both rejection paths return `400`, so every
status assertion passes on both and proves nothing. A probe whose checks cannot fail is worse than no probe,
because it is quoted afterwards as evidence.
