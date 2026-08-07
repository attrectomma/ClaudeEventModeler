# Business Spec — "Recipe Box"

> **For workflow testing.** This is a business-side brief written by a product owner, deliberately
> in everyday language (no database or code terms). It is the kind of input you would hand to
> `/plan-feature`. Difficulty: **easy** — good first run.

## Background

We want a small web service where home cooks can store and organise their recipes. Think of it as
a digital replacement for the box of index cards people keep in the kitchen. This first release is
single-user and internal — no accounts or sharing yet.

## Who uses it

- **The cook** — creates recipes, edits them, and looks them up while cooking.

## What they need to do

1. **Add a recipe.** A recipe has a name, a short description, how many servings it makes, and the
   rough time it takes to prepare.
2. **List the ingredients** for a recipe. Each ingredient has a name, an amount, and a unit
   (grams, cups, pieces, etc.).
3. **Add or remove ingredients** on an existing recipe as they refine it.
4. **Browse all their recipes** in a list, a page at a time (they may end up with hundreds).
5. **Open a single recipe** to see its full details, including all ingredients.

## Business rules

- A recipe must have a name and must make at least one serving.
- Preparation time is in whole minutes and can't be negative.
- Within one recipe, you can't list the same ingredient twice — if the cook adds "flour" again,
  that's a mistake we should reject with a clear message.
- An ingredient amount must be greater than zero.
- Removing an ingredient that isn't on the recipe should be reported as "not found", not silently
  ignored.

## Explicitly out of scope (for now)

- User accounts, login, sharing recipes between people.
- Photos, nutrition information, categories/tags, search by ingredient.
- Cooking steps/instructions — we'll add those in a later release.

## Things we're not sure about (please raise if relevant)

- Should two recipes be allowed to have the same name? We think **yes** (people make variations),
  but confirm.
- Is "unit" a free-text field or a fixed list of allowed units? Leaning free-text for now.
