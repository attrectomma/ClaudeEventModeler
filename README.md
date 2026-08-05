# ClaudeEventModeler — a guide for humans

A kit for doing **Event Modeling** in draw.io, where the `.drawio` file is the single source of
truth and both a human (visually, in VS Code) and Claude (as XML) edit the same file. A deterministic
checker then enforces that the picture is actually implementable.

The goal is specific: **one person — backend, frontend, or business analyst — can take a domain from
conversation to working full-stack software.** Everything here exists to serve that.

> This document is for people. [CLAUDE.md](CLAUDE.md) is the same knowledge written for the agent —
> denser, imperative, and the authority when the two disagree. Read this first, then that.

---

## 1. Why this exists

Event Modeling gives you a picture that is also a specification. The usual problem is that the
picture rots: it lives in Miro, the code lives in git, and within a month they disagree and nobody
trusts the picture any more.

This kit makes three bets to stop that:

1. **The diagram is the source of truth.** No database, no export step, no second copy. The
   semantics — field names, types, business rules, ownership — live *on the cells* as custom
   attributes, so there is exactly one place a fact can be.
2. **A machine checks it.** The method's central gate — *"the implementation cannot begin until this
   check is passed"* — is a program, not a promise. `model.mjs` walks the diagram and says which
   attribute has no source.
3. **The file is plain text.** mxGraph XML, so git diffs it, review works, and Claude reads and
   writes it directly with no server in the loop.

The method is Martin Dilger's, from *Understanding EventSourcing*; the full text is in
[reference/](reference/) and quoted throughout the docs so you can check any rule against its source.

---

## 2. The mental model, in one minute

Four levels. Only two of them are files.

| Level | Is | Where it lives |
| --- | --- | --- |
| **System** | a product, a deployable whole | a folder: `diagrams/hour-booking/` |
| **Model** | one business context, one flow | one file: `booking.drawio` |
| **Slice** | the unit of work — one branch, one ticket | a dashed pink rectangle drawn around its columns |
| **Element** | a screen, command, event, view, automation | one cell |

**Time runs left to right.** Every model reads as a story from one side to the other. A connection
pointing left is one nobody can read, and it is an error — with a single deliberate exception
(Event → View), because a read model is necessarily fed by events later than the point it is drawn.

**A model must be readable in one render.** That is the size budget, and it is why the worked example
is three files and not one. If you find yourself cropping a model to look at it, it is too big.

---

## 3. What you are looking at

Colours are the book's, not ours. They are preset in `.vscode/settings.json`, so the same swatches
appear in draw.io's colour picker in this order.

| Colour | Element | `em=` | What it means |
| --- | --- | --- | --- |
| white | Screen | `screen` | where a person is standing |
| **blue** | Command | `command` | an intent — `PlaceOrder` |
| **orange** | Event | `event` | a fact that happened — `OrderPlaced` |
| **yellow** | External event | `external` | a fact from outside this model |
| **green** | Read model / View | `readmodel` | data assembled for someone to look at |
| purple | Automation | `automation` | a process that watches a View and issues a Command |
| grey | Given/When/Then | `gwt` | one business rule |
| pink | Slice band / Model name | `group` / `model` | identity, not content |

Four horizontal bands, top to bottom: **UI** (screens), **Commands / Views**, **Event Stream** (split
into one swimlane per stream), and a **GWT band** below everything holding the business rules,
stacked under the slice each belongs to. The gaps between bands are not empty — they are routing
corridors, so long edges never cut through a box.

Start here: open [diagrams/hour-booking/booking.png](diagrams/hour-booking/booking.png). That is a
whole business context in one picture — 8 slices, 3 screens, the rules underneath.

---

## 4. Your first hour

```bash
npm install                                        # only needed for the MCP server

# Look at the worked example.
node tools/drawio.mjs render diagrams/hour-booking/booking.drawio
node tools/model.mjs validate diagrams/hour-booking/
node tools/model.mjs map      diagrams/hour-booking/    # regenerates the context map
```

