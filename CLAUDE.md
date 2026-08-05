# ClaudeEventModeler

Event Modeling diagrams in draw.io, edited by both a human (visually, in VS Code) and Claude
(as XML). The `.drawio` file is the single source of truth — there is no database and no
export step to keep in sync.

## Enforced tech stack

Generated code and any reference implementation target exactly this. Not a default to be
argued with per slice — it is the stack.

- .NET 10
- Postgres
- Wolverine (messaging, command handling)
- Marten (event store, projections)
- Alba (in-process HTTP integration testing)
- Testcontainers (real Postgres in tests)
- Docker
- Aspire — optional, only after an explicit feasibility check

Wolverine, Marten and Alba each need continuously updated, LLM-friendly documentation available
locally. Their APIs move faster than model knowledge, so anything generated against remembered API
shapes will be subtly wrong — right shape, wrong method name, quietly deprecated overload. Codegen
*multiplies* that: a fan-out of agents produces one wrong file per agent instead of one you would
have caught.

**All three publish `llms.txt`** — a markdown index whose every entry is also served as raw `.md`.
Alba does too, at `jasperfx.github.io/alba/llms.txt`, which this file previously said it did not.

```
node tools/docs.mjs sync     # mirror all three into reference/llms/   (392 pages, ~4 MB)
node tools/docs.mjs status   # how many pages, and how stale
```

**Read the mirror before writing any generated code.** Each library has
`reference/llms/<lib>/INDEX.md`, a local table of contents grouped as upstream groups it. The mirror
lives under `reference/`, which is **gitignored** — it is a regenerable build input like
`node_modules`, so a fresh clone must run `sync` once. `_manifest.json` records when it last ran so
staleness is visible rather than assumed.

## Keep it simple, but prepare for evolution

The standing principle for codegen, and the reason for several choices that would otherwise look
like over-engineering:

- **The system IR separates `shared` from `slices`** even though generation is currently sequential.
  That split is what makes a parallel fan-out possible later without redesigning anything.
- **Slices are nowhere near independent.** In `hour-booking` the `Timesheet` aggregate is touched by
  4 commands across 4 slices, `MonthClosure` by 4, and every event feeds 2–5 views. So "generate a
  slice" can never mean generating its events and projections — several slices would each write the
  same file. Events, aggregates, views and the GWT tests are generated **once, from the whole
  system**; only handlers, endpoints, pages and slice-local validators are per-slice.
- **The agent tree stays flat.** Subagents do not reliably get to spawn subagents, and workflow
  nesting is one level. An orchestrator fans out `(slice × side)` directly rather than
  slice-agents-spawning-side-agents.
- **Do one slice end to end before any orchestration.** Throughput is worthless before correctness,
  and a fan-out is impossible to debug if a single slice has never succeeded.

## How the bilateral link works

Two independent paths reach the same file. Prefer the first.

**1. Plain file tools (default).** A `.drawio` file is mxGraph XML. Read/Edit/Write it directly.
Fastest, fully diffable, no server involved. Requires the XML to be *uncompressed*.

**2. The `drawio` MCP server** (`.mcp.json`, `@drawio/mcp`, local stdio). Use it when:
- the file is compressed — `get_page` decompresses transparently, plain Read cannot
- the file is multi-page — `list_pages` / `get_page` / `set_page` touch one page and leave the rest byte-identical
- you need a real shape style — `search_shapes` returns exact style strings for AWS/Azure/GCP/UML
  rather than you inventing them

Note: `set_page` preserves the file's existing compression. A compressed file stays compressed
and therefore stays invisible to plain Read.

### Gotchas — already paid for, don't rediscover

- **`npx` cannot launch the MCP server on this machine.** `cmd /c npx -y @drawio/mcp` dies with
  `0xC0000409` on cold start, so `.mcp.json` invokes `node node_modules/@drawio/mcp/src/index.js`
  directly. The package is a devDependency — run `npm install` if `node_modules` is missing.
- **drawio.com's MCP docs are stale.** They describe the server as generation-only. v1.5.0 ships
  `list_pages` / `get_page` / `set_page` against local files. Trust `tools/list` over the docs.
- **The link is save-triggered, not push-live.** Claude sees changes when the file reaches disk,
  not as the cursor moves. Push-live would need the third-party `lgazo/drawio-mcp-server`
  WebSocket bridge; deliberately not installed.
