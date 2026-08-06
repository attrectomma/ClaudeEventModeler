# `tools/slice.mjs` — specification

What the `add-slice` skill delegates: every geometric consequence of adding a slice to an existing
model. No domain facts, ever.

Derived by walking the cart model of *Understanding EventSourcing* chapters 12–17 as a sequence of
appends, which is what those chapters are. The book's model is already this repo's fixture domain
(`tools/fixtures/resolved.drawio` is Fig. 12.14), so the example is continuous with what exists.

## Why a tool and not a hand edit

The same reason as `tools/wireframe.mjs`, which says it out loud: *"this is a tool and not a hand edit
— it touches every y and every routing point in the file."* Adding a slice is strictly worse: it
touches every **x** as well, and a new swimlane touches every y *and* every slice cell's height.

The `add-slice` skill currently does this arithmetic by hand and is instructed to record what it
moved. This document is that record, written up front from the book rather than after the first
mistake.

---

## 1 — The worked example: the cart model as nine appends

| # | Ch. | Slice | `pattern` | Cols | The model after it |
| --- | --- | --- | --- | --- | --- |
| 1 | 12 | `add-item` | `command` | 1 | Cart screen → `AddItem` → `ItemAdded` |
| 2 | 12 | `cart-items` | `view` | 1 | `ItemAdded` → `CartItems` |
| 3 | 12 | `remove-item` | `command` | 1 | Cart screen (displays `itemId`) → `RemoveItem` → `ItemRemoved` |
| 4 | 14 | `clear-cart` | `command` | 1 | → `CartCleared` |
| 5 | 15 | `submit-cart` | `command` | 1 | → `CartSubmitted`, `public="true"` |
| 6 | 16 | `change-inventory` | `translation` | 2 | external `InventoryChanged` → processor → `ChangeInventory` → internal event, **in a new swimlane** |
| 7 | 16 | `inventories` | `view` | 1 | `Inventories` read model → the Cart screen's stock indicator |
| 8 | 17 | `change-price` | `translation` | 2 | external `PriceChanged` → processor → `ChangePrice` → internal event |
| 9 | 17 | `archive-item` | `automation` | 2 | `CartsWithProducts` todo list → processor → `ArchiveItem` → `ItemArchived` |

Twelve columns. `40 + 12×320 + 60 = 3940px`, so the completed run trips `model-too-wide` at 3200px.
**That is correct behaviour, not a defect in the spec** — the book devotes ch. 18 to structuring a
model that has grown this way, and the budget firing is the kit noticing the same thing. The
acceptance run should show the warning, not avoid it.

### The ripples the book documents, which the tool must not swallow

These are the skill's to report and mostly the human's to answer. They are listed because two of them
have a mechanical part, and because a tool that silently fixed them would be inventing.

| Round | Ripple | Book |
| --- | --- | --- |
| 3 | `itemId` added to `ItemAdded` **and** `AddItem` — *"we just moved the red arrow one hierarchy further up to the UI"* | Fig. 12.13–12.15 |
| 4 | `aggregateId` added *"consistently throughout the Event Model"* — every existing event and command | ch. 14, p.242 |
| 4 | `CartItems` gains an edge from `CartCleared` — *"the cart-items Read Model gets its data not only from Item Added and Item Removed Events, but also from the Cart Cleared-event"* | ch. 14, p.242 |
| 7 | `product-id` added to `CartItems`, then to `ItemAdded`, then to `AddItem` — *"it's not enough to simply add the product-id to the read model"* | ch. 16, p.249 |
| 7 | the `add-item` and `submit-cart` screens gain `displays="inventory"`, and gain rejection GWTs — *"You cannot add items to the cart that are out of stock"*, *"The customer must not submit a cart containing out-of-stock items"*. Both slices were already built → **demote** | ch. 16, p.243 |
| 9 | `CartCreated` added as a **second event of the existing `AddItem` command**, and that slice's GWT becomes ordered: *"the Cart Created event occurs before the Item Added event"* | ch. 17, p.259–260 |

Rounds 4 and 7 are the identity/field propagation case — see `identity` in §3. Round 9 is a slice
gaining an event after it was built, which is geometry (a second row inside a band) plus a demotion.

---

## 2 — The operation inventory, and which round demands it

