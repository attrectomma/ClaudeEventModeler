# 03-coworking-desk-booking — provenance and what it will exercise

> Rescued from `CPOC03/_inbox-archive/SOURCE.md` when that project was reset to blank (2026-08-07).
> The brief itself lives beside this file; this is the analysis that was written with it, kept because
> it is the pre-read for the run KIT-FINDINGS **Y2** and the section-X caveat both point at.

| | |
| --- | --- |
| **File** | [03-coworking-desk-booking.md](03-coworking-desk-booking.md) |
| **Copied from** | `C:\Repos\Attrecto\ClaudePOC\docs\example-specs\03-coworking-desk-booking.md` |
| **Copied on** | 2026-08-07 |
| **Changed on the way in** | nothing — byte-identical to the source |

It is one of a numbered set of example business specs written **for workflow testing**, and it
describes its own difficulty as *medium*: value-object heavy (dates, contact details), a
scheduling/overlap rule, member limits, and an explicit concurrency concern.

**This file records provenance because the source is outside this project and this project must be
readable without it.** The spec itself is left exactly as written: the inbox is the phase-0
*baseline*, raw input rather than anything authoritative, and a domain fact only enters the model once
a human has confirmed it.

## Two things about this brief worth knowing before phase 0

**It states its own open questions**, in a section called *"Things we're not sure about (please raise
if relevant)"* — whether a cancelled booking keeps a record, whether the office manager may book on a
member's behalf, and whether a desk can be temporarily unavailable. Those are **not** answered here
and must not be answered by guessing. They are exactly the shape of question the modelling session
asks, and the first belongs on the model as a real decision rather than an implementation detail: a
cancellation that keeps a record is an event, and one that does not is a hole in the history.

**It also names a concurrency requirement out loud** — *"two members trying to grab the same desk for
the same day at the same instant must not both succeed"*. That is a **stream boundary** question, not
a validation one, and it is the single most consequential decision in this model. A desk-day
uniqueness rule checked against a projection is not an invariant; keyed so that one stream owns the
contested thing, it is. Decide it when the swimlanes are drawn, not when the code is written.
