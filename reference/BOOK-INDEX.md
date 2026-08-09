# Book index — where every kit rule comes from, and what the books say that the kit does not

**The kit's rules are derived from two books, and until now nobody had read either one end to end.**
That cost four separate findings (see *How this file came to exist* at the bottom). This is the map:
chapter → line number in the extracted text → what it licenses.

| | |
| --- | --- |
| `UES` | **Understanding Eventsourcing**, Martin Dilger, 2024. `eventmodeling-and-eventsourcing.txt`, 13,322 lines |
| `LEB` | **The little Eventmodeling Book**, Martin Dilger, 2025. `the-little-eventmodeling-book.txt`, 981 lines |

**Both books are Dilger's.** Adam Dymitruk wrote the foreword to `UES` and created Event Modeling, but
authored neither book — his positions are online (eventmodeling.org, SE Radio 539). Getting this wrong
once already produced a wrong answer in this repo.

**Cite as `UES ch. N` / `LEB ch. N`, with the line number** — page numbers appear in the text as
`===== page N =====` markers, and the printed page is ~22 lines behind the line number.

---

## 1. Chapter map

### UES Part I — Foundations (line 456–4335)

| Ch | Line | Subject | Kit relevance |
| --- | --- | --- | --- |
| 1 | 463 | why Event Sourcing | — |
| 2 | 617 | events, streams, projections, the event store | foundational |
| 3 | 1423 | **Event Modeling: the four patterns, ICC, GWT/GT** | the whole grammar |
| 4 | 2054 | **CQRS, consistency, concurrency, optimistic locking** | `architect`'s source |
| 5 | 2470 | **internal vs external data, integration events, versioning** | `public="true"`, the model boundary |
| 6 | 2731 | anatomy: command handler, aggregate, projector, query handler | **points at DCB, line 2887** |
| 7 | 3017 | **stream design, swimlanes, closing the books, summary events** | `streams=`, `identity=`, AD3 |
| 8 | 3360 | DDD: ubiquitous language, bounded context, aggregates | context = one model |
| 9 | 3727 | **sagas** — and why he doesn't use them | AD20 |
| 10 | 4001 | **vertical slicing** | slice = folder; "a day's work at most" |

### UES Part II — Modeling (4337–5895)

| Ch | Line | Subject | Kit relevance |
| --- | --- | --- | --- |
| 11 | 4344 | brainstorming | `event-model` phase 2 |
| 12 | 4524 | **wireframes, backwards data derivation** | `displays=`, phase 5–6 |
| 13 | 4788 | **GWT / GT scenarios, example data** | `given/when/then=`, GT shape |
| 14 | 4973 | Clear Cart — the `aggregateId` ripple | the cart fixture |
| 15 | 5098 | Submit Cart — **internal → external via automation** | `public=`, translation |
| 16 | 5322 | Inventory Changed — **translation, anti-corruption layer** | `pattern="translation"` |
| 17 | 5550 | Price Changed — **todo-list reasoning, the dotted back-channel** | automation, AD20b |
| 18 | 5772 | **structuring: chapters, many models per board, alternative flows** | MODEL-ORGANIZATION.md |

### UES Part III — Implementation, Kotlin/Axon (5897–10220)

Chapters 19–28. **Read selectively — see the honesty note at the bottom.** Ch. 28 (breaking changes,
upcasters, replays) is the conceptually portable one; the rest is Axon API walkthrough.

### UES Part IV — Implementation Patterns (10222–11307) ← **highest density of kit gaps**

| Ch | Line | Pattern | In the kit? |
| --- | --- | --- | --- |
| 29 | 10230 | what this part is about | — |
| 30 | 10264 | **Database Projected Read Model** | ✅ the default recipe |
| 31 | 10428 | **Live Model** | ✅ recipe 1 |
| 32 | 10521 | **The (partially) synchronous Projection** | ~ the HAZARD is demonstrated + defended (`reservation/`); the recipe is unbuilt |
| 33 | 10626 | **The Logic Read Model** | ~ `derived=` exists; the *constraint* is not stated |
| 34 | 10696 | **Snapshots** | ✅ quoted ("neither modeled nor mentioned") |
| 35 | 10821 | **Processor-TODO-List** | ✅ the automation pattern — credited since AD20 |
| 36 | 11104 | **The Reservation Pattern** | ✅ both halves — `cross-aggregate-invariant/` arms 2+5, and `reservation/` |
| 37 | 11235 | **Lookup Tables** | ❌ nothing; answers T5 |