Then, in order:

1. **Open the PNG**, not the XML. The picture is the point.
2. **Open the `.drawio` in VS Code** (the Draw.io Integration extension). Click a cell, press
   **Ctrl+M** — *Edit Data*. Those attributes are the specification. This is the whole trick.
3. **Read a `validate` run.** 0 errors is the gate; the notes are claims to disagree with (§7).
4. **Read [diagrams/hour-booking/OPEN-QUESTIONS.md](diagrams/hour-booking/OPEN-QUESTIONS.md)** —
   especially the last section, which lists twelve things the checker structurally *cannot* see. A
   green run does not mean the model is right.

To model something of your own, say *"let's model X"* to Claude and it runs the `event-model` skill
(§8). You supply the domain knowledge; it asks the questions and does all the drawing.

---

## 5. The grammar: four blocks, four patterns

This is the whole language. **A connection that is not part of one of these four patterns is a bug**,
and the checker will say so.

Blocks: **Trigger** (a person at a screen, an external system, *or an automated process*),
**Command**, **Event**, **View**.

| Pattern | Shape |
| --- | --- |
| Command | `Trigger → Command → Event(s)` |
| View | `Event(s) → View` |
| Automation | `Event(s) → View → Automated Trigger → Command → Event(s)` |
| Translation | same as Automation, but crossing a system boundary |

Two consequences that catch people out:

- **An automation is a Trigger, not an event handler.** It is a peer of a person at a screen: it
  *looks at a View* and *issues a Command*. `Event → Processor → Event` is a classic anti-pattern.
  The View it watches is a **todo list** — the event puts a row on it, the automation works the row,
  and the resulting event ticks it off. Skip the view and you lose both the record of pending work
  and the thing stopping the processor working the same row twice.
- **One Command per State Change slice.** The little book, asked whether you can have more: *"No."*
  More than one Event is allowed but *"should not be the rule."*

---

## 6. The vocabulary you will actually type

Attributes you set through *Edit Data* (Ctrl+M). The full list is in [CLAUDE.md](CLAUDE.md); these
are the ones that come up daily.

| Attribute | On | Means |
| --- | --- | --- |
| `slice` | everything | which slice this belongs to. Untagged cells generate nothing |
| `fields` | command, event, view | `name:Type` list. `?` means nullable |
| `aggregate` | command, event | which stream owns it — must match the swimlane it is drawn in |
| `displays` | screen | what the screen shows. **Must be supplied by a View** |
| `inputs` | screen | what the user types here. A terminal source |
| `given` / `when` / `then` | gwt | the business rule, machine-checkable |
| `pattern` / `status` | slice band | which of the four patterns; where it is in the workflow |

### The three honest answers when a name does not line up

An attribute nobody upstream supplies is red. There are exactly three ways to answer that, and
**picking the wrong one produces code that compiles and is wrong**:

| | Means | Ask yourself |
| --- | --- | --- |
| `mappings="total=totalAmount"` | the **same value**, another name | "is this literally the same number?" |
| `derived="dayTotal=hours"` | **computed** — a sum, a count, a fold | "how is it worked out?" |
| `terminal="closedBy:actor"` | arrives from **context**, not the data flow | "who supplies this — the user, the clock, the handler?" |

A rename cannot change the type. `mappings="dayTotal=hours"` claims dayTotal *is* hours when it is
really their sum — a lie a generator would act on, so it is warned about.

---

## 7. Reading a `validate` run

```
node tools/model.mjs validate diagrams/hour-booking/     # a whole system
node tools/model.mjs validate diagrams/hour-booking/booking.drawio   # one model
```

**Validate the folder, not the file.** A single file cannot see whether an imported event is
published anywhere.

Three severities, and the third is the one people misread:

