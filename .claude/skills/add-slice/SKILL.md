---
name: add-slice
description: >-
  Add one slice to an event model from a dictated brief, or start a model with its first slice. Use
  when the user describes a slice they want — "I want a state change slice with a screen with a, b, c
  and a Send button", "we need a state view over all X showing a calculated y", "add an automation
  that…" — or says "add a slice", "append a slice", or invokes /add-slice. The user supplies the
  domain facts; this skill transcribes them onto cells, places the column, runs the gates, and reports
  what the brief did not cover. It never fills a gap by guessing.
---

# Add one slice

The user dictates the slice. You **transcribe, place, check, and report the gaps** — you do not
elicit and you do not invent.

Read `CLAUDE.md` first for the palette, the cell-data schema, the four patterns and the layout grid.

## This is not `event-model`

| | `event-model` | `add-slice` |
| --- | --- | --- |
| Direction | you ask, the user answers | the user dictates, you transcribe |
| Scope | a whole context, eleven phases | one slice |
| Entry | an empty folder | an empty folder **or** a model with N slices |
| Produces | a model | one more slice, plus a list of what the brief left open |

Both write the same artifact and both obey the same rule. `event-model` is the exploratory path — use
it when the user wants to *discover* the domain. Use this one when they already know it and want it
drawn.

**They compose.** A model started here can be continued there and back again. Neither owns the file.

## The one rule, restated for a dictated brief

**Never invent a domain fact.** In `event-model` that means "ask". Here it means something sharper,
because the user is not in a questioning mood — they are dictating:

> Every attribute you write must be traceable to a sentence in the brief, or to an answer the user
> gave to a question you asked. Everything else goes in the **gap list** and stays out of the model.

An invented field looks exactly like a dictated one in XML, and it passes the completeness check. The
gap list is the deliverable that keeps them apart, so produce it before you draw and show it.

You may freely invent layout — ids, x, y, routing, column order, which corridor an edge takes.

## The loop

1. **Locate or create the model.**
2. **Transcribe** the brief into a cell plan, and derive the **gap list** from what is missing.
3. **Ask the gaps** — all of them, in one turn. Then stop.
4. **Place the column(s)** and write the cells.
5. **Validate, check, mark, render, look.**
6. **Report the ripple** — which existing slices this touched, and demote them.
7. **Report**, then stop. One slice.

Do not run steps 3 and 4 in the same turn. The gap list is the point of the skill; answering your own
questions defeats it.

## 1 — locate or create the model

```
node tools/project.mjs where                # which project this kit copy writes to
node tools/drawio.mjs check <file>          # compressed? inflate before any plain read
node tools/model.mjs validate               # the project's diagrams/, and the cross-model rules
node tools/drawio.mjs render <file>         # then Read the PNG
```

**Read the model and look at it before adding to it.** You need the existing slices, the swimlanes
and their `identity=`, the screen slugs, and the event labels — a new slice almost always reuses some
of them, and reusing a label you have not read produces a second cell claiming to be the same fact
with different fields (`event-shape-disagrees`).

**Warn about the stale-tab hazard** if a human may have the file open: an open draw.io tab is a
snapshot from when it was opened, and saving it silently overwrites your work. Answer no to "save
changes", close, reopen.

**If there is no model yet**, this skill starts one: copy the kit's `templates/template.drawio` to
`<project>/diagrams/<context>.drawio`, rename the model cell, and set `context=` to the file name.
If there is no *project* yet either, stop and run `node tools/project.mjs init --project <path>` —
a model drawn inside the kit copy is in the wrong place and nothing downstream will find it. The
first swimlane's `streams=` and `identity=` are **domain answers** and belong in the gap list — do not
name a stream from a guess about the aggregate.

## 2 — transcribe, and build the gap list

This is the heart of the skill. Map each phrase of the brief onto exactly one attribute.

