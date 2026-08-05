# designs/

Styled HTML/CSS designs, one folder per system. Produced and checked by the `styling` skill; see
[.claude/skills/styling/SKILL.md](../.claude/skills/styling/SKILL.md).

```
designs/hour-booking/
  tokens.css        one token set for the whole system. Nothing else defines colour or type
  timesheet.html    one page per screen= slug, found BY CONVENTION (no design= attribute)
  index.html        GENERATED — live iframes for a human to click through
  _shots/           GENERATED — screenshots and the contact sheet
```

## Look at it, don't read it

```bash
node tools/design.mjs sheet designs/hour-booking --widths 1440,390 --height 660
node tools/design.mjs check diagrams/hour-booking/
```

`sheet` renders every page at every viewport with headless Chrome and writes
`_shots/contact-sheet-<viewport>.png` — every screen at 1:1 in one image. That is the artifact to
look at. `index.html` is the one to hand a human, because a screenshot cannot be hovered, tabbed
through or resized.

`check` is the third leg of the three-way check: `displays=`/`inputs=` ↔ wireframe `binds=` ↔ HTML
`data-em`. A page showing a field the model does not declare is an **error**, not a style choice.

**Everything under `_shots/` and `index.html` is generated.** Hand edits will be overwritten.

## Status

| System | Screens | Styled | Notes |
| --- | --- | --- | --- |
| `hour-booking` | 4 | `timesheet` | the `book-hours` slice is `status="ready"`, so its screen went first |

Deliberately **one screen, one token variant.** The POC's job is to reach working generated code
once, end to end; styling all four screens before that proves nothing new. The other three report as
`design/design-not-drawn` — a note, not a failure — and their wireframes stand in.

**`tokens.css` has not yet been through Anthropic's `frontend-design` plugin**, which was not
installed when it was written. It is honest, restrained and grounded in the subject (a dense internal
tool, one signature element: hours on a proportional track against the 18h cap), but it is one
person's taste rather than that skill's. Install with `/plugin` and re-run `styling` to improve it —
the field contract and the checks will not change.