- **ERROR** — the model is not implementable. This is the gate. Exit code 1.
- **WARN** — probably wrong, or a hole left open on purpose.
- **INFO / note** — **a claim the tool is making on your behalf, which you should read and disagree
  with if it is wrong.** "The handler supplies this." "This timestamp comes from the clock." "This
  external event is terminal." The worked example has 108 notes and zero are noise.

Ten rule families, and what each is actually for:

| Family | Answers |
| --- | --- |
| `grammar` | is every connection one of the four patterns? |
| `completeness` | does every attribute have a source? **The central gate** |
| `gwt` | do the business rules name a Command and Events that exist? |
| `flow` | does every connection point left to right? |
| `swimlane` | is every event in the right stream, and does any Command cross two? |
| `slice` | is each slice a real contiguous band whose declared pattern matches its contents? |
| `conway` | can each slice be built by one team, or does it span the org chart? |
| `screen` | do cells sharing a screen agree, and is the wireframe bound to real attributes? |
| `system` | does every cross-model import resolve to something actually published? |
| `hygiene` | is anything unclassified or unassigned? |

Two of these are worth understanding properly because they are the ones that catch real bugs.

**`completeness` is the point of the whole method.** *"For every attribute in an Element, you should
always verify that the data is provided by the connected sources."* It applies to every element, not
just read models: an Event's fields must come from its Command; a Command's from the triggering
screen's `displays` + `inputs`; a Screen's `displays` from a View feeding it. External events are
terminal — we have neither control over them nor knowledge of what produced them.

**`conway` computes who can build a slice** rather than trusting a label. Here `owner` is the *agent*
that generates the slice: `frontend-agent` on the UI lane, `backend-agent` on Commands and Event
Stream. **The GWT band is deliberately unowned** — the rules are the contract *between* the two.
The result is structural: every State Change slice crosses the line and no other slice does, because
screen → command → event crosses by definition.

### What the checker cannot see