| The brief says | Cell | Attribute |
| --- | --- | --- |
| "a screen with a, b, c" — the user **types** them | `em="screen"` | `inputs="a:T, b:T, c:T"` |
| "the screen **shows** a, b, c" | `em="screen"` | `displays="a, b, c"` |
| "a Send button" | the screen's edge to the command; a wireframe `em="action"` later | — |
| "when sent" / "on submit" | `em="command"`, imperative | `fields=` |
| "we persist X" | `em="event"`, **past tense** | `fields=` |
| "d is calculated from a, b, c" | on the cell that carries `d` | `derived="d=a+b+c"` |
| "d is the same value, called something else upstream" | same | `mappings="d=upstreamName"` |
| "the handler / the clock / the logged-in user supplies it" | same | `terminal="d:generated\|clock\|actor\|const"` |
| "a new id for the thing being created" | the command | `terminal="xId:generated"` — **not** a source |
| "rule Z rejects it when…" | `em="gwt"` | `then="error: RuleName"` |
| "which stream / one per what" | `em="lane"` swimlane | `streams=`, `identity=` |
| "one row per …" | `em="readmodel"` | `identity=` |

**`derived=` is not `mappings=` and the difference is not cosmetic.** A mapping claims two names hold
the *same value*; a derivation says one is *computed* from others. `mappings="d=a"` when d is really
`a+b+c` is a lie a generator will act on, and `mapping-crosses-types` only catches it when the types
also differ. When the brief says "calculated", "summed", "counted", "based on" — it is `derived=`.

**`derived=` records the inputs, not the formula.** `derived="d=a+b+c"` says d comes from a, b and c;
it does not say *how*. The formula's home is a **GWT with concrete values**:

```
when="Send(a=2, b=3, c=4)"   then="XRecorded(d=9)"
```

That is executable, testable, and survives into a generated test. Prose in an attribute is none of
those. So when a brief names a rule — "rule X", "rule Z" — ask for one worked example of it, and put
the example in a GWT. Say that this is where the rule now lives.

**Every part of the example is checked**, so write it against the element it is an example of and not
against the one upstream — a field the element does not declare, or a literal its type cannot hold, is an
error rather than a note. Use `$Name` for a fixed identity that belongs in seed data:
`when="RecordPayment(customerId=$AcmeCustomer)"`. A raw Guid in a diagram is unreadable, and the check
cannot tell a mistyped one from a foreign key.

**Ask for an example wherever the name is not enough** — a `derived=` field, a value crossing a system
boundary, a fold whose meaning is a judgement. Not everywhere: the model is a specification, not a fixture,
and identities shared across tests already live in seed data.

**Then write the gap list.** Read `references/<pattern>.md` for what this pattern requires, and list
every required answer the brief did not give. Present it as questions, not as blanks you intend to
fill.

| `pattern=` | Reference |
| --- | --- |
| `state-change` | `references/state-change.md` |
| `state-view` | `references/state-view.md` |
| `automation` | `references/automation.md` |
| `translation` | `references/translation.md` |
| `upstream` | `references/upstream.md` |

If the user's phrasing does not settle *which* pattern it is, that is the first gap. **The vocabulary is
now the one the user speaks** — "state change" *is* `state-change`, "state view" *is* `state-view`, so
there is nothing to translate. This line used to read *"'State change' is `command`; 'state view' is
`view`"*, and that translation was the whole argument for renaming them. An `automation` needs a View
**and** conditional logic — without both it is a command emitting several events, not an automation.

## 3 — ask the gaps

One turn, all the questions, then wait. Say plainly which parts of the brief you *did* transcribe, so
the user can see the questions are the remainder and not a restart.

If a gap is genuinely optional at this stage, say so and offer the honest placeholder — `string` for
an undecided type is fine, and say that you used one. `status="in-design"` is always the right start.

## 4 — place the column and write the cells

### Where the column goes

Time runs left to right, so position is semantic, not cosmetic. Two rules decide it:

- **A slice is one contiguous band.** Its columns must be adjacent.
- **Only `Event → View` may point left.** Everything else pointing left is `flow/backward-connection`,
  an error.

Which gives:

| The new slice | Goes |
| --- | --- |
| `state-change`, whose screen reads only existing Views | at the right end |
| `state-change`, chronologically before an existing slice | **inserted** — everything right of it shifts |
| `state-view`, read by a screen that already exists | **inserted left of that screen's column** — otherwise the View → Screen feed points left, and that is not the exception |
| `state-view`, read by nothing yet | at the right end |
| `automation` / `translation` | two columns, after the events they watch |
| `upstream` | wherever the foreign events land in the story |

