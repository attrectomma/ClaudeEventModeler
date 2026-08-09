# State change — the aggregate handler workflow, twice

One slice, two implementations, the same four rules. `revise-subject` acts on a stream that **already
exists**, which is what Wolverine's aggregate handler workflow is for: `[WriteAggregate]` fetches the stream,
folds it live, hands the decider the state, and carries the stream's version into the append so the write is
optimistically concurrent.

```
drafting/            the model — 4 slices, 20 elements, 0 errors / 0 warnings / 6 notes
generated/           both implementations. 16 tests, stable across repeated runs
                     13 run; draft-history's 3 are implemented and SKIPPED — see below
```

| | Implementation | Transport | Identity from | A refusal is |
| --- | --- | --- | --- | --- |
| **1** | `ReviseSubjectEndpoint` | Wolverine.HTTP | the command member | `IResult` / ProblemDetails |
| **2** | `ReviseSubjectHandler` | none — a Wolverine message | the command member | an outcome object |

Every GWT is asserted against **both**, through one `Revise(via, …)` helper, so a rule that holds for one and
not the other is a failure rather than a footnote. The model does not choose the transport, so the transport
must not change the behaviour.

## What made this possible at all

**A single-field stream key** — which is what this model happens to have, and which is *not* a precondition
of the workflow. This README used to say `[WriteAggregate]` "reads one value, so a composite key has nothing
for it to read". **Retracted, measured false:** it reads a *member*, and a computed property is one, so
`reference-implementations/reservation/` runs the same workflow on a `(poolId, slotNumber)` key.
KIT-FINDINGS **BM1**. Two generator changes still followed from this model, both derived rather than assumed:

- `StreamIdentity` is now `AsGuid` when every band has one `Guid` identity field, `AsString` otherwise.
- a single-field key **is** the field. It used to be `$"email:{id}"`, and a prefixed key can never equal the
  `emailId` a command carries, so even a single-field key blocked the workflow while it was decorated.

That also dissolved an older wart: the view's document id now *is* the `emailId` the model declares, instead
of being 1:1 with it but not equal.

## What the two implementations actually differ on

**The conventions are unusable here, and that is a kit problem, not a Wolverine one.** Both of Wolverine's
identity conventions key off the *aggregate type name*: `[Aggregate]` wants a route argument called
`<AggregateType>Id`, plain `[WriteAggregate]` wants a command member of the same shape. The fold here is
`ReviseSubjectState`, so both hunt for `reviseSubjectStateId` and fail with
`Unable to determine an aggregate id for the parameter 'draft'`.

That is not an accident of this example. **The kit names folds per slice on purpose** — aggregates are per
slice, not per stream — and that naming defeats both conventions. The alternatives were an ugly route
(`/emails/{reviseSubjectStateId}/subject`) or naming the fold after the stream and losing the per-slice
property. Naming the identity explicitly, `[WriteAggregate(nameof(ReviseSubject.EmailId))]`, costs nothing and
survives a rename — so it is the better form even where a convention would have worked.

**A missing stream is silent on the message path.** Required by default, an HTTP endpoint answers 404 — but a
*message* handler "logs that the aggregate was not found and stops processing". The message is discarded. A
GWT saying `then="error: NotDrafted"` would then be unobservable: nothing fails, nothing returns, and the rule
quietly does not exist. `Required = false` is not a preference here; it is what makes the rule assertable.

**A periphery rule holds on BOTH paths — and I expected the opposite.** The guess was that
`UseFluentValidation()` only wires the HTTP middleware, so a direct message caller would slip past
`SubjectRequired`. It does not: Wolverine validates message handlers too. Good news for the kit —
`enforce="periphery"` is a property of the slice, not of a transport. What differs is the *shape* of the
failure, sharply:

| Path | A periphery violation is |
| --- | --- |
| HTTP | 400 + ProblemDetails, rule name in `errors`, `Title` generic |
| message | a **thrown** `FluentValidation.ValidationException` |

So a caller of the message path cannot treat a rule violation the way it treats `NotDrafted` — those come back
as an outcome, this one is thrown, and nothing in the model says so.

## Return shapes: three attempts, and the middle one is the dangerous one

In this workflow a returned value is **appended as an event**, which makes the return type load-bearing.

| Attempt | Result |
| --- | --- |
| `out SubjectRevised?` on the handler | Wolverine codegen refuses: `CS1615`. The generated handler failed to **compile**, which took the whole host down and every HTTP test with it |
| `(SubjectRevised?, ProblemDetails?)` | a null event is still handed to Marten: `ArgumentNullException (Parameter 'eventData')` |
| `(Events, ProblemDetails)` + `[EmptyResponse]` | compiles, runs, and **silently ignores the refusal** — `[EmptyResponse]` forces 204 and the ProblemDetails never reaches the wire |
| `(IResult, Events)` | correct — and note the order: **response first, `Events` second** |

The third row is the one worth remembering: the endpoint reported **success for a rejected command**, and only
a test that asserted the refusal caught it. `[EmptyResponse]` is fine for a slice that cannot refuse and
actively dangerous for one that can.

`Events` is the explicit "these go on the stream" collection; an empty one is how a decider says it decided
against. It leaves the other slot free to be the actual response.

## The repeated-group row shape — `DraftHistory`

The kit's only demonstration of a read model whose row carries a **header and its child lines**. It exists
because that used to have to be modelled as two views, which is an anti-pattern: a screen fed by two views
is a smell, and the child view cannot answer a parent that has no children yet.

