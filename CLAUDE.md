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

Wolverine, Marten and Alba each need continuously updated, LLM-friendly documentation
available locally. Their APIs move faster than model knowledge, so anything generated against
remembered API shapes will be subtly wrong.

Marten and Wolverine both publish `llms.txt` (`https://martendb.io/llms.txt`,
`https://wolverinefx.net/llms.txt`) — a markdown index whose every entry is also served as raw
`.md`, so the whole doc set can be mirrored locally and refreshed. Not yet built.

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
```

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
| `mappings` | any | `targetField=sourceField`, for legitimate name mismatches |
| `given` / `when` / `then` | `gwt` | prior events / the command / expected events. `then="error: RuleName"` for an expected rejection |
| `rule` | `gwt` | the business rule this GWT names |

`displays` is what makes the check two-directional. Without it a read model can be missing every
attribute and nothing notices, because nothing states what the screen needed.

Type suffix `?` means nullable. Generators read the compiled IR, never this XML.

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
| UI | 40 | 180 | screens |
| Commands / Views | 220 | 180 | commands, read models, automations |
| Event Stream | 400 | 180 | events, external events |
| GWT | 620 | grows down | one `gwt` cell per business rule |

Lanes start at x=40. Columns are 320 apart — x=100, 420, 740, 1060, … — with elements 180 wide,
events and commands 60 tall, screens 90. Keep y=350..470 clear for edge routing; long horizontal
edges get explicit waypoints in it.

GWT cells are 300 wide (they hold sentences) and 100 tall, left-aligned to their slice's column.
The first row starts at **y=650**, not 620 — the band's own label occupies its top edge, and a row
at 620 renders over it. Subsequent rows every 120px: 650, 770, 890, … 300 + 20 fits the 320 column
pitch exactly, so a slice's GWTs never collide with the next slice's.

Add a column by widening the page and every lane, rather than stacking a second row into the
routing band. Page width = `40 + laneWidth + 60`.