Twelve things, listed in full in
[OPEN-QUESTIONS.md](diagrams/hour-booking/OPEN-QUESTIONS.md#what-the-deterministic-checker-cannot-see--do-not-trust-a-green-run-alone).
The three that bite hardest:

- **Missing edges.** The rules find unsourced *attributes*, never absent *connections*.
- **Which event creates a view's rows.** Sources are unioned, so an attribute from event A on a row
  created by event B is a runtime null and a black arrow.
- **Delete versus upsert.** `EmployeeRemovedFromProject → MyProjects` means *delete the row*; the
  checker reads it as supply. A delete supplies nothing.

**So: always render and look.** `node tools/drawio.mjs render <file>`, then actually open the PNG.
Layout defects and missing edges are invisible in XML and obvious in a picture. This has caught real
bugs repeatedly, and it is the single most valuable habit in the kit.

---

## 8. The three skills, and the order

| Skill | Scope | Invents | Gate | Status |
| --- | --- | --- | --- | --- |
| `event-model` | once per context | layout only — **never a domain fact** | the completeness check | **built** |
| `styling` | once per system, then per new screen | tokens, palette, spacing, components | zero `design/` findings, then the human likes it | **built** |
| `codegen` | per slice | business rules, folds, test data — never a domain fact | `dotnet test` green, and you have looked at the page | **built** |

**A dependency graph, not a pipeline.** Styling gates only *frontend* codegen. `notifications` has no
screens, so it is backend-only and could go straight to codegen with no design in existence.

### `event-model` — eleven phases, in order

Say *"let's model X"*. Claude asks; you answer; Claude draws. **It stops at every phase and waits** —
the value of the method is the conversation each phase forces.

| # | Phase | Gate |
| --- | --- | --- |
| 0 | Scope — which system, which context | you agree what is in and out |
| 1 | Brainstorm events (past tense, chaos welcome) | "what's missing?" |
| 2 | Storyboard into one left-to-right timeline | you can read the story back |
| 3 | Stream boundaries (swimlanes) | each band is a narrative on its own |
| 4 | Screens — named boxes, not UI | every triggering screen declares `displays=` |
| 5 | Derive data **backwards** | every cell has fields, or a stated reason |
| 6 | Cut slices | no `slice/` findings |
| 7 | **The completeness check** | **zero errors. Nothing proceeds past this** |
| 8 | Wireframes | every field bound, every declared field drawn |
| 9 | GWTs — the business rules | rejection cases present |
| 10 | Conway, and promote a slice to `ready` | splits acknowledged out loud |

Phase 5 is the engine: *"Backwards thinking is powerful as it focuses on the solution rather than the
problem."* You ask what the screen must show, then what the event must have stored to populate it,
then what the command must have provided to persist the event.

**The rule Claude will not break:** *never invent a domain fact.* Not an event, attribute, rule,
screen or stream boundary. It will ask. Anything it does have to guess is tagged `proposed=` on the
cell so you can find it later — in the worked example, every screen and field name is tagged that
way, because those were delegated deliberately.

### `codegen` — built, exercised on one slice

`book-hours` runs end to end: 10 GWT tests green against a real Testcontainers Postgres, plus a
React page ported from the design and screenshotted. The skill is the reasoning that produced it —
including the five API facts the docs got wrong, which cost real time and are now written down.

```bash
node tools/codegen.mjs diagrams/hour-booking      # 8 written, 35 kept
cd generated/HourBooking && dotnet test           # 11 passed, 45 skipped
```

Skipped is not failure: a slice at `in-design` has its GWT tests generated but skipped, so green
means the *claimed* slices pass and the skip count is what is left.

### `styling` — built, exercised on one screen

Design tokens and per-screen HTML/CSS. It will **delegate aesthetic judgement to Anthropic's official
[`frontend-design`](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)
plugin** (install via `/plugin`) rather than reinventing design taste, and add the three things that
plugin cannot know: the field contract from the model, the folder convention
(`designs/<screen-slug>.html`), and the review loop.

Because **a design nobody has looked at is worth exactly as much as unrendered XML**, and a human
cannot read a stylesheet and picture the result:

```bash
node tools/design.mjs sheet designs/<system>/
```

That renders every screen at desktop and mobile widths using headless Chrome (already on your
machine — nothing to install) and produces a **contact sheet PNG** showing every screen at 1:1 for
looking at, plus an **`index.html`** with live iframes for you to actually click through. Both,
because a screenshot cannot be hovered, tabbed through or resized.

Figma was evaluated and **deliberately dropped** for the POC — see the reasoning in
[MODEL-ORGANIZATION.md](MODEL-ORGANIZATION.md) and the git history.

---

## 9. The tools

| Command | Does |
| --- | --- |
| `model.mjs validate <dir>/` | the whole system: every model plus the cross-model rules |
| `model.mjs validate <file>` | one model |
| `model.mjs map <dir>/` | regenerate the context map from the real publish/import edges |
| `model.mjs mark <file>` | draw red badges and arrows on every failure, in place |
| `model.mjs clear <file>` | strip every marker, restoring the file byte-exactly |
| `model.mjs compile <dir>/` | the **system IR** a generator reads: shared contract + slices |
| `model.mjs compile <file>` | the JSON IR for one model |
| `docs.mjs sync` | mirror Marten/Wolverine/Alba docs into `reference/llms/` |
| `docs.mjs status` | how many doc pages are mirrored, and how stale |
| `drawio.mjs render <file>` | export a PNG beside the file |
| `drawio.mjs check <file>` | is this plain XML, or compressed? |
| `drawio.mjs inflate <file>` | decompress in place, making it readable |
| `crop.mjs <file> <x0> <x1> <out>` | an x-window of a too-wide model. Needing this is a smell |
| `wireframe.mjs scaffold <file>` | grow the UI lane and scaffold bound wireframe cells |
| `design.mjs sheet <dir>/` | screenshot every design page; build the contact sheet and index |
| `design.mjs check <dir>/` | the styled pages against the model — the third leg of the three-way check |
| `verify-mcp.mjs` | re-prove the Claude ↔ draw.io link over MCP end to end |
| `pdf-text.mjs <file.pdf>` | extract a PDF to greppable text |
| `check-frontmatter.mjs` | verify every skill and agent has parseable frontmatter |

`mark` is safe to use freely: it only adds overlay cells prefixed `chk-`, and `clear` removes them
exactly.

---

## 10. Gotchas that will cost you time

- **⚠️ Never save a draw.io tab that was open before Claude edited the file.** The extension reads
  the whole diagram into memory when you open it and only writes on save — it never notices the file
  changing underneath. So after Claude edits, your tab still holds the *old* diagram, and closing it
  offers to "save changes" you never made. **Answer no, close, reopen.** The tell is the editor
  disagreeing with a freshly rendered PNG. If it does get saved: `git checkout -- <file>`. This is
  the real reason to commit the model at every milestone.
- **Claude sees the file when it reaches disk**, not as your cursor moves. Save before asking.
- **Never hand-edit a generated file.** Anything starting with `_` (`_context-map.drawio`) is
  regenerated and your edits will vanish.
- **A compressed `.drawio` is invisible to Claude.** `drawio.mjs check`, then `inflate`.
- **`in-progress` on a slice is advisory, not a lock.** A file in git provides no mutual exclusion —
  two people can both set it and both merge. Real exclusion is **one branch per slice**.
- **Don't grow a model to avoid a decision.** If it stops being readable in one render, split it.

---

## 11. Where things stand

**The worked example is a throwaway POC.** `hour-booking` (employees book hours against projects,
admins close months) exists to prove the *tooling*, not to be a timesheet product. Phases 0–2 and
every business rule are the domain expert's own words, quoted in `source=` on each cell. Screens and
field names were delegated to Claude and are marked `proposed=`.

```
node tools/model.mjs validate diagrams/hour-booking/
  ->  0 errors, 0 warnings, 108 notes    3 models / 20 slices / 192 elements
```

| | Slices | GWTs | Width | Needs |
| --- | --- | --- | --- | --- |
| `booking` | 8 | 26 | 2900px | frontend + backend |
| `month-closure` | 8 | 21 | 2960px | frontend + backend |
| `notifications` | 4 | 8 | 1940px | **backend only** |

**Built:** the full method including both halves of step 7 (stream boundaries and Conway), slice
cells, screen identity, wireframes bound to the model, multi-model systems with checked cross-model
imports, the generated context map, and the `event-model` skill.

**Not built:** the `styling` skill, and code generation. Codegen has a known blocker — the enforced
stack is .NET 10 / Postgres / Wolverine / Marten / Alba / Testcontainers, and Wolverine, Marten and
Alba all move faster than model knowledge, so anything generated against remembered API shapes will
be subtly wrong. They publish `llms.txt`; mirroring it locally is a prerequisite and is not done.

---

## 12. Further reading

| | |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | the same knowledge for the agent. **The authority when docs disagree** |
| [MODEL-ORGANIZATION.md](MODEL-ORGANIZATION.md) | why many small models, and how they may reference each other |
| [ANTI-PATTERNS.md](ANTI-PATTERNS.md) | smells met while building the kit, and **which of them nothing automatic catches** |
| [diagrams/hour-booking/OPEN-QUESTIONS.md](diagrams/hour-booking/OPEN-QUESTIONS.md) | state of the worked example, and what the checker cannot see |
| [.claude/skills/event-model/SKILL.md](.claude/skills/event-model/SKILL.md) | the eleven phases in full |
| [reference/](reference/) | both books as greppable text — every rule here is traceable to them |

The two sources: Martin Dilger, *Understanding EventSourcing* (the long book) and *The Little
EventModeling Book*, plus the
[Event Modeling Cheat Sheet](https://eventmodeling.org/posts/event-modeling-cheatsheet/) for the four
patterns.