| Op | First demanded by | Why it is not obvious |
| --- | --- | --- |
| **append** N columns at the right end | 4 | widens the page **and all four lanes**, not just the page |
| **allocate a routing y** | 4 | must continue from the highest y already used in that band, not restart at n=0 |
| **backward corridor** | 4 | `CartCleared` (col 4) → `CartItems` (col 2) points left. Legal — the `Event → View` exception — but it needs a corridor y below the event lane, not a straight line through three columns of boxes |
| **add a swimlane** | 6 | grows the event lane; shifts the backward corridor, the GWT lane and every GWT cell down; **grows every existing slice cell's height**; grows the page height |
| **insert** N columns at position *k* | 7 | **the hard one — see below** |
| **left corridor** for stacked events | 8 | two externals in one column feeding one view: the lower one would cut through the upper |
| **propagate an identity field** | 4 | mechanical only because the band's `identity=` already names it |
| **demote impacted slices** | 7 | derivable from a changed-cell list, which `git diff` supplies |

### Insert is required by the book's own seventh append

Round 7's `Inventories` read model feeds *"a small inventory indicator in the UI"* on the Cart screen —
which is **column 1**. A View → Screen edge pointing left is not the `Event → View` exception, so it is
`flow/backward-connection`, an error. CLAUDE.md already states the fix: *"where a screen reads a View
drawn to its right, put the View's column first."*

So round 7 must **insert at position 0**, shifting all six existing columns right by 320. Everything
moves: element x, slice-cell x, every `<mxPoint>` x in every edge, every GWT x.

That is the maximal case, and it arrives naturally on the fourth append of a real book example. It is
the single strongest argument for the tool: appending is easy arithmetic, and appending is not what a
growing model needs.

The alternative to inserting is redrawing the View next to every screen that reads it, which the kit
rejects because it *"doubles the width of the model."*

---

## 3 — CLI

```
node tools/slice.mjs add       <file> --slice <name> --pattern <p> [--at <spec>] [--columns N] [--aggregate A]
node tools/slice.mjs swimlane  <file> --label <text> --streams <A[,B]> [--identity <f[,f]>] [--height N]
node tools/slice.mjs route     <file> --from <id> --to <id>
node tools/slice.mjs identity  <file> --band <id>
node tools/slice.mjs demote    <file> [--slice <name>]...        # or --from-diff
node tools/slice.mjs reflow    <file>
```

`--aggregate` says which swimlane a pattern's events go in. That is positioning by a fact the user
supplied, not inventing one — and where the model has exactly one band it is a derivation, so the flag
is only required from the second band onward. `route` needs no `--band`: the band follows from the two
endpoints' kinds and relative x, and letting a caller override it would be letting them route an
illegal edge prettily.

Every command takes `--dry-run`, which prints the plan and writes nothing.

### `add`

Creates the slice cell, the column band(s), and the GWT row positions. Emits **empty placeholder
cells** for the pattern's required elements — a command cell with no `fields=`, an event cell with no
`fields=` — so the skill has somewhere to write the transcription and the validator can already see
the shape.

`--at` accepts:

| | Means |
| --- | --- |
| *(omitted)* | append at the right end |
| `end` | the same, explicitly |
| `start` | insert at position 0 — round 7's case |
| `before:<slice>` | insert immediately left of that slice's first column |
| `after:<slice>` | insert immediately right of that slice's last column |

`--columns` defaults from `--pattern`: `command` 1, `view` 1, `upstream` 1, `automation` 2,
`translation` 2. An explicit value wins — a command slice emitting into two bands still needs one
column, but a translation with a materialised todo list may want three.

Refuses, with a message and exit 1:

- a `--slice` name that already exists anywhere in the **system folder** (`slice-name-collision` — slice
  names are unique across the system, because a slice is a branch and a ticket)
- an `--at` target slice that does not exist
- a `--pattern` outside `PATTERNS` in `tools/model.mjs` — that table is the authority, not this file

### `swimlane`

Round 6. Appends a band inside the Event Stream lane and cascades. `--height` defaults to 95, one row
of events; a slice emitting two events into one band needs 170 (`campaigns.drawio` uses both).

**`streams=` is what makes a cell a swimlane**, not `em=`. `buildIr` selects swimlanes with
`nodes.filter(n => n.streams && !isMarker(n.id))` and then subtracts them from `lanes`, so a band
authored with `em="lane"` and `streams=` is correctly a swimlane while one with `em="lane"` alone is a
lane. Emit `streams=` always, and id it `swim-<name>`.

Omitting `--identity` is legal and leaves `band-needs-identity` to fire — correct, because the key is a
domain answer. Do not default it to the aggregate name.

### `route`

Allocates one edge with its own y in the right band, chosen from the endpoints rather than told:

| Endpoints | Band |
| --- | --- |
| screen → command, command → event (same column) | none — a straight vertical, no allocation |
| event → view, left to right | forward: `cmdLane.bottom + 6 + 8n` |
| event → view, right to left | backward: `eventLane.bottom + 15 + 9n` |
| view → screen | UI strip: `uiLane.y + 345 + 8n` |
| several events stacked in one column → one view | left corridor: `columnX − 30 − 12n` |
| anything else pointing left | **refuse.** That is `flow/backward-connection` and the fix is `add --at`, not a route |