- **An open draw.io tab is a stale snapshot, and saving it destroys Claude's work.** The extension
  reads the whole diagram into memory on open and only writes on save — it never notices the file
  changing underneath it. So after Claude edits, that tab still holds the *old* diagram, and on
  close it offers to "save changes" you never made. **Answer no, then close and reopen.** The tell
  is the editor disagreeing with a freshly rendered PNG. Recovery if it does get saved:
  `git checkout -- <file>` — which is the real reason to commit the model at every milestone.
  Before a hand-off, say explicitly whether the file changed on disk.
- **MCP and memory are both cwd-scoped.** A session started outside this folder sees neither
  `.mcp.json` nor this project's memory. Durable knowledge belongs in this file.
- **`code <folder>` hijacks an empty VS Code window.** Pass `--new-window` when the current
  window holds a live conversation.

Open question: does the VS Code draw.io extension save compressed or uncompressed? Only a real
human Ctrl+S answers it. Check with `node tools/drawio.mjs check <file>` after the first save; if
compressed, `inflate` it. The MCP path works either way, so nothing is blocked on it.

## Always close the loop by looking at the diagram

Never hand over diagram XML you have not rendered. Layout bugs — edges crossing through
boxes, overlapping labels, nodes outside their lane — are invisible in XML and obvious in a PNG.

```
node tools/drawio.mjs render diagrams/order-flow.drawio   # -> order-flow.png
```

Then Read the PNG. Fix what you see. Re-render. This caught two bad edge routes while this
project was being set up.

## Helpers

```
node tools/drawio.mjs check   <file>   # is this readable as plain XML, or compressed?
node tools/drawio.mjs inflate <file>   # decompress in place, making it plain-Read-able
node tools/drawio.mjs render  <file>   # export a PNG beside the file
node tools/crop.mjs <file> <x0> <x1> <out>   # an x-window of a wide model, so it renders legibly
node tools/verify-mcp.mjs              # re-prove the MCP read/write link end to end

node tools/wireframe.mjs scaffold <file>     # grow the UI lane, scaffold bound wireframe cells
node tools/design.mjs shot  <file.html>      # render one design page to PNG, per viewport
node tools/design.mjs sheet <designs-dir>    # shoot every screen, build the contact sheet + index
node tools/design.mjs check <system-dir>     # the styled pages against the model's displays=/inputs=

node tools/model.mjs validate <file>   # one model
node tools/model.mjs validate <dir>/   # a whole system: every model, plus the cross-model rules
node tools/model.mjs map      <dir>/   # (re)generate <dir>/_context-map.drawio from the real edges
node tools/model.mjs compile  <dir>/   # the system IR a generator reads -> build/<system>.ir.json
node tools/docs.mjs sync               # mirror Marten/Wolverine/Alba docs into reference/llms/
```

**Validate the folder, not the file.** A single file cannot see whether an imported event is
actually published anywhere; only the system run can. `compile`, `mark` and `clear` still take one
file.

A real model runs thousands of pixels wide, and a whole-model PNG downscaled to fit a screen is
too mushy to spot layout defects in — which defeats the point of rendering. `crop` writes a
throwaway window to look at. It drops edges whose other endpoint fell outside the window, so the
output is never a valid model: look at it, then edit the source.

## Event Modeling conventions

Colours are the book's, not ours: *"We use sticky notes in different colors—blue, orange, green,
and yellow"* — Commands in blue, Events in orange, Read Models green, and **external events in
yellow** ("indicating that external data is entering the system during this process step").
Fill/stroke pairs are preset in `.vscode/settings.json`, so the same swatches appear in the
draw.io colour picker, in this order.

| Element | `em=` | Lane | Fill | Stroke | Source |
| --- | --- | --- | --- | --- | --- |
| Screen / wireframe | `screen` | UI | `#ffffff` | `#666666` | book |
| Command | `command` | Commands / Views | `#dae8fc` | `#6c8ebf` | book (blue) |
| Event | `event` | Event Stream | `#ffe6cc` | `#d79b00` | book (orange) |
| External event | `external` | Event Stream | `#fff2cc` | `#d6b656` | book (yellow) |
| Read model / View | `readmodel` | Commands / Views | `#d5e8d4` | `#82b366` | book (green) |
| Automation / processor | `automation` | Commands / Views | `#e1d5e7` | `#9673a6` | ours |
| Given / When / Then | `gwt` | GWT band | `#f0f0f0` | `#999999` | ours |
| Slice group label | `group` | left of a slice | `#f8cecc` | `#b85450` | book (pink) |
| Model context note | `model` | top-left, above the lanes | `#f8cecc` | `#b85450` | book (pink) |
| Wireframe field | `field` | inside a screen | `#f0f0f0` / `#ffffff` | `#dddddd` / `#999999` | ours |
| Wireframe action | `action` | inside a screen | `#dae8fc` | `#6c8ebf` | ours |
| Wireframe chrome | `chrome` | inside a screen | none | none | ours |

