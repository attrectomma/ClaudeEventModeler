# Handover prompt — Figma / UI discussion

Paste everything below the line into a fresh session started **in this folder**
(`c:\Repos\Attrecto\ClaudeEventModeler`), so `.mcp.json`, `CLAUDE.md` and the project skills load.

---

We are building **ClaudeEventModeler**: a kit for doing Event Modeling in draw.io, where the
`.drawio` file is the single source of truth and both a human and Claude edit it. Read `CLAUDE.md`
first — it has the palette, the cell-data schema, the four patterns, the layout grid, and a
"gotchas already paid for" section. Then read `diagrams/hour-booking.OPEN-QUESTIONS.md`.

**Do not write any code generation.** That is explicitly out of scope for this conversation.

## Where things stand

`diagrams/hour-booking.drawio` is a complete worked model of an hour-booking domain (employees book
work hours against projects; admins close months). It validates clean:

```
node tools/model.mjs validate diagrams/hour-booking.drawio
  ->  0 errors, 0 warnings, 51 notes    19 slices / 49 elements / 55 GWTs
```

All of Dilger's steps are done, including both halves of step 7 (swimlanes = stream boundaries,
and Conway = who builds what). The tooling grew six rule families: `grammar`, `completeness`,
`gwt`, `flow`, `conway`, `slice`.

**The model is a throwaway POC.** Its purpose is to prove the *tooling*, not to be a real timesheet
product. Phases 0–2 and every business rule are the domain expert's own words, quoted in `source=`
on each cell. Screens and field names were delegated to Claude and are marked `proposed=`.

## What this conversation is for

Deciding what to do about **UI/design**, and specifically whether Figma (via MCP) belongs in the
kit. A front-end team's agents and skills are about to be added so the kit can go full stack.

The first thing to settle is which of these Figma actually is, because they lead different ways:

1. **Figma as the source** — designs already exist, and the model's screens and `displays=` should
   be reconciled against them.
2. **Figma as the target** — generate wireframes *from* the model's screens.
3. **Figma as a reference** — the front-end agent reads components and design tokens from Figma
   while generating code from the model.

## The seam you need to understand before proposing anything

Event Modeling deliberately keeps screens thin. The book: *"screens help foster understanding and
ensure everyone knows exactly what is being discussed"* — a named box is enough, and drawing UI is
explicitly not the point. So the model has **7 screen cells / 5 distinct screens**, each carrying
only:

- `displays=` — what the screen shows. Must be supplied by a View, and this is what makes the
  information completeness check two-directional.
- `inputs=` — what the user types. A terminal source.

That is the entire UI surface in the model, and it is the seam a design tool or a front-end agent
would attach to. **Whatever is proposed must not turn the event model into a UI spec** — that would
break the method. The interesting question is what lives in Figma versus what lives on the cells,
and how they stay honest with each other.

Relevant: `owner=` is already on the lanes. The UI lane is `frontend-agent`, Commands and Event
Stream are `backend-agent`, and the GWT band is deliberately **unowned** because the business rules
are the contract *between* them. 7 of 19 slices need both agents — exactly the State Change slices,
since screen → command → event crosses the line by definition. `book-hours` is at
`status="ready"` and is the natural pilot.

## Rules of engagement that have been earned the hard way

- **Never invent a domain fact.** Not an event, attribute, business rule or screen. Ask. An
  invented field looks exactly like a real one in XML and passes every check.
- **Always render and look.** `node tools/drawio.mjs render <file>`, then Read the PNG. The model
  is ~7400px wide, so use `node tools/crop.mjs <file> <x0> <x1> <out>` to inspect it in windows.
  Layout defects are invisible in XML and obvious in the image; this has caught real bugs
  repeatedly.
- **A green run does not mean the model is right.** `OPEN-QUESTIONS.md` lists nine things the
  checker structurally cannot see.
- **Never save a draw.io tab that was open before Claude edited the file** — the extension holds a
  stale snapshot and will silently overwrite. Say explicitly when the file has changed on disk.
- **Never put markdown or JS template literals through bash heredocs.** Backticks get
  command-substituted and mangle the file. Use the Write/Edit tools. This went wrong three times.