That last row matters: the tool must not make an illegal edge look tidy. Reordering columns is the fix,
and the tool has a command for it.

### `identity`

Rounds 4 and 7's mechanical half. For the named band, adds every name in its `identity=` to the
`fields=` of every owned event that lacks it, and to the `fields=` of every command that emits one.

Deliberately narrow. It propagates **only names the band already declares** — a fact the model states
and `identity-not-on-every-event` already demands. It never adds `product-id` to `CartItems`, because
nothing in the model says it should; that is round 7's judgement and belongs to the human.

Types come from wherever the name already appears in the model. If the name appears with two different
types, refuse and say both — that is `event-shape-disagrees` waiting to happen.

### `demote`

Sets `status="in-design"` on the named slices and rewrites their labels to match. `--from-diff` reads
`git diff --unified=0` on the file, maps changed cells to their `slice=`, and demotes every one past
`in-design` — Dilger's *"set it back to Created"*, mechanised.

Prints what it demoted and why (which cell changed). Never demotes silently.

### `reflow`

Recomputes lane widths, page width and page height from content, and reports drift. The repair command:
after a hand edit in draw.io that dragged a column, `reflow` puts the derived geometry back without
touching semantics.

---

## 4 — Invariants

The tool's real contract. Every command must leave all of these true, and `--dry-run` should report any
it found already broken.

**Widths**
- every lane has the same width
- `pageWidth = 40 + laneWidth + 60`
- `pageHeight` clears the lowest GWT row

**Columns**
- column x values are `firstColumnX + 320n`, no gaps
- elements are 180 wide; commands, events, views and automations 60 tall; screens 180×300

**Slice cells**
- `x = firstColumnX − 20`, `width = 220 + 320×(columns − 1)`
- `y = uiLane.y − 20`, `height = eventLane.bottom − y`
- a plain rectangle: `vertex="1" parent="1"`, **never a container** — a container reparents its children
  and makes their geometry relative, breaking every absolute-x reader including `tools/crop.mjs`
- **contiguous**: a slice's columns are adjacent. An insert must never split an existing slice's band

**Events**
- an event's centre y lies inside the band its `aggregate=` names. An event's y *is* its stream
- a swimlane spans the full lane width and is clamped in `tools/crop.mjs`, or it blows out the export
  bounds

**Routing**
- no two edges share a y within one band
- no routing band contains a vertex cell
- every `<mxPoint>` y in a band that moved moves with it — the defect `wireframe.mjs` had to fix

**GWTs**
- 300×120, `x =` the slice's first column x, first row at `gwtLane.y + 30`, then every 140
- 300 + 20 fits the 320 pitch exactly, so one slice's GWTs never collide with the next slice's

**Swimlanes are not lanes.** `buildIr` keeps them out of `lanes` deliberately: `laneOf()` takes the
first containing match and `parseCells` returns every `<object>` before every bare `<mxCell>`, so a
swimlane authored as an object would be found ahead of the lane containing it and every event would
look misplaced. Preserve that ordering when writing cells.

---

## 5 — Implementation constraints

**Regex surgery on text blocks, not XML round-tripping.** `wireframe.mjs` does this and the reason is
the whole point of committing the model: a parse-and-serialise reformats every line, and the diff — the
review artifact — is destroyed. Match blocks with the same pattern it uses:

```js
/        <object [\s\S]*?<\/object>\n|        <mxCell id="(?!0"|1")[\s\S]*?(?:<\/mxCell>\n|\/>\n)/g
```

Cells the command does not touch must come out **byte-identical**.

**Read the grid off the model, never from a constant.** CLAUDE.md's layout table is a snapshot and says
so; its GWT row starts at 1375 while the real `campaigns.drawio` starts at 1330. Derive `uiLane.y`,
`cmdLane.bottom`, `eventLane.bottom`, `gwtLane.y`, `firstColumnX` and the used routing ys from the file
on every run.

**Idempotent.** `add` for an existing slice name is a no-op with a message. `identity` on a band whose
events already carry the key writes nothing. `swimlane` with an existing label writes nothing. Same
contract as `wireframe.mjs`: *"a screen that already holds field cells is left alone."*

**Refuse a compressed file** with the message that names the fix, exactly as `wireframe.mjs` does:
`source is compressed — run: node tools/drawio.mjs inflate <file>`.

