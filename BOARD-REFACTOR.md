# The board refactor — following the books, and what it costs

**Decided 2026-08-10.** The books are the source of truth for the method (see CLAUDE.md, *"When the kit and
the BOOKS disagree"*). This file scopes the refactor that decision requires, honestly, before any of it is
built. It is a plan, not a record of work done.

---

## 1. What the books actually say, with citations

| # | Source | What it says | What the kit does today |
| --- | --- | --- | --- |
| 1 | `UES` ch. 18 (5813) | *"It is perfectly fine to have more than one model on a board. In fact, this is the rule rather than the exception for me."* | **one `.drawio` per model.** `context=` must match the filename |
| 2 | `UES` ch. 18 (5824) | *"I use a pink sticky note placed on the left side of each model to properly name it."* | ✅ the model cell — but it duplicates the filename rather than being the only identity |
| 3 | `UES` ch. 18 (5781) | **Chapters and sub-chapters** — blue arrows in two layers **above** the model, grouping slices. *"a chapter defines kind of a context for a given slice"*. Learned from Dymitruk | **deliberately not built**; CLAUDE.md says *"prefer splitting"* |
| 4 | `UES` ch. 18 (5862) | *"If there are alternative flows for a certain slice, I place a **marker below the slice with a link to a different model on the board**."* | nothing. Alternative flows are a separate file with no link |
| 5 | `UES` ch. 5 (2550) | *"From the perspective of the cart-system, this is an **integration event** and serves as a contract with external systems."* — and it is *"a different event category than the Domain Events we use internally"* | `public="true"` **re-uses a domain event** across the boundary |
| 6 | eventmodeling.org | *"Each specification must be tied to **exactly one command or view**."* | `em="journey"` — a specification spanning several slices. **A kit invention** |
| 7 | `LEB` ch. 9 (516) | *"In my models Slices are typically surrounded by a **black border**. Slices that just mimic information flow aren't."* | nothing; `codegen` would try to generate a foreign slice |

## 2. The one departure that causes the others

**A board holds many models. The kit made one file per model.** Almost every cross-model limitation follows
from that single choice:

- **V19** — a journey cannot span two models, because two files are two coordinate spaces and there is no
  bar to draw. On a board this is not a feature request, it is a rectangle.
- **Alternative flows** cannot carry the book's link marker, because there is nothing to link *to* within
  the file.
- **Chapters** could exist today but would stop at the file edge.
- `_context-map.drawio` exists **only** because the models are in separate files. On a board, the context
  map is the board.

**So the refactor is one change with a long tail, not seven changes.**

## 3. Scope — what has to move

### 3a. The board itself (the large piece)

A model becomes a **region** of one canvas, identified solely by its model cell. Every y the kit derives —
lane tops, swimlane bands, routing corridors, the GWT band — becomes **relative to the model's origin**
rather than to the page.

| File | What changes |
| --- | --- |
| `tools/model.mjs` | `firstDiagram` → many model regions per page; every geometry derivation offset by region origin; `laneOf`/`bandOf` scoped to region; the per-model validation pass keyed by region, not file; cross-model rules become **within-file** |
| `tools/slice.mjs` | every placement, insert-shift and routing allocation is absolute-x/y today |
| `tools/crop.mjs` | already an x-window; needs a y-window or a region selector |
| `tools/drawio.mjs render` | one PNG per board is unreadable at two models; needs per-region export |
| `tools/model.mjs map` | `_context-map.drawio` may cease to exist |
| `tools/codegen.mjs` | **likely the least affected** — it already compiles every model into one IR and one test project |
| `tools/project.mjs` | `init` scaffolds `diagrams/<context>.drawio` |

### 3b. Additive, and cheap once the board exists

- **chapters** — `em="chapter"`, a `slices=` list, drawn above the model in two layers
- **the alternative-flow link marker** — a cell under a slice pointing at another model region
- **the black border** — a slice attribute saying *"not ours to build"*, which closes BOOK-INDEX gap 11 and
  stops `codegen` generating a foreign slice

### 3c. The two questions the refactor forces, which are NOT mechanical

**Does `em="journey"` survive?** Source 6 says a specification is tied to exactly one command or view, so a
journey is not a specification in the books' sense. Three honest answers: drop it and keep journeys as
*tests* with no cell; keep it and record it as a deliberate kit extension with the citation against it; or
**merge it into `chapter`** — a chapter already groups slices, and a journey is a chapter with a `then=`.
The third removes an invented concept by adopting a book one, which is the most faithful to the new rule.

**Does `public="true"` survive?** Source 5 separates domain events from integration events. Voltway's two
contexts share one store and one `Bay` stream, and charging folds estate's **domain** events directly —
which ch. 5 names as *leaking business logic*. `event-shape-disagrees` then enforces one shape for that
domain event everywhere, which **institutionalises** the conflation. The book's answer is a separate,
versioned, *"stable summary"* event. That is a bigger change than the board.

### 3d. Migration — the hidden cost

**Six model sets must move and keep validating**, and one of them is the regression suite:

| | |
| --- | --- |
| `DemoAllPatterns` | 2 models, 23 slices, 2 journeys |
| `reference-implementations/` | state-change, state-view, automation, translation, reservation, cross-aggregate-invariant |
| `tools/fixtures/cart/` | **the regression suite.** `cart-replay.mjs` builds it in nine successive appends and must be byte-identical on re-run — that script is written against the current geometry and would be rewritten |

## 4. Sequencing

Each step ends green, so the refactor can be stopped between any two.

1. **Decide 3c** — journey and `public=`. Notation decisions gate the geometry work.
2. **Board geometry in `model.mjs` read-only** — parse many regions, validate per region, cross-model rules within a file. No writer changes; migrate one fixture by hand to prove it.
3. **`slice.mjs` writes regions** — placement relative to origin.
4. **Migrate** the six sets; `cart-replay.mjs` rewritten; every model at 0/0.
5. **Additive**: chapters, the link marker, the black border.
6. **V19 closes by construction** — draw the cross-context journey and make it pass.

## 5. What this is not

- **Not a reason to stop using the kit meanwhile.** Voltway is green at 190 tests and its models validate;
  nothing here breaks it until step 4 touches it.
- **Not licence to re-litigate the stack.** The books govern the method. Marten/Wolverine/Alba behaviour is
  still settled by `reference/llms/`.
- **Not a rewrite.** `codegen.mjs` — the largest tool — is barely touched, because the IR already unifies
  every model in the project into one system.