A `field` is drawn white-on-grey when it is typed (`inputs=`) and dashed grey when it is only shown
(`displays=`), so a wireframe reads as a form at a glance.

Rules:
- Events are past tense (`OrderPlaced`), commands imperative (`PlaceOrder`).
- Events only ever enter the Event Stream lane. Nothing else goes there.
- An event never points at another event, and never at an automation. Every connection must be
  part of one of the four patterns below.
- One Command per State Change slice. The little book, chapter 6, on more than one command:
  *"No."* More than one Event is allowed but *"should not be the rule."*
- Give every cell a stable, meaningful `id` (`evt-order-placed`, not `node7`), so edits stay
  reviewable in diffs and edges keep resolving.
- On edges that would otherwise cut through a box, set explicit
  `exitX/exitY/entryX/entryY` hints. The free band between lanes is the place to route.

## Cell data: the semantics live on the cells

The diagram is the single source of truth, so payloads live on it too — as custom attributes on
`<object>` cells. draw.io exposes them to a human through *Edit Data* (Ctrl+M); Claude edits the
same attributes as XML. Verified: adding them does not change the rendered picture.

```xml
<object id="evt-order-placed" label="OrderPlaced" em="event" slice="place-order"
        aggregate="Order" fields="orderId:Guid, placedAt:DateTimeOffset">
  <mxCell style="fillColor=#ffe6cc;strokeColor=#d79b00;..." vertex="1" parent="1">
    <mxGeometry x="100" y="470" width="180" height="60" as="geometry" />
  </mxCell>
</object>
```

| Attribute | On | Meaning |
| --- | --- | --- |
| `em` | every element | which building block this is (table above) |
| `slice` | every element | the slice it belongs to; unassigned elements generate nothing |
| `fields` | command, event, readmodel | `name:Type` list. The book's "attributes" |
| `aggregate` | command, event | which aggregate owns the stream |
| `displays` | screen | data the screen shows — the elements the book marks green on the wireframe. Must be supplied by a View |
| `inputs` | screen | data the user types here. A terminal source: information entering the system |
| `mappings` | any | `targetField=sourceField`, for legitimate name mismatches. A **rename only** |
| `derived` | any | `target=a+b`, for a value that is *computed* from upstream rather than carried |
| `terminal` | command, event | `name:kind`, for a value that enters from context, not from the data flow |
| `given` / `when` / `then` | `gwt` | prior events / the command / expected events. `then="error: RuleName"` for an expected rejection |
| `rule` | `gwt` | the business rule this GWT names |
| `pattern` | slice cell | which of the four patterns this slice is — checked against what it's made of |
| `status` | slice cell | where the slice sits in the implementation workflow |
| `screen` | screen | the screen's identity. Cells sharing a slug are one screen |
| `binds` | `field` | which `displays=`/`inputs=` attribute this wireframe element shows |
| `command` | `action` | which Command this affordance issues — checked against the screen's edge |
| `context` / `system` | model cell | which business context this model is, and which system it belongs to |
| `public` | event | another model in this system may consume it. The only public surface there is |
| `from` | external | the sibling model that publishes it — **checked** |
| `origin` | external | a genuinely foreign system — a claim on record, unverifiable |

`displays` is what makes the check two-directional. Without it a read model can be missing every
attribute and nothing notices, because nothing states what the screen needed.

Type suffix `?` means nullable. Generators read the compiled IR, never this XML.

### Three ways an attribute gets its value, and they are not interchangeable

An attribute that no upstream source supplies by name is red. There are exactly three honest ways
to answer that, and picking the wrong one produces code that compiles and is wrong.

| | Means | Generator emits |
| --- | --- | --- |
| `mappings="total=totalAmount"` | the **same value** under another name | an assignment |
| `derived="dayTotal=hours"` | **computed** from upstream — a sum, a count, a fold | a fold |
| `terminal="closedBy:actor"` | arrives from **context**, not the data flow | a handler lookup |

**A rename cannot change the type.** `mappings="dayTotal=hours"` claims dayTotal *is* hours; it is
really their sum. `mappings="month=date"` claims a `string` *is* a `DateOnly`. Both pass a
name-match and both are lies a generator will act on, so a mapping whose declared types differ is
warned as `mapping-crosses-types`.