```
identity="emailId"
fields="emailId:Guid, subject:string, revisions:Revision[]"
children="Revision: revisedTo:string, revisedAt:DateTimeOffset"
mappings="revisedTo=subject"
```

**Three answers to "what is one row", from the same two events**, which is the comparison worth having:

| View | One row is | Recipe | Can answer "a draft with no revisions" |
| --- | --- | --- | --- |
| `MyDrafts` | one draft, **flattened** to current state | `SingleStreamProjection`, Inline | yes, and it is the only row |
| `DraftHistory` | one draft, **with its history inside it** | `SingleStreamProjection`, Inline | **yes — with an empty group** |
| `DeliveryLog` (in `state-view/`) | one **child** | `EventProjection` | **no. There is no row at all** |

**The recipe was not a real choice, and that is the finding.** `identity="emailId"` says one row is one
draft; the swimlane says a draft *is* a stream keyed by `emailId`; so one row is exactly one stream and the
grouping needs no rule. A repeated group is a **property of the row, not a second grouping** — which is the
sentence worth carrying away, because the pull towards `MultiStreamProjection` ("two kinds of thing in one
document") is real and buys nothing but an `Identity<T>` per event type re-deriving a key the stream already
is, plus `Async` by default. It stays Inline, so its GIVEN/THENs assert rather than wait.

**An array, not a `List<T>`, and the reason is that the bug is otherwise writable.** Marten's own
aggregate-projections page models a collection member as `List<string>`, and with a `List` this compiles,
runs and passes every test in this folder:

```csharp
current.Revisions.Add(new Revision(e.Subject, e.RevisedAt));
return current;
```

It mutates the document instance Marten handed you instead of producing a new one. Inline and uncached that
is invisible — which is exactly why it is dangerous; the moment a second-level aggregate cache holds that
instance (`Options.CacheLimitPerTenant` on the projection, `UseIdentityMapForAggregates` on the store) the
mutation outlives the transaction that made it. On an array `.Add` does not exist, so
`with { … = [.. …, item] }` is the only way through. The cost is honest and stated in the file: every append
copies the whole group, O(n²) over a row's life. Fine for a history a human revises; at ten thousand members
the answer is a different **row shape**, not a `List`.

**`mappings="revisedTo=subject"` is here on purpose.** It is the only place in the kit where a rename has to
resolve *through* a repeated group — to a field of the child record — so it is the only place the claim is
exercised. It discharges to `new Revision(e.Subject, e.RevisedAt)`: same value, different name, same type,
which is all a mapping is ever allowed to be.

**The head and the group can disagree, which a single-shaped row cannot.** `Subject` is the current subject
*and* the last member's `RevisedTo`. A fold that appends without moving the head leaves the row
self-contradictory, and only one test looks at both at once — mutation-checked, below.

### Two tests that catch what nothing else would, proved by breaking them

Both claims were verified by mutating the fold on purpose and confirming that the named test **and only it**
failed, then reverting. A green test that would catch nothing is worse than no test.

| Mutation | Result |
| --- | --- |
| drop `Subject = e.Subject` from `DraftHistoryProjection.Apply(SubjectRevised, …)` — append the revision, leave the header behind | `Failed: 1, Passed: 15` — only *the row's current subject is the latest revision*. The other two GIVEN/THENs stay green: one never revises, the other only reads the group and its count |
| `current with` → `new MyDrafts` in `MyDraftsProjection.Apply(SubjectRevised, …)` — rebuild the row from the latest event | `Failed: 1, Passed: 15` — only *revising the subject leaves the body alone*. `a revised subject replaces the old one` still sees one row with the right subject, and revise-subject's own happy path only reads `Subject` |

The second one is the reason that GIVEN/THEN exists. `SubjectRevised` carries `emailId, subject, revisedAt`
— no body, no recipient — so the obvious wrong fold, *rebuild the row from the latest event*, silently
blanks both. **The information-completeness check cannot see it**: it asks whether some connected event
supplies every attribute, and `EmailDrafted` supplies `body`, so the model is complete and the fold is still
broken. *Which* event supplies a field is a question only a fold answers.

### These three tests are implemented and skipped, and that is not a bug

`slice-draft-history` carries `status="in-design"` in `drafting.drawio`. codegen bakes `[Fact(Skip = …)]`
into a test file from `status=` **at the moment the file is first scaffolded**, and a test file is a
scaffold — so the attribute is kept for ever afterwards. Nothing is stale here: a skip only counts as stale
on a *claimed* slice, and this slice is not claimed, so `TESTS STILL SKIPPED ON A CLAIMED SLICE` correctly
says nothing.

Turning them on is two edits and the first one is not the implementer's to make:

1. `drafting.drawio`, cell `slice-draft-history`: `status="in-design"` → `status="ready"`
2. `DraftHistoryTests.cs`: delete the three `Skip = …` arguments

Done in that order the suite is `Failed: 0, Passed: 16, Skipped: 0` — measured, by doing exactly step 2
locally and reverting it. **Promoting the slice alone does nothing**, which is the trap: the status changes,
the report starts complaining, and the tests go on being skipped.

## What is not here

**`draft-email` is not an aggregate handler, deliberately.** It mints the id, so the stream cannot exist yet
and there is nothing to fetch; it uses `MartenOps.StartStream`. Worth stating because it marks the boundary:
**the aggregate handler workflow is for changing state, not creating it.** Both slices in this model are
Command slices and only one of them can use it.