Inserting is the common case for a `state-view`, and it is the expensive one: every column to the right
moves by 320 per inserted column, and so does every routing point.

### The geometry — `tools/slice.mjs` owns all of it

```
node tools/slice.mjs add      <file> --slice <n> --pattern <p> [--at <spec>] [--columns N] [--aggregate A]
node tools/slice.mjs swimlane <file> --label <text> --streams <A[,B]> [--identity <f[,f]>] [--height N]
node tools/slice.mjs route    <file> --from <id> --to <id>
node tools/slice.mjs identity <file> --band <id>
node tools/slice.mjs demote   <file> [--slice <n>]... | --from-diff
node tools/slice.mjs reflow   <file>
```

Every command takes `--dry-run`, which prints the plan and writes nothing. **Use it before an insert**
— that is where the arithmetic is, and the plan tells you how many cells and routing points move.

`add` emits the slice cell, the column band, and one placeholder per cell the pattern requires, wired
with the edges the pattern determines. Placeholders are labelled `TODO:<kind>` and carry no `fields=`,
because **a label is a domain fact** — naming and filling them is your job, from the brief. `route`
connects a placeholder to the existing cells the user named; it refuses a left-pointing
non-`Event → View` edge rather than routing it prettily, and the fix it names is `add --at`.

Do not hand-place cells. The numbers below are for reading a diff, not for doing arithmetic with —
**read them off the model, never off CLAUDE.md's table**, which is a snapshot and says so:

```
column x        = first column x + 320n         (100, 420, 740, …)
element         = 180 wide; events/commands/views 60 tall; screens 180×300
slice band      = column x − 20, width 220 per column
                  y = UI lane y − 20, height down to the event lane's bottom edge
event y         = the swimlane band its aggregate= names. An event's y IS its stream.
GWT             = 300×120, x = column x, first at GWT lane y + 30, then every 140
page width      = 40 + lane width + 60
```

Every long edge gets **its own y** in a routing band — one y per *target* is not enough, because
several events feeding one View would then share a horizontal run and the picture becomes unreadable.
Allocate sequentially **from what is already used**, not from n=0:

```
forward  (Event → View)      command lane bottom + 6 + 8n
backward (right-to-left)     event lane bottom + 15 + 9n
View → Screen                UI lane y + 345 + 8n
```

Several events stacked in **one column** feeding the same View cannot all run straight up — the lower
ones would cut through the ones above. Send them out the left edge and up a corridor at
`columnX − 30 − 12n`.

> Specified in `tools/slice.spec.md` and exercised by `tools/fixtures/cart-replay.mjs`, which builds
> the cart model of *Understanding EventSourcing* ch. 12–17 as the nine appends those chapters are —
> including the insert-at-position-0 that ch. 16 demands. `tools/fixtures/cart/` is the result. If you think
> the tool has a geometry bug, reproduce it there first: that fixture is the regression suite.

### Writing the cells

- One `<object>` per element, so the semantics ride along.
- Stable meaningful ids: `scr-<slug>`, `cmd-<command>`, `evt-<event>`, `rm-<view>`, `auto-<name>`,
  `slice-<name>`, `gwt-<slice>-<n>`. Never `node7`.
- The slice cell is a **plain rectangle, never a draw.io container** — a container reparents its
  children and makes their geometry relative, breaking every absolute-x reader.
- Every cell inside the band declares that `slice=`; every cell declaring it is drawn inside.
- Put the rule text in a GWT's **label** as well as `rule=`, or several GWTs in a slice render as
  identical grey boxes.
- Reusing an existing screen slug: copy `displays=` **exactly**, and set only this slice's `inputs=`.
  What a screen shows is a property of the screen; what it offers is a property of the slice.

## 5 — validate, check, mark, render, look

```
node tools/model.mjs validate                          # the FOLDER, always
```

Validate the folder rather than the file: a single file cannot see whether an imported event is
published anywhere.

Then delegate the reading to the **`completeness-checker`** agent. It did not draw this and has no
stake in it being right — that is the point of it. Then mark it yourself, so there is exactly one
writer:

```
node tools/model.mjs mark   <file>     # red on what has no source
node tools/drawio.mjs render <file>    # then Read the PNG
node tools/model.mjs clear  <file>     # restores byte-exactly, so mark freely
```

