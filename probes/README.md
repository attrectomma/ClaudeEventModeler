# probes — runnable proofs of stack behaviour

A probe answers *"does this stack actually do X?"* by **running**, not by reading. `CLAUDE.md`'s escalation
is **read the mirror → grep the package `.xml` → compile**, and a probe is the last step made repeatable.

These are kept rather than thrown away when what they proved is something a future session would otherwise
have to rediscover — or when the probe is the template for a shape the kit should generate.

| Probe | Answers | Needs |
| --- | --- | --- |
| `concurrency-invariant.cs` | can *"two members at the same instant must not both succeed"* be tested? Yes — in **two** forms, with a control that proves the tests bite | Postgres on 55432 |

## Running one

They are .NET 10 **file-based apps**, so there is no project to restore:

```bash
docker run -d --name em-probe -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concpoc -p 55432:5432 postgres:16-alpine
dotnet run probes/concurrency-invariant.cs
docker rm -f em-probe
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
