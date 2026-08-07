# Business Spec — "Recipe Box", demo cut

> **For a live demo with a time box.** Difficulty: **trivial, deliberately.** One screen, two things
> a cook can do, and **no open questions** — every choice a modelling session would normally stop and
> ask about is already answered below, so the session never blocks.
>
> It is a cut of [01-recipe-box.md](01-recipe-box.md), reduced to the smallest thing that still
> exercises the whole kit end to end: **one State View slice and one State Change slice**, which is
> also the minimum a journey test can walk.

## Background

Home cooks keep their recipes on index cards in a box in the kitchen. We want the box to be something
the system remembers, so a cook can see everything they have from any device. This first cut is
single-user and internal.

## Who uses it

- **The cook** — writes recipes down, and looks at what they have.

## What they need to do

1. **See all their recipes in one list.** For each one: its name, how many servings it makes, and how
   long it takes to prepare.
2. **Add a recipe from that same page**, by typing those three things.

That is the whole release.

## Business rules

- A recipe **must have a name**.
- It must make **at least one serving**.
- Preparation time is in **whole minutes and cannot be negative**. Zero is allowed — some things are
  just assembly.
- **Two recipes may share a name.** People make variations, and rejecting that would be wrong.

## Already decided, so none of this needs a conversation

*This section exists because the demo is time-boxed. Everything a modelling session would normally
stop and ask about is settled here.*

- **A recipe is its own thing.** One recipe, one identity, and the system mints that identity when the
  recipe is added — the cook never sees it or types it.
- **We record when each recipe was added**, and the list is shown in that order, oldest first. The cook
  does not see the timestamp; it is only what gives the list a stable order.
- **The list shows every recipe.** No paging, no search, no sorting controls. A cook with hundreds of
  recipes is a later problem and we are not solving it now.
- **The list must be up to date the instant a recipe is added.** A cook who adds one and does not see
  it appear will assume it failed and add it again. This is not negotiable and it is the reason the
  add button and the list live on the same page.
- **Nothing is ever edited or deleted** in this cut. A recipe, once written down, stays.
- **Servings is a whole number.** Half a serving is not a thing anyone asks for.

## Explicitly out of scope

- Ingredients, cooking steps, photos, nutrition, categories, tags.
- Editing a recipe, deleting a recipe.
- Accounts, login, sharing between cooks.
- Paging, search, filtering, sorting.

## The one thing that must work end to end

> A cook opens the list, adds **"Pancakes, 4 servings, 20 minutes"**, and sees it in the list —
> without refreshing, navigating anywhere, or doing anything else.

That sentence is the acceptance test for the whole release, and it is worth walking as a journey:
the recipe the list shows must be the one the add actually created, not one that merely looks like it.