**Look at the PNG.** Edges through boxes, overlapping GWTs, a cell outside its band — invisible in
XML, obvious in the image. This is where an insert that went wrong shows up.

The rules most likely to fire on an added slice, and what each means:

| Rule | On an added slice it usually means |
| --- | --- |
| `screen-displays-disagree` | you reused a slug and the two cells' `displays=` differ |
| `identity-not-on-every-event` | the new event does not carry the swimlane's key |
| `event-shape-disagrees` | you redrew an existing event label with different `fields=` |
| `flow/backward-connection` | the column went in the wrong place — reorder, do not reroute |
| `slice-member-outside` | the band is not wide enough for the columns you used |
| `command-crosses-swimlane` | the brief described two aggregates in one command. Two effects that must be atomic are one aggregate |
| `unpublished-import` | a `translation`'s source event is not marked `public="true"` upstream |

**Gate: zero errors before you report.** A new slice's own cells must be clean for it to leave
`in-design`.

## 6 — report the ripple, and demote what it touched

**An append is not local.** This is the step that has no analogue in a first modelling pass, and it is
the one worth being pedantic about.

> *"I treat changes to existing Slices like new Slices… I typically make a screenshot and set it back
> to Status 'Created'. This typically happens for all slices that need adjustment. **Also for example
> Read Models impacted by new Events. So one change could have impact on several Slices.**"*
> — Martin Dilger, *The Little EventModeling Book*, ch. 12

Both books work this the same way. `Understanding EventSourcing` ch. 14 adds one slice and discovers a
missing `aggregateId` that then has to be defined *"consistently throughout the Event Model"* — onto
events and commands that already existed. Ch. 16 runs it backwards: a new View needs `product-id`, and
*"it's not enough to simply add the 'product-id' to the read model… we don't forget to also add it to
the 'Item Added' event and the corresponding 'Add Item' command."*

So the completeness check is this skill's **engine**, not just its gate — following a red arrow
backwards into existing cells is how you find what the new slice actually costs.

At the end, list every **existing** cell you changed, and every slice those cells belong to. Then:

- **Any impacted slice past `in-design` goes back to `in-design`**, and say why in the same breath.
  A View that gained a field is no longer the View that was signed off.
- If you changed nothing outside the new slice, say that explicitly. It is the good case and it is
  worth stating rather than implying.

`git diff <file>` is the honest source for this. Do not reconstruct it from memory.

## 7 — if the model already has code

Three traps fire only on an append, and all three are silent.

**A GWT added to an already-implemented slice gets no test.** Test files are `scaffold` — written once,
then hand-owned — so the new rule fails nothing and is skipped by nothing. Run codegen and report the
list; the fix is to write those tests by hand, because a generator must not append into a file
somebody else owns:

```
node tools/codegen.mjs                     # reports N written, M kept, and GWT WITHOUT A TEST
```

**A new event feeding an existing View updates the view *type* but not the projection.** View types are
`emit` so they are rewritten and still compile; the projection that fills them is `scaffold` and is
kept. The new field silently stays at its default, and the existing green test does not test it. Name
the projection that now needs a hand edit.

**Adding a field to an event of a `closed` slice is a breaking change.** *"Adding a mandatory field is a
breaking change, as we need to handle it properly in the system. This also means we can't just add the
field to the event, as any component processing an older version of the event would simply break"* —
`Understanding EventSourcing`, ch. 33. Events of an unimplemented slice have no instances and are free
to change; events of a `closed` slice may have persisted instances. `status=` is what tells them apart.
Flag it, name the event, and check `reference/llms/marten/` for upcasting before proposing a fix.

## Report

Short, and in this order:

```
SLICE      <name>  pattern=<p>  status=in-design   (inserted at column N | appended)
FROM BRIEF what you transcribed, cell by cell — every attribute traceable to a sentence
ASKED      the gaps, and the answers you were given
GATES      validate: N errors / M warnings   completeness-checker: PASS|FAIL   render: looked at
RIPPLE     existing cells changed, slices demoted, or "nothing outside this slice"
CODE       GWT WITHOUT A TEST, projections needing a hand edit, or "no generated code yet"
OPEN       what is still unanswered and what it blocks
```

Then **stop**. One slice per invocation — the point of one at a time is that the first one tells you
what the next costs.
