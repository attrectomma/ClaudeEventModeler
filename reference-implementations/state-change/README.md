# State change — the aggregate handler workflow, twice

One slice, two implementations, the same four rules. `revise-subject` acts on a stream that **already
exists**, which is what Wolverine's aggregate handler workflow is for: `[WriteAggregate]` fetches the stream,
folds it live, hands the decider the state, and carries the stream's version into the append so the write is
optimistically concurrent.

```
drafting/            the model — 3 slices, 13 elements, 0 errors / 0 warnings / 5 notes
generated/           both implementations. 10 tests, stable across repeated runs
```

| | Implementation | Transport | Identity from | A refusal is |
| --- | --- | --- | --- | --- |
| **1** | `ReviseSubjectEndpoint` | Wolverine.HTTP | the command member | `IResult` / ProblemDetails |
| **2** | `ReviseSubjectHandler` | none — a Wolverine message | the command member | an outcome object |

Every GWT is asserted against **both**, through one `Revise(via, …)` helper, so a rule that holds for one and
not the other is a failure rather than a footnote. The model does not choose the transport, so the transport
must not change the behaviour.

## What made this possible at all

**A single-field stream key.** `[WriteAggregate]` reads *one* value, so a composite key has nothing for it to
read — the mechanical form of "the aggregate handler workflow does not fit a composite stream key". Two
generator changes followed, both derived from the model rather than assumed:

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

## What is not here

**`draft-email` is not an aggregate handler, deliberately.** It mints the id, so the stream cannot exist yet
and there is nothing to fetch; it uses `MartenOps.StartStream`. Worth stating because it marks the boundary:
**the aggregate handler workflow is for changing state, not creating it.** Both slices in this model are
Command slices and only one of them can use it.
