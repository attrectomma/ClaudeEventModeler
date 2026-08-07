# Business Spec — "Neighborhood Library"

> **For workflow testing.** A business-side brief in everyday language. Difficulty: **medium** —
> exercises two aggregates, a cross-aggregate operation, policy limits, and a genuine concurrency
> rule. This is the best spec for a full end-to-end run of the workflow.

## Background

Our neighborhood community centre runs a small lending library. Today it's tracked on paper and
things go wrong — the last copy of a popular book gets "lent" to two people, and nobody knows who
has what. We want a simple system for the librarian to manage members, the book catalogue, and
lending.

## Who uses it

- **The librarian** — the only operator for now. They register members, add books, and record
  loans and returns on behalf of members at the desk.

## What they need to do

1. **Register a member.** We keep the member's name and email, and their mailing address (street,
   city, postal code, country — state/region is optional depending on the country).
2. **Add a book to the catalogue.** A book has a title, an author, and an ISBN. The library may own
   **several physical copies** of the same book.
3. **Lend a book to a member.** The member walks up with a book; the librarian records the loan.
4. **Take a return** when the member brings the book back.
5. **Look up** a member (with their current loans) and a book (with how many copies are available).
6. **Browse** the member list and the book catalogue, a page at a time.

## Business rules

- A member can have at most **5 active loans** at once.
- The standard loan period is **21 days**. (We don't need reminders or fines yet — just record the
  due date.)
- A book can only be lent if **at least one copy is available**. When all copies are out, further
  loan attempts must be rejected clearly.
- **This is the important one:** if two loan attempts for the *last available copy* happen at
  essentially the same moment, only one may succeed. We must never end up with more copies lent than
  the library owns. (This is exactly the paper-process failure we're replacing.)
- An ISBN must look like a valid ISBN (13 digits, possibly with hyphens).
- Returning a book that the member doesn't currently have on loan should be reported as an error.

## Explicitly out of scope (for now)

- Member self-service (everything goes through the librarian).
- Reservations / holds / waiting lists.
- Overdue reminders, fines, membership expiry.
- Multiple library branches.

## Things we're not sure about (please raise if relevant)

- Should a "loan" be a thing in its own right (with its own history we can look back on), or just a
  link between a member and a copy? We don't have a strong opinion — advise us.
- When we retire a damaged copy, does that affect existing loans? Assume no active loan is on a
  retired copy for now.
- Can the same person be registered twice under different emails? Prefer to prevent duplicate
  emails, but confirm.
