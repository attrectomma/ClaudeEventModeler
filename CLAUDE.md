# ClaudeEventModeler

Event Modeling diagrams in draw.io, edited by both a human (visually, in VS Code) and Claude
(as XML). The `.drawio` file is the single source of truth — there is no database and no
export step to keep in sync.

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
node tools/verify-mcp.mjs              # re-prove the MCP read/write link end to end
```

## Event Modeling conventions

Three horizontal lanes, time flowing left to right. Fill/stroke pairs are preset in
`.vscode/settings.json`, so the same swatches appear in the draw.io colour picker.

| Element | Lane | Fill | Stroke |
| --- | --- | --- | --- |
| UI / wireframe | UI / Wireframes | `#ffffff` | `#666666` |
| Command | Commands / Automation / Read Models | `#dae8fc` | `#6c8ebf` |
| Automation / processor | Commands / Automation / Read Models | `#e1d5e7` | `#9673a6` |
| Read model / view | Commands / Automation / Read Models | `#d5e8d4` | `#82b366` |
| Event | Event Stream | `#ffe6cc` | `#d79b00` |
| External system | any (dashed) | `#f8cecc` | `#b85450` |

Rules:
- Events are past tense (`OrderPlaced`), commands imperative (`PlaceOrder`).
- Events only ever enter the Event Stream lane. Nothing else goes there.
- An event never points at another event, and never at an automation. See the patterns below —
  every connection must be part of one of the four.
- Give every cell a stable, meaningful `id` (`evt-order-placed`, not `node7`), so edits stay
  reviewable in diffs and edges keep resolving.
- On edges that would otherwise cut through a box, set explicit
  `exitX/exitY/entryX/entryY` hints. The free band between lanes is the place to route.

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

Page 1420x700. Lanes at y=40 / y=220 / y=400, each 1320x180, x=40.
Nodes 180 wide, columns at x=100 / 420 / 740 / 1060. Events and commands 60 tall, wireframes 90.
Keep the y=350..470 band clear for edge routing.

Columns are 320 apart, so widen the page and the lanes to add one (`1420 = 40 + 1320 + 60`)
rather than stacking a second row into the routing band. Long horizontal edges get explicit
waypoints inside the band — y=380 and y=440 are both in use in `order-flow` and don't collide.
