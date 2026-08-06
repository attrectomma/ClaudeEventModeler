# `pattern="translation"` — a Translation slice

```
Event(s) (source system) → View → Automated Trigger → Command → Event(s) (other system)
```

Structurally an automation whose input comes from outside this model. **Two columns.** Everything in
`references/automation.md` applies — the todo list, the tick-off edge, the automation typing nothing,
the conditional. This file covers only what is different: the boundary.

**`slice-pattern-mismatch` cannot tell `translation` from `automation`.** Their shape signatures are
identical in `tools/model.mjs` — one command, a view, an automation, events. So declaring `translation`
is an assertion nothing checks. It is only honest if a boundary is genuinely crossed.

## A complete brief

Everything an automation needs, plus:

- **where the incoming event comes from** — a sibling model in this system, or a genuinely foreign
  system
- **its label and the fields we consume**
- whether our output event is **for the other system** — and if so, that it is `public="true"`

## Only an event crosses a model boundary

*Understanding EventSourcing* ch. 15 is explicit that you never let another model rebuild your state
from your internals. So:

> A model's only public surface is an event marked `public="true"`. A consumer imports it as a yellow
> external declaring `from="<context>"`.

Nothing else crosses — no read model, command, screen or unmarked event. If two contexts need the same
projection, **each builds its own** from the events it imports. A brief asking to read another
context's View is asking for the wrong thing; offer the event instead.

## `from=` vs `origin=` — the two answers are checked differently

| | Means | Checked |
| --- | --- | --- |
| `from="fulfilment"` | published by a sibling model in this system | **yes** — the label must exist there, be `public="true"`, and its `fields=` must cover what we consume |
| `origin="Google Calendar"` | a genuine third party | no — a claim on record |

That first row is checking power a single model cannot have. Inside one file an external is terminal by
construction; across a folder the producer is present, so an import nobody publishes is an **error**.

So ask which one it is, and if it is `from=`:

```
node tools/model.mjs validate     # the folder — the file alone cannot see this
```

Expect one of:

| Rule | Means |
| --- | --- |
| `unknown-source-model` | no such model in this system — check the spelling against the folder |
| `unpublished-import` | the event exists there but is not `public="true"`. Marking it is an edit to **that** model — a ripple, and it demotes that slice |
| `import-field-missing` | we consume a field the publisher does not carry. The import is a contract; this is the class of bug that only shows up when the two models are read side by side |
| `import-field-type` | same name, different type. Usually the real disagreement |

If nothing publishes it and nothing should, the brief may actually describe `origin=` — a foreign
system, unverifiable and on the record. Do not switch to `origin=` just to silence an error; ask.

## Do you need a translation at all?

Direct consumption between contexts of one system is **allowed**. The book is explicit that a context is
*not* a microservice and that you should *"not split but keep everything in one system until you know
more."* A sibling model's `public` event can be imported and projected directly — that is an
`upstream` column plus an ordinary `view` slice, and it is simpler.

Full ch. 15 translation — View → automation → command → external event — earns its keep at a **real
system boundary**, where the other side has its own lifecycle, its own schema, and no shared deploy.

What the kit insists on either way is that the coupling is **declared**: undeclared is an error,
declared is a note on the context map. So if the brief describes direct consumption, draw that and say
you did, rather than dressing it as a translation.

```
node tools/model.mjs map          # regenerate the context map from the real edges
```

Never hand-edit `_context-map.drawio`; it is generated, and the leading `_` excludes it from validation.

## The incoming event is terminal

An external event's attributes are supplied by **nothing** — that is what external means. We have
neither control over it nor knowledge of what produced it, so `external-terminal` is a **note**, not an
error. The point of the note is that the upstream contract gets confirmed once, by a human, out loud.

Do not add a command upstream of an external event to make the check quieter. That invents a producer
we do not own.

## Layout

The incoming external is yellow (`em="external"`, `#fff2cc` / `#d6b656`) and lands **in the Event Stream
lane**, in a swimlane band. That band is exempt from `band-needs-identity`: we project from those
streams, never append to them.

Our output event goes in one of our own bands, keyed by our own `identity=`, and carries `public="true"`
if the other system consumes it. `unconsumed-export` is a note, and a fair question to answer: either a
consumer is missing, or it does not need to be public.