`derived` inputs are checked: each must be an attribute an upstream source supplies, **or the
label of an upstream source itself**. That second form is what lets a fold over event *presence*
be stated — `monthStatus=BookingMonthStarted+MonthClosureSubmitted+MonthClosed`, whose "Open"
value is the *absence* of a closure event and which no rename could ever reach. Naming an event
that isn't connected is an error: a derivation cannot invent its inputs.

`terminal` kinds are `actor` (the authenticated principal), `generated` (an id the handler mints),
`clock`, and `const`. Same `name:kind` shape as `fields=`. These are reported as notes rather than
silently skipped, because "the handler supplies this" is a claim worth a reader disagreeing with.

Note `bookingId` on a booking command: the screen *displays* a `bookingId` — the row being looked
at — while creating a booking needs a **new** one. Same name, opposite meaning, and a name-match
cannot tell them apart. That is `terminal="bookingId:generated"`, not a source.

## The slice cell: a vertical slice is a thing, not a string

A slice used to have no identity — it was a `slice=` string repeated across the cells that
happened to belong to it. So membership was invisible on the canvas (drag a cell into another
column and nothing noticed), the pattern was inferred and never declared, and there was nowhere
to record a fact about the slice itself.

A **slice cell** is that identity: one `em="group"` rectangle drawn around the slice's columns.

```xml
<object id="slice-book-hours" label="book-hours&#10;command · in-design"
        em="group" slice="book-hours" pattern="command" status="in-design">
  <mxCell style="fillColor=none;strokeColor=#b85450;dashed=1;..." vertex="1" parent="1">
    <mxGeometry x="1260" y="0" width="220" height="645" as="geometry" />
  </mxCell>
</object>
```

Use a **plain rectangle, never a draw.io container.** A container reparents its children and makes
their `mxGeometry` relative to the parent, which breaks every absolute-x reader — `geometryOf`,
marker placement, `tools/crop.mjs`.

