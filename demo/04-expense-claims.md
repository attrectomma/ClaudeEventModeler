# Business Spec — "Expense Claims"

> **Written to exercise actor lanes.** Difficulty: **medium-small** — one stream, one linear flow, and
> deliberately **three different people** who each see a different screen and can each do something
> nobody else can. Around seven slices.
>
> Chosen because the handover it describes is genuinely three-handed: the person who spends the money,
> the person who approves it, and the person who pays it are never the same person, and the system's
> whole job is to move one claim between them.

## Background

Our staff spend their own money on small things — a taxi to a client, a cable, coffee for a workshop —
and claim it back. Today that is an email to a manager, who forwards it to finance, who eventually pays
it. Nobody can tell where a claim is, claims get lost in inboxes, and finance has no list of what they
owe. We want the claim itself to be something the system holds and moves.

## Who uses it

**Three people, and they are never the same person.**

- **The employee** — spent the money. Writes the claim down and afterwards wants to know where it is.
- **The approver** — the employee's manager. Sees claims waiting on them, and says yes or no.
- **The finance officer** — pays approved claims and records the payment. Sees only what is approved
  and not yet paid.

## What they need to do

**The employee**

1. **Submit a claim** — what it was for, and how much.
2. **See their own claims** and where each one has got to.

**The approver**

3. **See the claims waiting for their approval.**
4. **Approve a claim.**
5. **Reject a claim**, saying why.

**The finance officer**

6. **See the claims that are approved and not yet paid.**
7. **Record a payment** against a claim, with the bank reference.

That is the whole release.

## Business rules

- A claim must say **what it was for** and be for **more than zero**.
- **An approver may not approve or reject their own claim.** This happens — managers claim expenses too
  — and it is the rule people ask about first.
- A claim can only be **approved or rejected once**. Whichever happens first, the other is then refused.
- A claim can only be **paid once**, and **only after it has been approved**. A rejected claim is never
  paid.
- **A rejection must say why.** An approval need not.

## Already decided, so none of this needs a conversation

- **A claim is its own thing**, with its own identity, minted when it is submitted. Nobody types it.
- **Everything is kept.** A rejected claim stays visible to the employee with its reason; a paid claim
  stays on the record. Nothing is ever deleted or edited.
- **We record who did each thing and when** — who submitted, who approved or rejected, who paid.
- **Amounts are in whole currency units with two decimals**, one currency, no conversion.
- **Anyone may be an approver for someone else's claim.** There is no hierarchy in this release: the
  system does not know who reports to whom, and does not try to. The only rule about identity is the
  one above — not your own.
- **The three screens are separate pages.** An employee never sees the approver's queue, and the
  finance officer never sees an unapproved claim.

## Explicitly out of scope

- Who reports to whom; approval chains, delegation, out-of-office cover.
- Receipts, attachments, photographs, OCR.
- Budgets, cost centres, categories, VAT, multiple currencies.
- Editing or withdrawing a submitted claim.
- Notifying anyone — no email, no push. Each person looks at their own page.
- Logging in. **Who someone is, is known; how they proved it is not this system's problem.**

## The one thing that must work end to end

> An employee submits a claim for **"Taxi to client, 24.50"**. It appears on the approver's queue — and
> not on the employee's. The approver approves it, and it moves off their queue and onto the finance
> officer's. Finance pays it, and the employee sees it marked paid.

One claim, three people, four screens' worth of state, and nobody ever sees a claim that is not theirs
to act on. That sentence is the acceptance test for the whole release.