**Report what moved**, always, in one line per class: `4 columns shifted +320, 11 routing points moved,
6 slice cells grown +105, page 2940→3260`. The skill's report quotes this, and a human reviewing the
diff needs to know what to expect before reading it.

---

## 6 — What it must not do

- **No domain facts.** No `fields=`, no `identity=` value, no event name, no `aggregate=` guess. Empty
  placeholders and nothing else. The one apparent exception, `identity`, only copies a value the model
  already declares.
- **No edge it cannot justify.** Refuse a left-pointing non-`Event → View` edge rather than routing it
  prettily.
- **No `status` promotion.** Only `demote`. Promotion needs a human to have looked at something.
- **No writes to `_context-map.drawio`** — that is `model.mjs map`'s output.
- **No validation.** `model.mjs validate` is the authority; duplicating a rule here creates a second
  place the same fact lives.

---

## 7 — Acceptance

Replay the nine appends into a fresh copy of `templates/template.drawio`, from a script under
`tools/fixtures/`, and assert after **each** round:

1. `node tools/model.mjs validate` — no `flow/`, `slice/` or `swimlane/` findings. Completeness findings
   are expected: the placeholders are empty until the skill fills them.
2. `node tools/drawio.mjs render` succeeds, and the PNG is **looked at** at rounds 6, 7 and 9 — the
   swimlane cascade, the insert-at-0, and the two-event band. Layout defects are invisible in XML.
3. Re-running the same command is a no-op: the file is byte-identical.
4. After round 9, `model-too-wide` fires at 3940px. Expected, and the run should say so rather than
   the fixture being trimmed to avoid it.

Then the regression that matters most: `git diff` between rounds touches only cells that had to move.
A round that reformats the file has failed even if the picture is right.

**Built.** `tools/slice.mjs`, `tools/fixtures/cart-replay.mjs`, and the model at `tools/fixtures/cart/`.
The replay reaches **0 errors, 1 warning** (`model-too-wide`, asserted) at every round, and a
re-run of any command is byte-identical.

---

## 8 — Corrections this spec needed, found by implementing it

Kept rather than edited away, because each one is a thing the design could not see.

**A copied regex was silently deleting every edge.** §5 said to reuse `wireframe.mjs`'s block pattern.
That pattern ends a cell at `(?:<\/mxCell>\n|\/>\n)` — and a lazy match takes whichever comes first,
which inside an edge is its own self-closing `<mxGeometry ... />`. The block ended early, the trailing
`</mxCell>` matched nothing, and the rewrite dropped it: 88 opens against 54 closes, every edge
unterminated. Nothing errored. `model.mjs` simply saw no edges, so all 7 commands read as having no
trigger and all 5 views as fed by nothing — **107 validation errors that looked like modelling gaps.**
The self-closing alternative must come second and use `[^>]*?` so it cannot cross a `>`.
**`tools/wireframe.mjs` had the same bug** and is fixed with it.

**`w`/`h` are not attribute names.** `setGeom({w})` matching `\bw="..."` finds nothing and the fallback
*injects* a bogus `w="1580"`, so lanes never widen and the page grows past them. Map to `width`/`height`.

**The cell shift threshold is `x0 - 20`, not `x0`.** A slice band is drawn 20px left of its own first
column, so at the column x the band stays put while its members move — `slice/slice-member-outside` on
every insert. Routing points need a different threshold again (`x0 - 60`), because a left corridor at
`columnX - 30 - 12n` belongs to the column it serves.

**A View and a processor share a column, and their order is load-bearing.** §3 said `add` emits the
pattern's cells; it did not say where two lane cells go. Both at one y drew them on top of each other.
Stacked the obvious way — View above — the external event's feed into the View passes straight through
the processor. The View goes **underneath**: reading upward from the event lane that is
Event → View → Trigger, the cheat sheet's own order.

**Edge hints have to come from the boxes.** One vertical constant makes a lateral hop (processor →
command, one column right at the same height) dogleg down through the routing band and back up.

**CRLF.** git's autocrlf leaves `.drawio` working copies with `\r\n` on Windows, and every pattern here
anchors on `\n`. Normalise in, restore out — so a uniformly-CRLF file still comes back byte-identical
where nothing changed. `wireframe.mjs` silently no-ops on such a file ("no screen cells").

**Renaming a template band's label is not enough.** `identity --band <id>` addresses a band by id, so a
model still carrying `swim-rename` cannot name the one thing that command needs.

**The final width is 4180px, not the 3940 estimated here.** `widen` grows by `max(columns × 320, what
the content needs)`, which leaves slack an append does not reclaim. Over budget either way, which was
the point — but `reflow` uses `Math.max` and therefore never tightens. A genuine loose end.
