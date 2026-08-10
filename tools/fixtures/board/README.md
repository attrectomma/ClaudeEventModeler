# `board.drawio` — two models on one canvas

The regression fixture for the **board**: a model is a *region* of one canvas rather than a whole
file, so this file holds two complete models — `cart` (the book's ch. 12–17 cart, region 1) and
`drafting` (the `state-change` reference implementation, region 2) — stacked vertically and
separated by a gutter.

```
node tools/model.mjs validate tools/fixtures/board/board.drawio
```

**What it exists to catch.** Regions partition the canvas by y, and every rule in `model.mjs` is
handed one region's IR. A geometry rewrite is ideal conditions for a rule that silently stops
matching, and *"no findings"* is indistinguishable from *"the rule no longer fires"*. This file is
the standing proof that a rule scoped to a region still sees what it saw when a model was a file.

**The property it holds, which is the whole claim:**

> validating these two models as **two files** and as **one board** must produce the *same findings*.

That equivalence is what makes step 2 of `BOARD-REFACTOR.md` safe, and it is checked by comparing
this file against the same two models validated separately.

## Why this is not in `tools/fixtures/cart/`

**`tools/fixtures/cart/` is generated, not authored.** `cart-replay.mjs` does `rmSync` on that
folder and rebuilds it from `slice.mjs` on every run, so a hand-migrated board placed there would be
silently reverted by the next replay — and reverted *quietly*, which is the exact failure shape this
fixture exists to guard against. Making the replay emit a board is writer-side work and belongs with
`slice.mjs` in step 3.

So `cart.drawio` is used here as an **input**, unmodified, and the board is committed beside it.

## Why the two models are unrelated

Nothing here invents a domain fact. Both halves are real, already-validated models, combined by pure
y-translation with their cell ids namespaced (`cart-…`, `drafting-…`) because two models on one
canvas cannot share an id. The pairing is arbitrary on purpose: this fixture tests the *partition*,
not a business boundary. Voltway is where a board of two genuinely related contexts gets tested.

**Regenerate it by translation, never by hand** — the y offsets and the id prefixes have to stay
consistent or the equivalence above stops meaning anything.