`pattern` is one of `command`, `view`, `automation`, `translation` (the cheat sheet's four), plus
`upstream` for a column that is only external events landing in our stream. It is **checked
against what the slice actually contains** — declaring `automation` on a slice with no View is an
error. Declared and derived disagreeing is a bug worth catching.

A slice must be **one contiguous band**. If a slice's columns aren't adjacent, that's a layout bug:
reorder the columns. A vertical slice that isn't vertical isn't a slice.

Every element geometrically inside a band must declare that `slice=`, and every element declaring
it must be drawn inside. That is what stops the drawing and the data drifting apart.

## The screen: identity, and a wireframe the checker can see

Two problems, both invisible before `screen=` existed.

**A screen had no identity.** It was a repeated *label* — `Timesheet` is three cells in `booking`,
with `displays=` hand-copied between them and nothing comparing the copies. Exactly the bug the slice
cell fixed for slices. `screen="timesheet"` is the slug, and it buys one asymmetric rule:

> **`displays=` must agree across cells sharing a slug. `inputs=` may differ.**

What a screen *shows* is a property of the screen. What it *offers* is a property of the slice — the
same Timesheet offers book, correct and remove in three slices. That asymmetry is load-bearing, not
a convenience: *"there may be only one `HoursBooked` per day+project, so booking again is a
Correction"* is a domain fact about affordances, and it is why one screen legitimately has three
different buttons.

**A wireframe drawn as a picture earns nothing.** The book does draw wireframes and they are
sketch-level, but a grey box the tool cannot read will drift from `displays=` silently. So every
element of a wireframe declares what it is — `em="field" binds="hours"`, `em="action"
command="BookHours"`, `em="chrome"` for decoration. Then the design and the model check each other
in both directions, the same trick `displays=` plays on read models:

- a field bound to something the screen doesn't declare → **error**. The design shows data the
  system cannot supply.
- a declared attribute the wireframe never draws → **warning**. Its View is over-specified.
- an action naming a command the screen has no edge to → **error**. The button and the arrow
  disagree.

Wireframes are **optional and late**: a screen with none is fine, and `field-not-drawn` only fires
once a screen has started to be drawn. Drawing one before the completeness check passes commits to
showing fields that may turn out to have no source.

```
node tools/wireframe.mjs scaffold <file>   # grow the UI lane, shift everything below, bind a cell
                                           # per attribute, read the action off the real edge
```

That is a **scaffold, not a design**. The stacked layout it produces asserts nothing about the real
arrangement — its value is that the cells exist, are bound, and are checked. Rearrange them
afterwards. It is a tool rather than a hand edit because it touches every y and every routing point
in the file.

Keep the wireframe **low fidelity**: no colour, no type, no imagery. It stays legible at model scale,
it cannot be mistaken for the design, and it does not fight the sticky-note grammar.

### Three skills, and the line between them is what each may invent

| Skill | Scope | Invents | Gate |
| --- | --- | --- | --- |
| `event-model` | once per context | layout only — never a domain fact | the completeness check, deterministic |
| `styling` | once per **system**, then per new screen | tokens, palette, spacing, components | the human likes it |
| `codegen` | per slice | nothing — it reads the compiled IR | tests pass |

**`styling` delegates aesthetic judgement to Anthropic's official `frontend-design` plugin** rather
than reinventing design taste — install via `/plugin`. That plugin already supplies the token-system
spec (4–6 colours, 2+ type roles, one signature element), the anti-templated-default heuristics, and
the restraint discipline; its workflow even asks for screenshots to self-critique with, which is
exactly what `tools/design.mjs` provides. `styling` adds only what the plugin cannot know: the field
contract from the model, the `designs/<screen-slug>.html` convention, and the review loop.

The wireframe belongs to `event-model`, and the boundary is not obvious: `binds=` and `em="action"`
carry **business information** — which fields a screen shows, which are typed, and which action it
offers. That last one is a domain fact, not decoration. Colour, type, spacing and components carry
none, so they live in `styling`.

**A dependency graph, not a pipeline.** Styling gates only *frontend* codegen. A model with no
screens is backend-only and can go straight to codegen with no design in existence — `notifications`
is exactly that today. Same for any View or Automation slice.

The styled design is found **by convention, not by an attribute**: `designs/<screen-slug>.html`. The
slug already exists, so a `design=` attribute would be a second place the same fact lives — the thing
this kit refuses everywhere else. That gives a three-way check, which is `styling`'s to run:

```
displays= / inputs=   ↔   wireframe binds=   ↔   HTML data-em
```

All three must agree on *which fields*. Layout and style are free to differ — that is the point of
keeping them in separate artifacts.

### A design nobody has looked at is worth exactly as much as unrendered XML

*"Never hand over diagram XML you have not rendered"* applies unchanged to CSS. **A human cannot
read a stylesheet and picture the result, and neither can Claude.** So the design gets the same
closing loop the model has, via headless Chrome — already on this machine, no Playwright, no
Puppeteer:

```
node tools/design.mjs sheet designs/<system>/
```

It produces three things, and each answers a different reviewer:

| Artifact | For | Why it exists |
| --- | --- | --- |
| `_shots/<screen>-<viewport>.png` | the record | one file per screen per viewport, so a finding can name the one that broke |
| `_shots/contact-sheet-<viewport>.png` | **looking** | every screen at **1:1** in one image. A folder of PNGs has the same defect as a folder of HTML — you open them one at a time |
| `index.html` | the human | live iframes plus a full-size link. A screenshot cannot be hovered, tabbed through, or resized |

**One sheet per viewport, at native width.** A 1440px shot scaled into a shared column is
illegible, which defeats the point of looking; and the sheet is captured at whatever size fits all
its rows, because a fixed height silently crops the last one. Both of those were real defects caught
by rendering the sheet and looking at it.

Always shoot at least a desktop and a mobile width. A single desktop screenshot hides half the
problems.

## Many small models, one system

> *"It is perfectly fine to have more than one model on a board. In fact, this is the rule rather
> than the exception for me. I prefer having many smaller models over one large model… I aim to
> capture one business context in each model, so I can read it from left to right without any
> visual interruptions."* — Understanding EventSourcing, ch. 18

Four levels, only two of them files. A **system** is a folder under `diagrams/`. A **model** is one
`.drawio` in it: one business context, one flow. A **slice** is a slice cell, as always. *Chapters*
(Dilger's blue arrows grouping slices inside a model) are the fourth, and deliberately not built —
they solve the same problem as splitting at a smaller scale, so **prefer splitting.**

```
diagrams/hour-booking/            <- the folder IS the system
  booking.drawio                  <- one business context
  month-closure.drawio
  notifications.drawio
  booking.errors.drawio           <- an alternative flow of booking.drawio
  _context-map.drawio             <- GENERATED. Never hand-edit; leading _ excludes it from validate
  OPEN-QUESTIONS.md
```

**No manifest file.** No `system.yml`, no index. The diagram is the single source of truth; a
manifest would be a second place facts live. The folder is the system, every fact sits on a cell,
and anything system-wide is *derived*.

**Each model names itself with a model cell** — `em="model"`, `context=`, `system=`. This is
Dilger's pink "Model Context" sticky, drawn top-left above the lanes. Same precedent as the slice
cell: identity is a cell, not a filename. `context=` must match the file name.

### Only an event crosses a model boundary

Ch. 15 is explicit that you never let another model rebuild your state from your internals. So:

> **A model's only public surface is an event marked `public="true"`. A consumer imports it as a
> yellow external declaring `from="<context>"`.**

Nothing else crosses — no read model, command, screen or unmarked event. A View belongs to the
context that reads it; if two contexts need the same projection, each builds its own from the
events it imports.

An external event now answers *where it came from*, and the two answers are checked differently:

| | Means | Checked |
| --- | --- | --- |
| `from="month-closure"` | published by a sibling model in this system | **yes** — the label must exist there, be `public="true"`, and its `fields=` must cover what we consume |
| `origin="Google Calendar"` | a genuine third party | no — a claim on record, exactly as before |

That first row is checking power a single model cannot have. Inside one file an external is terminal
by construction; across a folder the producer is present, so an import nobody publishes is an
**error** rather than a note.

Direct consumption between contexts of one system is allowed — the book is explicit that a context
is *not* a microservice and that you should *"not split but keep everything in one system until you
know more."* Full ch. 15 translation (View → automation → command → external event) is for a real
system boundary. What the kit insists on is that the coupling is **declared**: undeclared is an
error, declared is a note on the context map. Same treatment as a Conway split.

### The size budget is one readable render

The book's criterion is readability, not a slice count. This kit already has the operational form of
that rule — *always render and look* — and `tools/crop.mjs` exists only because a model defeated it.
So: **if you need `crop.mjs`, the model is too big.** `model.mjs` warns above **3200px** (≈10
columns, ≈8 slices); it never blocks, because a genuinely linear ten-slice story is legitimate.

Alternative flows are the other splitting axis: *"pick one flow and model it… Most of the time, it's
easier to define a dedicated model"* for the error cases that would disrupt it. Cheap ones stay GWTs.

**Slice names are unique across the system** — a slice is a branch and a ticket.

## Conway: who can actually build a slice

The other half of step 7, and the one a swimlane is *not* about.

> *"Ideally, each Slice should be owned by a single team… What if the UI and backend are owned by
> different teams? … An Event Model often exposes organizational challenges — this is Conway's Law
> in action. If it's not possible to assign a Slice to a single team, that's a direct result of the
> company's structure."* — Understanding EventSourcing, ch. 43

`owner=` goes **on the lane**, because the usual fault line is UI vs backend. An element may
override its lane; a slice cell may declare `owner=` for accountability and `owners="a, b"` to
acknowledge a genuine split. The rule then **computes** which slices need more than one owner
rather than trusting a label.

This does not forbid a split — the book says it is often unavoidable. It makes you say so out
loud, because discovering it during implementation costs far more than during modelling. An
unacknowledged split is a **warning**; an acknowledged one is a note.

Here `owner` is the **agent** that generates the slice, not a human team: `frontend-agent` on the
UI lane, `backend-agent` on Commands and Event Stream. **The GWT band is deliberately unowned** —
the business rules are the contract *between* the two, and belong to neither.

The result is structural rather than accidental: **every State Change slice crosses the line and
no other slice does.** A State Change slice is screen → command → event by definition, while Views
and Automations never touch a screen. So in this model 7 of 19 slices need both agents, and the
7 are exactly the command-pattern slices.

## Time runs left to right, and Event → View is the only way back

*"The goal is to read the system from left to right. It should be a story that makes sense to
everybody."* A connection pointing left is a connection nobody can read, so `flow/backward-connection`
is an **error**.

The single exception is **Event → View**. A read model is necessarily fed by events that occur
after the point it is first drawn — `MyTimesheet` is fed by the `HoursCorrected` that the very next
slice produces. The alternative is redrawing the View everywhere it is read, which is the canonical
form but doubles the width of the model. The exception is deliberate; anything else pointing left
is a layout bug, and the fix is to reorder the columns.

In practice this bites where a **screen reads a View drawn to its right**. Put the View's column
first: the screen feed then runs forward, and the event feeding the View runs back under the
exception.

## Swimlanes: stream boundaries, not team boundaries

A swimlane is **not** an org chart. *"Swimlanes define stream boundaries. Typically, all events in
one swimlane end up in a physical stream"* — Understanding EventSourcing, ch. 7. One horizontal
band per business capability, drawn **inside** the Event Stream lane, declaring which aggregates
it holds:

```xml
<object id="swim-timesheet" label="Timesheet stream" em="lane"
        streams="Timesheet" identity="employeeId, month">
```

An event's **y is its stream**, not its column. Its `aggregate=` must match the band it is drawn
in, and an event drawn in no band has an undefined stream — both are errors.

### `identity=` — what keys ONE stream, and why it is a domain question

Marten keys a stream. Without `identity=` a generator has nothing to append to, and every attribute
rule can pass while the model stays silent about it — which is exactly what happened here, right up
to the point of writing code.

`identity=` is **required on any band holding events we write** (`band-needs-identity`), and every
name in it must appear on **every** owned event in that band (`identity-not-on-every-event`). Bands
holding only imports or foreign events are exempt: we project from those streams, never append.

The choice decides **which business rules are real invariants**, so it is not a technical detail:

| Timesheet keyed by | *"at most 18 hours in a day"* is |
| --- | --- |
| `bookingId` | not an invariant — a check against an eventually-consistent projection, and two concurrent bookings can both pass |
| `employeeId, month` | a true aggregate invariant, enforced inside the transaction |

`hour-booking` chose `employeeId, month`, which **required adding `month:string` to all four
Timesheet events and their commands** — the key has to be on every event or the event cannot say
which stream it belongs to. Expect that ripple; it is the normal cost of the decision.

The rule worth enforcing is the little book's, ch. 11:

> *"A single command should never interact with multiple swimlanes or aggregates. The moment you
> do this, you introduce the need for a transactional boundary around the operation."*

So `command-crosses-swimlane` is an error, not a warning. Two effects that must happen atomically
are not two aggregates — they are one.

**A swimlane is not a lane**, and `buildIr` deliberately keeps it out of `lanes`. `laneOf()` takes
the first containing match, and `parseCells` returns every `<object>` before every bare `<mxCell>`
— so a swimlane authored as an object would be found ahead of the lane containing it, and every
event would look misplaced. Anything spanning the model must also be clamped in `tools/crop.mjs`
or it blows out the export bounds.

**The validation test is manual and worth doing.** From the same chapter: hide every swimlane but
one, read its events left to right to someone from the business who cannot see the model. They
should form a compelling narrative. If the story does not hold, the stream boundary is wrong — and
nothing automatic will tell you.

### `status` turns the gate from global into per-slice

`in-design` → `ready` → `in-progress` → `in-review` → `closed`.

A slice cannot leave `in-design` while its own cells still carry errors, or while a State Change
slice has no GWT. This is the book's gate applied per slice rather than to the whole model, which
is what makes thin-slice-first delivery possible — one unresolved attribute in a far corner no
longer blocks work that is genuinely ready.

**`in-progress` is advisory, not a lock.** A `.drawio` in git provides no mutual exclusion: two
agents on two branches can both set it, both succeed, both merge. Real exclusion comes from the one
atomic operation git has — creating a ref. **One branch per slice.**

### Labels are not unique, and nothing may assume they are

One event type reachable from two slices is drawn as two cells with the same label; screens repeat
across every slice that triggers from them. A `label -> element` map keeps only the last of each.
The three GWT fields therefore resolve at different scopes:

| Field | Scope |
| --- | --- |
| `when` | this slice only — it must be this slice's Command |
| `then` | this slice first, then anywhere — the event this slice's Command emits |
| `given` | anywhere — prior events almost always come from *earlier* slices |

Scoping `given` to the slice would break every honest GWT.

## The information completeness check

The point of the whole method, and a **gate** rather than a report: *"The implementation cannot
begin until this check is passed."*

> "For every attribute in an Element, you should always verify that the data is provided by the
> connected sources."

It applies to every element, not just read models:

| Element | Its attributes must be supplied by |
| --- | --- |
| Read model | the Events pointing at it |
| Event | the Command that triggers it — *"Commands generally have to provide all data necessary to persist an event"* |
| **External event** | **nothing — it is terminal.** We have neither control over it nor knowledge of what produced it; that is what `external` means. Reported as a note, not an error, so the upstream contract still gets confirmed once |
| Screen (`displays`) | a View feeding the screen. No View means the screen cannot know it |
| Command | the triggering screen's `displays` + `inputs` |
| Automation's command | the todo-list View the automation watches — an automation types nothing |

GWTs are checked for referential integrity too: `when` must name a Command in the same slice, and
`given`/`then` must name Events that exist. A GWT naming an event that isn't in the model is a
rule nobody can implement, and it reads as perfectly correct on the canvas.

Failures are marked **on the connection**, in red: *"If any data is missing, the connection is
automatically highlighted in red… you can quickly confirm that all the arrows are black."* We also
badge the failing element, because a red arrow alone doesn't say which attribute is unsourced.

Business rules are captured as GWT, one cell each, in the band below the slice:
`GIVEN a set of Events, WHEN a Command, THEN a new set of Events`. Ten or more per slice is
normal — *"Don't save on GWTs."*

## The four building blocks and the four patterns

Source: the [Event Modeling Cheat Sheet](https://eventmodeling.org/posts/event-modeling-cheatsheet/).
These are the whole grammar. A connection that is not part of one of these four patterns is a bug.

Blocks: **Trigger** (a user at a screen, an external API call, *or an automated process*),
**Command**, **Event**, **View** (a read model / report).

| Pattern | Sequence |
| --- | --- |
| Command | `Trigger -> Command -> Event(s)` |
| View | `Event(s) -> View` |
| Automation | `Event(s) -> View -> Automated Trigger -> Command -> Event(s)` |
| Translation | `Event(s) (source system) -> View -> Automated Trigger -> Command -> Event(s) (other systems)` |

**An automation is a Trigger, not an event handler.** It is a peer of a user at a screen: it
*looks at a View* and *issues a Command*. It never receives an event and never emits one.

`Event -> Processor -> Event` is a classic anti-pattern. The View an automation watches is a
**todo list**: the event puts a row on it, the automation works the row and issues a command, and
the resulting event ticks the row off. Skip the view and you lose both the record of pending work
and the thing that stops the processor working the same row twice.

Per the same source, if there is no view and no conditional logic, it is not an automation at all
— it is just a command that emits several events.

## Layout grid

Time flows left to right. Three lanes, plus a GWT band below them because GWTs are drawn
vertically under the pattern they describe.

| Band | y | Height | Holds |
| --- | --- | --- | --- |
| *model context note* | 30 | 90 | the pink cell naming this model |
| UI | 160 | 390 | screens, 300 tall so a wireframe fits inside one |
| *UI routing strip* | 500 | 50 | horizontal runs of View → Screen feeds, below the screens |
| Commands / Views | 550 | 180 | commands, read models, automations |
| *forward routing band* | 730 | 140 | horizontal runs of long Event → View feeds |
| Event Stream | 870 | grows with the swimlanes | events, split into one band per stream |
| *backward routing corridor* | event lane bottom + 10 | 200 | horizontal runs of edges pointing left |
| GWT | event lane bottom + 240 | grows down | one `gwt` cell per business rule |

Lanes start at x=40. Columns are 320 apart — x=100, 420, 740, 1060, … — with elements 180 wide,
events and commands 60 tall, **screens 180×300** (a screen has to hold its wireframe, and 180 wide
is not a choice: a wider screen would overflow its 220-wide slice band).

**Every long edge gets its own y in a routing band.** One y per *target* is not enough: several
events feeding the same View then share a horizontal run and the picture becomes unreadable.
Allocate sequentially — forward at `forwardBand + 6 + 8n`, backward at `eventLaneBottom + 15 + 9n`,
View → Screen at `uiLane + 345 + 8n`. No band holds a box, so a routed edge never cuts through
anything.

**Events stacked in one column need a left corridor, not a vertical run.** Several externals in the
same column feeding the same View cannot all go straight up — the lower ones would cut through the
ones above. Send them out the left edge and up a corridor at `columnX - 30 - 12n`.

GWT cells are 300 wide (they hold sentences) and 120 tall, left-aligned to their slice's column,
first row at **y=1375** and every 140 after. 300 + 20 fits the 320 column pitch exactly, so a
slice's GWTs never collide with the next slice's. **Put the rule text in the label**, not only in
`rule=` — several GWTs in a slice share a `given/when/then` triple and differ only in the case they
describe, so without it they render as identical grey boxes.

Add a column by widening the page and every lane, rather than stacking a second row into a routing
band. Page width = `40 + laneWidth + 60`.

These numbers move whenever a swimlane is added. Read them off the model rather than trusting this
table; `tools/model.mjs` derives everything from geometry and never hard-codes a y.