### UES Part V — The missing chapters (11311–13322)

| Ch | Line | Subject | In the kit? |
| --- | --- | --- | --- |
| 38 | 11319 | why the missing chapters | — |
| 39 | 11367 | **Metadata: correlation & causation IDs** | ❌ **nothing at all** |
| 40 | 11630 | **Security: actor lanes, business vs technical roles** | ✅ Y1/Y5, actor lanes |
| 41 | 11991 | **GDPR: crypto shredding, forgettable payload, data minimalism** | ❌ **nothing at all** |
| 42 | 12342 | **UI: eventual consistency, fenced polling, SSE** | ❌ the *principle* is missing |
| 43 | 12913 | **organization, Conway's law** | ✅ `owner=` |

### LEB — all 19 chapters (line 26–981)

| Ch | Line | Subject | Note |
| --- | --- | --- | --- |
| 4 | 204 | ES not required for EM | the model is stack-agnostic |
| 5 | 248 | information completeness check | the gate |
| 6 | 300 | **State Change slice** | *"more than one Command? **No.**"* |
| 7 | 342 | **State View slice** | *"Read Model link to another Read Model? **No.**"* |
| 8 | 400 | **Third Party Integration** | modelled as an **Automation**, not a separate pattern |
| 9 | 467 | **modelling external systems** | **the black border — see gap 11** |
| 10 | 525 | one command, multiple aggregates | `command-crosses-swimlane` |
| 11 | 564 | one command, multiple events | "exception, not the rule" |
| 12 | 594 | multiple commands in one slice | "strongly recommend not to" |
| 13 | 627 | **Jira: slice states** | Created/Planned/Assigned/Review/**Blocked**/Done |
| 14 | 697 | multiple read models per slice | *"one dedicated Read Model per UI component"* |
| 15 | 733 | **Command vs API** | **the pure-handler claim — see contradiction 1** |
| 16 | 779 | technical details / ids | *"if in doubt, leave these attributes out"* |
| 17 | 824 | ways to implement read models | "a Read Model might be a simple Event Listener" |

---

## 2. What the books license that the kit does NOT have

Ordered by how much a project would miss them.

