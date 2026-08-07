# Business Spec — "Co-working Desk Booking"

> **For workflow testing.** A business-side brief in everyday language. Difficulty: **medium** —
> value-object heavy (dates, contact details), a scheduling/overlap rule, member limits, and a
> concurrency concern. Good for practising value objects and a booking-overlap invariant.

## Background

We run a small co-working space with a fixed set of desks. Members currently grab whiteboard slots
to reserve a desk for a day, which leads to arguments when two people think they booked the same
desk. We want a booking system that makes desk reservations unambiguous.

## Who uses it

- **The member** — reserves a desk for a given day and cancels if plans change.
- **The office manager** — sets up the desks and can see the day's bookings.

## What they need to do

1. **Register a member**, storing their name, email, and phone number.
2. **Add a desk** to the space, each with a short label (e.g. "Window 3", "Quiet Zone 1").
3. **Book a desk** for a specific date. A booking is for one member, one desk, one whole day.
4. **Cancel a booking** the member no longer needs.
5. **See the bookings for a given day** (which desks are taken, and by whom).
6. **See a member's upcoming bookings.**

## Business rules

- A desk can be booked by **only one member per day** — no double-booking. If someone tries to book
  a desk that's already taken for that date, reject it clearly.
- **Concurrency matters here:** two members trying to grab the same desk for the same day at the
  same instant must not both succeed.
- A member may hold at most **3 upcoming bookings** at a time.
- Bookings can be made at most **30 days in advance**, and never for a date in the past.
- Email must be a valid email address; phone is required.
- Cancelling a booking that doesn't exist (or already cancelled) should be reported as an error, not
  silently accepted.

## Explicitly out of scope (for now)

- Half-day or hourly bookings (whole days only for this release).
- Recurring bookings ("every Tuesday").
- Payments, billing, or membership tiers.
- Check-in / no-show handling.

## Things we're not sure about (please raise if relevant)

- When a member cancels, should the booking record disappear entirely, or be kept as "cancelled" for
  reporting? Lean towards keeping a record, but confirm.
- Should the office manager be able to book on a member's behalf? Not required for release 1, but
  don't design in a way that makes it hard later.
- Is a desk ever temporarily unavailable (maintenance)? Not for now — assume all desks are bookable.