**1. `UES` ch. 32 — the (partially) synchronous projection.** *Narrowed 2026-08-09: the HAZARD is now
demonstrated and defended against; only the chapter's own RECIPE is still unbuilt.*
CLAUDE.md names this as the third read-side option and says it is *"not in the kit's six-recipe menu"*.
The book gives the recipe: a **bounded in-memory queue** filled by a *subscribing* (synchronous) handler
beside the async projection. But the important part is **why** — *"we had this eventually consistent Read
Model that was used by a **processor**. Because of the eventually consistent nature, in certain
situations, it could happen that **entries get lost if the processor was running before the model got
updated**."* (10541) **That is the kit's automation pattern: a trigger reading an Async todo View can
silently skip work** — and `reference-implementations/reservation/` now reproduces it deterministically
(`CONTROL_an_async_todo_view_silently_loses_the_work`) and defends against it by registering todo Views
`Inline`. What is still missing is the chapter's own recipe, and the generator still picks Async for a todo
View — KIT-FINDINGS **BK1**/**BL2**.

**2. `UES` ch. 36 — the Reservation Pattern.** ✅ ***BOTH HALVES BUILT 2026-08-09.***
The **mechanism** half — *"helps to synchronize concurrent access to a limited resource **across aggregate
boundaries**"* (11131), with the contested value made **the stream id** (11178) — is arms 2 and 5 of
`cross-aggregate-invariant/`, and arm 5 is the cheapest of the five: no extra row, index or lock.
The **workflow** half — *"The Reservation-Pattern always consists of two steps. Reservation … Execution"*
(11117) — is `reference-implementations/reservation/`, together with the compensating path and a
measurement of what *"the whole cycle … within one single web-request"* (11144) costs. **It needed no new
notation**, which was the thing being tested: a state change followed by two automations, 0 errors,
0 warnings.

**3. `UES` ch. 39 — metadata. The kit emits none.** Correlation ID, causation ID, trace ID, the user who
triggered it. *"Event Sourcing is about preserving all data, and that includes metadata."* (11616)
`codegen` generates no metadata strategy, and *"we'll deal with metadata later"* is called out by name as
the trap (11620).

**4. `UES` ch. 41 — GDPR, and it is partly a MODELLING concern.** Two technical answers (crypto shredding
with `@EncryptedField` + `@EncryptionKeyIdentifier`; forgettable payloads referencing an external table),
but the primary one is **data minimalism**, which is model content: keep events small and fine-grained so
personal data lands in *one* event rather than being consolidated into a fat `Order Submitted`. (12124)
Also: a replay is required to purge projections, and *"the Event Model becomes invaluable — it provides a
clear view of where specific pieces of information are used"* (12306). The kit has no PII notation.

**5. `UES` ch. 42 — "fenced polling", the principled answer to eventual consistency in the UI.**
Return the aggregate sequence from the command; persist the projection's version beside it; the client
polls only until the version matches, then stops. (12551–12690) The kit's `ui-journey` finding says *"if an
assertion only passed on retry, that is a finding — the screen needs a refetch or optimistic UI"*. **This
chapter is what that finding should point at.** Server-side polling keeps the client unaware entirely.

**6. `UES` ch. 30 — event order is only guaranteed WITHIN a stream.** *"If more than one stream is used as
a source for the projection table, you need to be aware that the order of events typically is only
guaranteed within one stream, not over several streams."* (10316) **The kit generates multi-stream
projections and states this nowhere.**

**7. `UES` ch. 37 — Lookup Tables**, the answer to *"we have the product ID in the event but need the name"*
— which is T5 in the kit's open list, recorded as *"a foreign key that is not our key has no notation"*.
Can be modelled explicitly or left implicit. The rule: **keep them local to a slice, accept the
duplication**, because a global lookup table is exactly the coupling vertical slicing exists to prevent
(11296).

**8. `UES` ch. 7 — the RIGHT-TO-LEFT validation walk.** The kit implements the left-to-right narrative
check (*"hide all swimlanes but one, read the events to someone from the business"*). There is a **second**
trick the kit does not have: *"hide all streams and start from the **right**. Uncover one Event at a time.
For every event, check that the preceding events deliver all information necessary to create the current
event."* (3243) This checks **sequence sufficiency**, which name-matching completeness cannot see.

**9. `UES` ch. 33 — logic in a read model is fine, with one constraint the kit does not state.**
*"It can only access state already available in the system. Calculations in Read Models must not introduce
any side-effects... You can't call external services or access external datastores that are not direct
derivatives from the events stored in the system."* (10657) This licenses `derived=` and bounds it.

**10. `UES` ch. 6 — the book points at DCB.** *"There is a lot of discussion how to handle systems without
aggregate boundaries... I encourage you to search for the term **Dynamic Consistency Boundary**"* (2887),
with a link. So the kit had **two** sources pointing there — this and `reference/llms/marten/events/dcb.md`
— and used neither until AD1.

**11. `LEB` ch. 9 — a slice that is NOT ours to implement has no marker in the kit.**
*"How do you know which slices belong to our system and need to be implemented and which slices are just
showcasing information flow? **Make it visible.** In my models Slices are typically surrounded by a black
border. Slices that just mimic information flow aren't."* (516) The kit's slice cell has `pattern=` and
`status=` but nothing saying *"this is another system's flow, drawn for context"* — so **`codegen` would
try to generate it**.

**12. `LEB` ch. 7 — "Can a Read Model link to another Read Model? No."** (362) The kit's six-recipe table
offers *"a view fed by another projection's output → composite/chained projections"*. Not a contradiction —
chaining is an implementation detail and the model still draws `Event(s) → View` — but the kit should be
sure a **drawn** View → View edge is rejected.

**13. `LEB` ch. 13 — the slice states include `Blocked`.** The kit has `in-design → ready → in-progress →
in-review → closed` and no way to say *"something is blocking progress on this slice"*.

---

## 3. Contradictions and tensions

**1. The pure command handler.** `LEB` ch. 6 and 15 are emphatic: *"the Command Handler should be pure.
All necessary information is passed via the Command Object. That means no external dependencies, **no
Event Store**. To test a Command Handler, you ideally don't need to mock anything."* (324) — with the
signature `(events: Event[], command: AddItemCommand): Promise<Event[]>`.

**The kit does the opposite**: the endpoint *is* the decider and calls `FetchForWriting` inside it. The
kit's shape is the Wolverine/Marten idiom and it does keep the *fold* pure, but the handler is not.
**Not resolved, and recorded rather than quietly ignored** — the standing "docs win" rule is about the
critter-stack docs, and there is no equivalent rule for books-vs-kit. There should be, and this is the
first case it would have to judge.

**2. Third-party integration is an Automation, not a fourth pattern.** `LEB` ch. 8: *"Third Party
Integrations are always modelled as Automations using the Gear Symbol."* The kit treats `translation` as
one of four patterns, per the eventmodeling.org cheat sheet — which `UES` ch. 3 also does (1740). So the
two Dilger books differ in emphasis from each other; the kit follows the cheat sheet and `UES`, which is
defensible, but *"a translation is an automation with a foreign trigger"* is the simpler framing.

**3. `derived-without-example` on the cart fixture is correct, and the book confirms it.**
The kit blocks promoting that warning to an error because *"the book's model genuinely does not say how
`totalPrice` is computed"*. Confirmed at `UES` 4637: *"We can model the totalPrice on the Event or assume
it is derived from the itemPrice in the read model. **Right now we don't have enough information to
decide**, so either way is fine."* The ambiguity is deliberate at that stage of modelling.

---

## 4. Where existing kit rules come from

| Kit rule | Source |
| --- | --- |
| four patterns; commands blue, events orange, views green, external yellow | `UES` ch. 3 (1665–1782) |
| information completeness check is a **gate** | `UES` ch. 3 (1783); `LEB` ch. 5 |
| *"Don't save on GWTs"*, 10+ per slice | `UES` ch. 3 (1862) |
| a State View takes a **GT**, no WHEN | `UES` ch. 3 (1866), ch. 13 (4855) |
| *"For read model **and automation** tests, the When step is typically omitted"* | `UES` ch. 13 (4859) |
| **ordered** events in a THEN, left to right | `UES` ch. 17 (5634) |
| one command → one slice; more than one event is the exception | `LEB` ch. 6, ch. 11 |
| `command-crosses-swimlane` is an error | `LEB` ch. 10 (540) |
| swimlanes define **stream boundaries** | `UES` ch. 7 (3229) |
| the narrative validation trick | `UES` ch. 7 (3237) |
| closing the books > snapshots | `UES` ch. 7 (3267), ch. 34 (10723) |
| snapshots *"neither modeled nor mentioned"* | `UES` ch. 34 (10714) |
| only an **event** crosses a context boundary | `UES` ch. 5 (2552) |
| many small models, one business context each | `UES` ch. 18 (5813) |
| alternative flows get their own model | `UES` ch. 18 (5828) |
| RBAC / roles are **not** model content | `UES` ch. 40 (11820) |
| actor lanes = **business** roles | `UES` ch. 40 (11698) |
| Conway: a slice should be one team's | `UES` ch. 43 (13029) |
| a changed slice goes back to the start | `LEB` ch. 13 (646) |
| the todo-list pattern replaces the saga | `UES` ch. 9 (3980), ch. 35 |
| one read model per UI component | `LEB` ch. 14 (710) |
| *"if in doubt, leave ids out"* early on | `LEB` ch. 16 (811) |

---

## How this file came to exist

Four findings in one week traced to the same root — **the books were being grepped, not read**, and grep
only finds what you already suspect exists:

- **AD20**: an entire chapter (`UES` ch. 35, 15 pages) that the kit had been paraphrasing **uncredited**.
  Invisible to search because nothing in the kit said "saga".
- **`derived-without-example`** documented as blocked *"waiting for someone with the book"* — while the
  book was in the repo.
- **Section Y** ("what the books permit") derived by targeted grepping, and later corrected by **Y5**.
- **Both books attributed to different authors** in this repo's own conversation, wrongly.

**Honesty note on coverage.** `LEB` was read in full. `UES` Parts I, II, IV and V were read in full — that
is the conceptual content, and where every kit-relevant claim lives. **Part III (ch. 19–27, ~4,000 lines)
was read selectively**: it is a Kotlin/Spring/Axon implementation walkthrough, and this kit targets
.NET/Wolverine/Marten. Ch. 28 (breaking changes) is the portable one and was covered. That is a judgement
call, and it is stated here rather than left as an unmarked gap — if a future finding traces to ch. 21–27,
this is the reason.
