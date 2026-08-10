#!/usr/bin/env node
// Acceptance test for tools/slice.mjs: build the cart model of Understanding EventSourcing
// chapters 12-17 as the nine successive appends those chapters actually are — ON A BOARD, because
// ch.18 says that is the normal case ("more than one model on a board... the rule rather than the
// exception for me").
//
//   node tools/fixtures/cart-replay.mjs [--keep]
//
// Every geometric operation goes through tools/slice.mjs. Every domain fact -- labels, fields,
// identities, GWTs -- comes from the book, quoted in the round it appears in. That split is the
// point: the tool is proved to own the geometry and to invent nothing.
//
// THE OUTPUT IS A TWO-REGION BOARD. Region 2 is created BEFORE round 1, so all nine rounds run
// against a board and exercise region targeting and the downward cascade throughout, rather than a
// board being bolted on at the end. Its CONTENT is filled in after the rounds, so "nine rounds" still
// means the book's nine appends to the cart:
//
//   region 1  cart               ch.12-17, the nine rounds below
//   region 2  submit-cart-error  ch.18's own dedicated model for an alternative flow --
//                                "if a customer fails to submit a cart three times due to technical
//                                 issues, the cart process is aborted"
//
// Three of the nine rounds now pass --model: `--at start` means "position 0 of WHICH model", and a
// state-view names no aggregate, so there is genuinely nothing on the canvas to infer a region from.
// The other six infer it from --aggregate, from --at before:<slice>, or from the cell ids they name.
//
// The rounds, and the operation each one is here to exercise:
//
//   1 add-item          command      append into an empty model
//   2 cart-items        view         append; Event -> View forward routing
//   3 remove-item       command      append; ch.12's itemId ripple
//   4 clear-cart        command      append; Event -> View pointing LEFT (the one exception)
//   5 submit-cart       command      append; a public= event
//   6 change-inventory  translation  A NEW SWIMLANE -- the full downward cascade
//   7 inventories       view         INSERT AT POSITION 0 -- the maximal case, and the book's own
//                                   seventh append demands it: the Inventories view feeds the Cart
//                                   screen in column 1, and View -> Screen may not point left
//   8 change-price      translation  append; two externals stacked in one band
//   9 archive-item      automation   append; todo-list view + processor + command + event
//
// After round 9 the model is ~4000px. That used to trip `model-too-wide` at 3200px; the rule has been
// REMOVED, because width is a symptom and one business context is the criterion. The cart is one
// business context and one story, so its width was never a defect -- in the fixture or anywhere else.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Kit-local, and anchored to this file rather than to cwd. The fixture is the kit's regression
// suite, not anybody's project: it must run with no project configured and must never write into
// one. Its output IS committed - "byte-identical on re-run" is the assertion.
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, "..", "..");
const OUT = join(HERE, "cart");
const FILE = join(OUT, "cart.drawio");
const TEMPLATE = join(KIT, "templates", "template.drawio");
const SLICE = join(KIT, "tools", "slice.mjs");
const MODEL = join(KIT, "tools", "model.mjs");
const keep = process.argv.includes("--keep");

const run = (args, quiet) => {
  const out = execFileSync("node", [SLICE, ...args], { encoding: "utf8" });
  if (!quiet) process.stdout.write(out.replace(/^/gm, "    "));
  return out;
};
const slice = (...args) => run([args[0], FILE, ...args.slice(1)]);

// ---- the one thing the fixture does itself: write the book's domain facts onto a placeholder.
// slice.mjs must never do this (a label is a domain fact), so the fixture carries it.
//
// THE PARSER IS THE SHARED ONE — KIT-FINDINGS V23 was filed as "three parsers"; this file held a
// FOURTH. It was missed because the 3b sweep grepped tools/*.mjs and this lives in tools/fixtures/.
// It matters as much as the others: `edit()` below rewrites the whole <root> from the blocks it
// matched, so anything it could not match would be deleted — in the kit's own regression suite.
import { parseBlocks, isRootCell, escapeAttr as esc } from "../drawio-xml.mjs";
const cellBlocks = (xml) => parseBlocks(xml).filter((b) => !isRootCell(b)).map((b) => b.raw);

function edit(edits) {
  const raw = readFileSync(FILE, "utf8");
  const crlf = raw.includes("\r\n");
  let xml = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  const seen = new Set();
  const blocks = cellBlocks(xml).map((b) => {
    const id = /\bid="([^"]*)"/.exec(b)?.[1];
    const e = edits[id];
    if (!e) return b;
    seen.add(id);
    let out = b;
    for (const [k, v] of Object.entries(e)) {
      out = new RegExp(`\\b${k}="[^"]*"`).test(out)
        ? out.replace(new RegExp(`\\b${k}="[^"]*"`), () => `${k}="${esc(v)}"`)
        : out.replace(/^(\s*<object )/, (_, p) => `${p}${k}="${esc(v)}" `);
    }
    return out;
  });
  const missing = Object.keys(edits).filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`edit: no such cell(s): ${missing.join(", ")}`);
  // Tolerant of the wrapper's formatting, refusing on a miss, and a FUNCTION replacement so a `$` in
  // cell text (a GWT's `$CartA`) cannot be re-interpreted — the same three fixes step 3b made in the
  // two writers.
  const ROOT_RE = /(<root>[ \t]*\r?\n)([\s\S]*?)([ \t]*<\/root>)/;
  if (!ROOT_RE.test(xml)) throw new Error("edit: no <root> ... </root> to rewrite");
  xml = xml.replace(ROOT_RE, (_, open, __, close) =>
    `${open}        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n${blocks.join("")}${close}`);
  writeFileSync(FILE, crlf ? xml.replace(/\n/g, "\r\n") : xml, "utf8");
}

// GWT cells are content, not geometry: the fixture places them at the row slice.mjs reserved.
// x is READ OFF the slice cell rather than computed from a column index, because every insert moves
// it — round 2 and round 7 both insert at position 0, so a hardcoded index is wrong by 320 or 640.
//
// `lane` names WHICH REGION's GWT band to stack under. On a board the lane ids are namespaced
// (`submit-cart-error-lane-gwt`), and the y this reads is the whole point of the cell's placement —
// reading region 1's band for a region 2 rule would drop the cell into the wrong model entirely.
function gwt(id, sliceName, row, o, lane = "lane-gwt") {
  const raw = readFileSync(FILE, "utf8");
  const crlf = raw.includes("\r\n");
  let xml = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  const gwtY = +new RegExp(`id="${lane}"[\\s\\S]*?<mxGeometry[^>]*?\\by="([-\\d.]+)"`).exec(xml)[1];
  const band = new RegExp(`slice="${sliceName}"[^>]*em="group"|em="group"[^>]*slice="${sliceName}"`).test(xml)
    ? /<mxGeometry[^>]*?\bx="([-\d.]+)"/.exec(
        xml.slice(xml.indexOf(`id="slice-${sliceName}"`)))[1]
    : null;
  if (band == null) throw new Error(`gwt: no slice cell for ${sliceName}`);
  const colX = +band + 20;
  // A STATE VIEW TAKES A GT, NOT A GWT: "Read Models only rely on previously stored events, so there
  // is no 'When' part necessary" (UES ch. 3). The absent when= is what makes it a GT — so it must be
  // OMITTED, not written empty. Latent until now because none of the nine rounds writes one, and
  // `when="undefined"` is a gwt-unknown-command error rather than anything that reads as a helper bug.
  const label = `${o.rule}\n\nGIVEN ${o.given || "—"}\n${o.when ? `WHEN ${o.when}\n` : ""}THEN ${o.then}`;
  const attrs = [`em="gwt"`, `slice="${sliceName}"`, `rule="${esc(o.rule)}"`,
    o.given ? `given="${esc(o.given)}"` : null, o.when ? `when="${esc(o.when)}"` : null,
    `then="${esc(o.then)}"`,
    o.enforce ? `enforce="${o.enforce}"` : null].filter(Boolean).join(" ");
  const cell =
    `        <object id="${id}" label="${esc(label)}" ${attrs}>\n` +
    `          <mxCell style="rounded=0;whiteSpace=wrap;html=1;fillColor=#f0f0f0;strokeColor=#999999;fontSize=11;align=left;spacingLeft=8;verticalAlign=top;spacingTop=6;" vertex="1" parent="1">\n` +
    `            <mxGeometry x="${colX}" y="${gwtY + 30 + 140 * row}" width="300" height="120" as="geometry" />\n` +
    `          </mxCell>\n        </object>\n`;
  xml = xml.replace(/(      <\/root>)/, `${cell}$1`);
  writeFileSync(FILE, crlf ? xml.replace(/\n/g, "\r\n") : xml, "utf8");
}

// ch.12 Fig.12.16: "we are reusing the cart items read model for both screens". One screen, one
// displays= list, applied to EVERY cell sharing the slug — screen/screen-displays-disagree is an
// error precisely because what a screen shows is a property of the screen. Growing this list is the
// ripple: it reaches back into cells that earlier rounds already drew.
let CART_DISPLAYS = "aggregateId, itemId, productId, description, image, price";
const CART_CELLS = [];        // every cart-screen cell drawn so far
function rippleCartScreen() {
  const e = {};
  for (const id of CART_CELLS) e[id] = { displays: CART_DISPLAYS };
  edit(e);
}
const promote = (name, status) => edit({ [`slice-${name}`]: { status, label: `${name}\n${statusPattern(name)} · ${status}` } });
function statusPattern(name) {
  const xml = readFileSync(FILE, "utf8");
  return /\bpattern="([^"]*)"/.exec(xml.slice(xml.indexOf(`id="slice-${name}"`)))[1];
}

function validate(round) {
  let out = "";
  try { out = execFileSync("node", [MODEL, "validate", `${OUT}/`], { encoding: "utf8" }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const bad = out.split("\n").filter((l) => /^\s*(ERROR)\s/.test(l));
  const blockers = bad.filter((l) => /\b(flow|slice|swimlane)\//.test(l));
  console.log(`  round ${round}: ${bad.length} error(s), ${blockers.length} in flow/slice/swimlane`);
  for (const b of blockers) console.log(`    BLOCKER ${b.trim()}`);
  return { out, bad, blockers };
}

// ============================================================ the replay

if (existsSync(OUT) && !keep) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
copyFileSync(TEMPLATE, FILE);
edit({
  "model-rename": {
    id: "model-cart",
    label: "Cart\ncart · cart", em: "model", context: "cart", system: "cart",
    note: "The shopping-cart model of Understanding EventSourcing ch.12-17, built by tools/slice.mjs "
        + "as the nine successive appends those chapters are. A FIXTURE for the tool, not a domain model of ours.",
  },
  // The id is renamed too, not just the label: `slice.mjs identity --band <id>` addresses a band by
  // id, and leaving the template's swim-rename means the one command that needs to name it cannot.
  "swim-rename": {
    id: "swim-cart",
    label: "Cart stream — one stream per cart session", streams: "Cart", identity: "aggregateId",
    note: "ch.14: \"Since this identifier uniquely ties together all events within a shopping-cart session, "
        + "we'll call it aggregateId for now.\" The book's own name, kept.",
  },
});

// ---- THE BOARD. ch.18 is where the book stops modelling and starts structuring, and it gives two
// things this fixture now carries. First: "It is perfectly fine to have more than one model on a
// board. In fact, this is the rule rather than the exception for me." Second, the SECOND MODEL
// itself — an alternative flow gets "a dedicated model", and the book names this one:
//
//   "if a customer fails to submit a cart three times due to technical issues, the cart process is
//    aborted. We could add this rule to the current model, but it would disrupt the flow. Most of the
//    time, it's easier to define a dedicated model for this."   — ch.18
//
// So region 2 is the book's own "Submit Cart Error" flow, not an invented context. It is created HERE,
// before round 1, rather than appended at the end: every one of the nine rounds then runs against a
// two-region file, so region targeting and the downward cascade are exercised by the whole replay
// instead of by a postscript. Its CONTENT is filled in after the rounds, so "nine rounds" still means
// the book's nine appends to the cart.
//
// NOT drawn: ch.18's link marker under the slice ("I place a marker below the slice with a link to a
// different model on the board"). That is notation, and notation is step 5.
slice("model", "--context", "submit-cart-error", "--system", "cart",
  "--label", "Submit Cart Error\nsubmit-cart-error · cart");

const rounds = [];

// ---------------------------------------------------------------- 1. add-item (ch.12)
rounds.push(() => {
  slice("add", "--slice", "add-item", "--pattern", "state-change", "--aggregate", "Cart");
  edit({
    "scr-add-item": { label: "Cart Page", screen: "cart",
      inputs: "productId:UUID, description:string, image:string, price:Double" },
    "cmd-add-item": { label: "Add Item", aggregate: "Cart",
      fields: "aggregateId:UUID, itemId:UUID, productId:UUID, description:string, image:string, price:Double",
      terminal: "aggregateId:generated, itemId:generated",
      note: "ch.12 Fig.12.15: itemId's real source is the Item Added event, so the command mints it." },
    "evt-add-item": { label: "Item Added",
      fields: "aggregateId:UUID, itemId:UUID, productId:UUID, description:string, image:string, price:Double" },
  });
  CART_CELLS.push("scr-add-item");
  gwt("gwt-add-item-1", "add-item", 0,
    { rule: "an item can be added to the cart", when: "Add Item", then: "Item Added" });
  // Sign it off, so round 3's ripple has something real to demote. Without this, `demote` is a
  // command the fixture never exercises.
  promote("add-item", "ready");
});

// ---------------------------------------------------------------- 2. cart-items (ch.12)
// INSERTED AT POSITION 0, not appended, and the book's figures are drawn the other way round.
// ch.12 Fig.12.16 reuses this read model for the Cart Page, so it feeds a screen — and a View ->
// Screen edge may not point left. CLAUDE.md: "where a screen reads a View drawn to its right, put
// the View's column first." The event feeding it then runs back under the Event -> View exception.
rounds.push(() => {
  // --model, because --at start means "position 0 of WHICH model" and a state-view names no
  // aggregate — there is genuinely nothing on the canvas to infer the region from.
  slice("add", "--slice", "cart-items", "--pattern", "state-view", "--at", "start", "--model", "cart");
  edit({
    "rm-cart-items": { label: "Cart Items", identity: "aggregateId",
      fields: "aggregateId:UUID, itemId:UUID, productId:UUID, description:string, image:string, price:Double",
      note: "ch.12 Fig.12.16: \"we are reusing the cart items read model for both screens\". Drawn LEFT of "
          + "the screens that read it, which the book's figures do not — a View -> Screen feed may not "
          + "point left, and only Event -> View may." },
  });
  slice("route", "--from", "evt-add-item", "--to", "rm-cart-items");
  slice("route", "--from", "rm-cart-items", "--to", "scr-add-item");
  // The ripple: the Cart Page can now show the cart, so it declares it — and that is an edit to a
  // cell round 1 drew and signed off.
  rippleCartScreen();
  slice("demote", "--slice", "add-item");
});

// ---------------------------------------------------------------- 3. remove-item (ch.12)
rounds.push(() => {
  slice("add", "--slice", "remove-item", "--pattern", "state-change", "--aggregate", "Cart");
  edit({
    "scr-remove-item": { label: "Cart Page", screen: "cart", inputs: "itemId:UUID",
      note: "ch.12: \"How can the UI provide the itemId to the command?\" -- it must be displayed, so the "
          + "screen needs the read model. displays= must agree across cells sharing the slug; inputs= may "
          + "differ, and here they do: adding types a product, removing picks a row." },
    "cmd-remove-item": { label: "Remove Item", aggregate: "Cart", fields: "aggregateId:UUID, itemId:UUID" },
    "evt-remove-item": { label: "Item Removed", fields: "aggregateId:UUID, itemId:UUID" },
  });
  CART_CELLS.push("scr-remove-item");
  rippleCartScreen();
  slice("route", "--from", "rm-cart-items", "--to", "scr-remove-item");
  slice("route", "--from", "evt-remove-item", "--to", "rm-cart-items");
  gwt("gwt-remove-item-1", "remove-item", 0,
    { rule: "an item in the cart can be removed", given: "Item Added",
      when: "Remove Item", then: "Item Removed" });
});

// ---------------------------------------------------------------- 4. clear-cart (ch.14)
rounds.push(() => {
  slice("add", "--slice", "clear-cart", "--pattern", "state-change", "--aggregate", "Cart");
  edit({
    "scr-clear-cart": { label: "Cart Page", screen: "cart", inputs: "aggregateId:UUID" },
    "cmd-clear-cart": { label: "Clear Cart", aggregate: "Cart", fields: "aggregateId:UUID" },
    "evt-clear-cart": { label: "Cart Cleared", fields: "aggregateId:UUID, clearedAt:DateTimeOffset",
      terminal: "clearedAt:clock" },
  });
  CART_CELLS.push("scr-clear-cart");
  rippleCartScreen();
  slice("route", "--from", "rm-cart-items", "--to", "scr-clear-cart");
  // ch.14 p.242: "the cart-items Read Model gets its data not only from Item Added and Item Removed
  // Events, but also from the Cart Cleared-event." Column 4 -> column 2: the Event -> View exception.
  slice("route", "--from", "evt-clear-cart", "--to", "rm-cart-items");
  gwt("gwt-clear-cart-1", "clear-cart", 0,
    { rule: "a cart with items can be cleared", given: "Item Added",
      when: "Clear Cart", then: "Cart Cleared" });
});

// ---------------------------------------------------------------- 5. submit-cart (ch.15)
rounds.push(() => {
  slice("add", "--slice", "submit-cart", "--pattern", "state-change", "--aggregate", "Cart");
  edit({
    "scr-submit-cart": { label: "Cart Page", screen: "cart", inputs: "aggregateId:UUID" },
    "cmd-submit-cart": { label: "Submit Cart", aggregate: "Cart",
      fields: "aggregateId:UUID, orderedProducts:string",
      derived: "orderedProducts=productId",
      note: "ch.15: orderedProducts is a list of {productId, price} -- \"I often provide the structure of "
          + "the data as an example in the form of simple JSON.\" It is built from the cart rows the screen "
          + "shows, so derived= from productId, not a field the user types." },
    "evt-submit-cart": { label: "Cart Submitted", public: "true",
      fields: "aggregateId:UUID, orderedProducts:string, totalPrice:Double, submittedAt:DateTimeOffset",
      derived: "totalPrice=orderedProducts", terminal: "submittedAt:clock",
      note: "ch.15: totalPrice \"does not come with the command. This attribute is calculated during the "
          + "cart submission process.\" So derived=, never mappings=. public= because ch.15 models this as "
          + "the event other systems are interested in." },
  });
  CART_CELLS.push("scr-submit-cart");
  rippleCartScreen();
  slice("route", "--from", "rm-cart-items", "--to", "scr-submit-cart");
  gwt("gwt-submit-cart-1", "submit-cart", 0,
    { rule: "a cart with items can be submitted", given: "Item Added",
      when: "Submit Cart", then: "Cart Submitted" });
});

// ---------------------------------------------------------------- 6. change-inventory (ch.16)
// "Let's add a new swimlane for inventories." The full downward cascade.
rounds.push(() => {
  slice("swimlane", "--label", "Inventory stream — one stream per product",
    "--streams", "Inventory", "--identity", "productId", "--model", "cart");
  slice("add", "--slice", "change-inventory", "--pattern", "translation", "--aggregate", "Inventory");
  edit({
    "ext-change-inventory": { label: "Inventory Changed (external)", origin: "Inventory system",
      fields: "productId:UUID, inventory:int",
      note: "ch.16: \"The inventory system is a completely different system... it's a black box for our "
          + "department.\" origin= is a claim on record, not a checked reference." },
    "rm-change-inventory": { label: "Inventory Updates", identity: "productId",
      fields: "productId:UUID, inventory:int",
      note: "ch.16: the author skips this read model for a direct translation (\"I typically skip the read "
          + "model definition\"). The cheat sheet's translation sequence includes a View and "
          + "tools/model.mjs PATTERNS requires one, so the kit keeps it. A declared divergence." },
    "auto-change-inventory": { label: "Inventory Translator" },
    "cmd-change-inventory": { label: "Change Inventory", aggregate: "Inventory",
      fields: "productId:UUID, inventory:int" },
    "evt-change-inventory": { label: "Inventory Changed", fields: "productId:UUID, inventory:int" },
  });
  gwt("gwt-change-inventory-1", "change-inventory", 0,
    { rule: "an external inventory change is translated into our stream",
      given: "Inventory Changed (external)", when: "Change Inventory", then: "Inventory Changed" });
  // Sign off the two slices ch.16 is about to reach back into, so round 7's demote is real.
  promote("add-item", "ready");
  promote("submit-cart", "ready");
});

// ---------------------------------------------------------------- 7. inventories (ch.16)
// THE MAXIMAL CASE. ch.16: "There is a small inventory indicator in the UI that displays how many
// items are currently in stock." That screen is the Cart Page, in column 1 -- so the view must be
// inserted at position 0, or the View -> Screen feed points left and that is not the exception.
rounds.push(() => {
  slice("add", "--slice", "inventories", "--pattern", "state-view", "--at", "start", "--model", "cart");
  edit({
    "rm-inventories": { label: "Inventories", identity: "productId",
      fields: "productId:UUID, inventory:int",
      note: "ch.16: \"To display this information in the UI, we define a new state view for Inventories.\" "
          + "Inserted at position 0 because the Cart Page reads it and a View -> Screen edge may not "
          + "point left -- CLAUDE.md: \"put the View's column first\"." },
  });
  slice("route", "--from", "evt-change-inventory", "--to", "rm-inventories");
  // ch.16: "We also need this information when adding items to the cart or when submitting the cart."
  // One screen, so every cell of it is fed and every cell declares it.
  for (const id of CART_CELLS) slice("route", "--from", "rm-inventories", "--to", id);
  CART_DISPLAYS += ", inventory";
  rippleCartScreen();
  // ch.16 p.243: the rules the inventory view exists to enforce, added to slices already drawn.
  gwt("gwt-add-item-2", "add-item", 1,
    { rule: "an out-of-stock item cannot be added to the cart", given: "Inventory Changed",
      when: "Add Item", then: "error: OutOfStock", enforce: "aggregate" });
  gwt("gwt-submit-cart-2", "submit-cart", 1,
    { rule: "a cart containing out-of-stock items cannot be submitted",
      given: "Item Added, Inventory Changed", when: "Submit Cart",
      then: "error: CartContainsOutOfStockItems", enforce: "aggregate" });
  // Both slices gained a field AND a rule. Dilger ch.12: back to "Created".
  slice("demote", "--slice", "add-item", "--slice", "submit-cart");
});

// ---------------------------------------------------------------- 8. change-price (ch.17)
rounds.push(() => {
  slice("add", "--slice", "change-price", "--pattern", "translation", "--aggregate", "Inventory");
  edit({
    "ext-change-price": { label: "Price Changed (external)", origin: "Pricing system",
      fields: "productId:UUID, oldPrice:Double, newPrice:Double",
      note: "ch.17: \"The event contains the product-id, the old price, and the new price, allowing us to "
          + "easily determine if the business rules apply.\"" },
    "rm-change-price": { label: "Price Updates", identity: "productId",
      fields: "productId:UUID, oldPrice:Double, newPrice:Double" },
    "auto-change-price": { label: "Price Translator" },
    "cmd-change-price": { label: "Change Price", aggregate: "Inventory",
      fields: "productId:UUID, oldPrice:Double, newPrice:Double" },
    "evt-change-price": { label: "Price Changed",
      fields: "productId:UUID, oldPrice:Double, newPrice:Double" },
  });
  gwt("gwt-change-price-1", "change-price", 0,
    { rule: "an external price change is translated into our stream",
      given: "Price Changed (external)", when: "Change Price", then: "Price Changed" });
});

// ---------------------------------------------------------------- 9. archive-item (ch.17)
// The todo-list automation, in the book's own words: "With pen and paper, I would manually go
// through the list of active cart sessions and mark the relevant ones for later processing."
rounds.push(() => {
  slice("add", "--slice", "archive-item", "--pattern", "automation", "--aggregate", "Cart");
  edit({
    "rm-archive-item": { label: "Carts with Products", identity: "productId",
      fields: "productId:UUID, aggregateId:UUID",
      derived: "aggregateId=Item Added",
      note: "ch.17 Fig.17.5: \"We'll define the Read Model Carts with Products, which includes a product-id "
          + "and a list of cart-ids.\" Fed by Item Added AND Item Removed -- ch.17: \"If an item is removed "
          + "from the cart, any subsequent price changes for that product will no longer be relevant.\" "
          + "This is the todo list, and Item Archived ticks the row off." },
    "auto-archive-item": { label: "Price Change Processor" },
    "cmd-archive-item": { label: "Archive Item", aggregate: "Cart",
      fields: "aggregateId:UUID, productId:UUID",
      note: "ch.17: \"This command only requires the cartId (we called it aggregateId) and the affected "
          + "product-id.\" An automation types nothing: both come from the todo-list View." },
    "evt-archive-item": { label: "Item Archived", fields: "aggregateId:UUID, productId:UUID" },
  });
  slice("route", "--from", "evt-add-item", "--to", "rm-archive-item");
  slice("route", "--from", "evt-remove-item", "--to", "rm-archive-item");
  slice("route", "--from", "evt-change-price", "--to", "rm-archive-item");
  // The tick-off edge: completion, not supply.
  slice("route", "--from", "evt-archive-item", "--to", "rm-archive-item");
  slice("route", "--from", "evt-archive-item", "--to", "rm-cart-items");
  gwt("gwt-archive-item-1", "archive-item", 0,
    { rule: "a cart holding a repriced product has that item archived",
      given: "Item Added, Price Changed", when: "Archive Item", then: "Item Archived" });
  gwt("gwt-archive-item-2", "archive-item", 1,
    { rule: "a run with no affected carts does nothing and is not an error",
      given: "Price Changed", when: "Archive Item", then: "error: NoAffectedCarts" });
});

// ============================================================ drive it

let failed = 0;
for (let i = 0; i < rounds.length; i++) {
  console.log(`\n=== round ${i + 1} ===`);
  rounds[i]();
  const v = validate(i + 1);
  if (v.blockers.length) failed++;
}

// ============================================================ region 2: the book's alternative flow
//
// ch.18, in the book's own words: "if a customer fails to submit a cart three times due to technical
// issues, the cart process is aborted. We could add this rule to the current model, but it would
// disrupt the flow. Most of the time, it's easier to define a dedicated model for this." The flow
// "essentially demonstrates how the cart behaves in the event of an error, including the Given / When
// / Then scenarios."
//
// Everything below is that sentence and nothing more. The three-strikes rule and "the cart process is
// aborted" are the book's; the shapes carrying them are the fixture's, exactly as in the nine rounds.
console.log("\n=== region 2: submit-cart-error (ch.18's dedicated model) ===");
const M2 = ["--model", "submit-cart-error"];
slice("swimlane", "--label", "Cart stream — the same session, on its error flow",
  "--streams", "CartError", "--identity", "aggregateId", ...M2);

slice("add", "--slice", "fail-submission", "--pattern", "state-change", "--aggregate", "CartError");
// The view goes in at position 0 for round 2's reason: the error screen READS the attempt count, and
// a View -> Screen feed may not point left.
slice("add", "--slice", "submission-failures", "--pattern", "state-view", "--at", "start", ...M2);
slice("add", "--slice", "abort-cart", "--pattern", "state-change", "--aggregate", "CartError");
edit({
  "scr-fail-submission": { label: "Cart Page (error)", screen: "cart-error",
    displays: "aggregateId:UUID, attempt:int", inputs: "reason:string" },
  "cmd-fail-submission": { label: "Record Submission Failure", aggregate: "CartError",
    fields: "aggregateId:UUID, reason:string, attempt:int", terminal: "attempt:generated",
    note: "attempt is the handler's count of what is already in the stream, not something the user types." },
  "evt-fail-submission": { label: "Submission Failed",
    fields: "aggregateId:UUID, reason:string, attempt:int, failedAt:DateTimeOffset",
    terminal: "failedAt:clock" },
  "rm-submission-failures": { label: "Submission Failures", identity: "aggregateId",
    fields: "aggregateId:UUID, attempt:int",
    note: "ch.18: the flow exists so the three-strikes rule does not disrupt the main model. This is the "
        + "count that rule is checked against." },
  "scr-abort-cart": { label: "Cart Page (error)", screen: "cart-error",
    displays: "aggregateId:UUID, attempt:int", inputs: "reason:string" },
  "cmd-abort-cart": { label: "Abort Cart", aggregate: "CartError", fields: "aggregateId:UUID" },
  "evt-abort-cart": { label: "Cart Aborted", fields: "aggregateId:UUID, abortedAt:DateTimeOffset",
    terminal: "abortedAt:clock" },
});
slice("route", "--from", "evt-fail-submission", "--to", "rm-submission-failures");
slice("route", "--from", "rm-submission-failures", "--to", "scr-fail-submission");
slice("route", "--from", "rm-submission-failures", "--to", "scr-abort-cart");
const GWT2 = "submit-cart-error-lane-gwt";
gwt("gwt-fail-submission-1", "fail-submission", 0,
  { rule: "a failed submission is recorded", when: "Record Submission Failure",
    then: "Submission Failed" }, GWT2);
gwt("gwt-submission-failures-1", "submission-failures", 0,
  { rule: "the failure count is what the abort rule is checked against",
    given: "Submission Failed(attempt=1)", then: "Submission Failures" }, GWT2);
gwt("gwt-abort-cart-1", "abort-cart", 0,
  { rule: "three failed submissions abort the cart process",
    given: "Submission Failed(attempt=3)", when: "Abort Cart", then: "Cart Aborted" }, GWT2);
console.log("    3 slice(s), the book's three-strikes rule");

// Conway, ch.43. The rule COMPUTES which slices need two teams, and it is exactly the four command
// slices: screen -> command -> event crosses the UI/backend line by definition and nothing else does.
// An unacknowledged split is a warning; an acknowledged one is a note.
console.log("\n=== conway ===");
// Both regions: the rule is per-model, so a board's second model needs the same acknowledgement its
// first one does. Every state-change slice crosses the line and no other slice does — 4 in cart, 2 in
// the error flow.
edit(Object.fromEntries(["add-item", "remove-item", "clear-cart", "submit-cart",
                         "fail-submission", "abort-cart"]
  .map((n) => [`slice-${n}`, { owners: "backend-agent, frontend-agent" }])));
console.log("    6 command slice(s) acknowledged as crossing the UI/backend line, across both models");

// ============================================================ ch.18's structure, on ch.18's example
//
// The book's chapters figure IS this model: "In the Event Model, we logically have the chapters for
// 'Shopping' and within 'Shopping' four sub-chapters for 'Items,' 'Inventory,' 'Price Change,' and
// 'Submission'." Drawn here in the two layers ch.18 asks for, so the fixture carries the book's own
// worked example rather than an invented one.
console.log("\n=== ch.18: chapters and sub-chapters ===");
const C = ["--model", "cart"];
slice("chapter", "--chapter", "shopping", "--label", "Shopping", ...C,
  "--slices", "cart-items, add-item, remove-item, clear-cart, submit-cart");
slice("chapter", "--chapter", "items", "--label", "Items", "--layer", "2", ...C,
  "--slices", "add-item, remove-item, clear-cart");
slice("chapter", "--chapter", "submission", "--label", "Submission", "--layer", "2", ...C,
  "--slices", "submit-cart");
// "Inventory" is the book's third sub-chapter and it is drawn over ONE slice here, not two — and the
// reason is worth recording, because it is the book's own model disagreeing with the book's own
// structure. ch.16 forces the Inventories VIEW into column 0 (the Cart Page reads it, and a View ->
// Screen feed may not point left), while Change Inventory sits far right. A bar covering both would
// span the whole model and paint over "Items" and "Submission" — which `chapter-overlaps` now says out
// loud. Chapters presume columns already grouped by chapter; ch.16's insert-at-0 breaks that grouping,
// and the model is right — so the sub-chapter is the one that gives way.
slice("chapter", "--chapter", "inventory", "--label", "Inventory", "--layer", "2", ...C,
  "--slices", "change-inventory");
slice("chapter", "--chapter", "price-change", "--label", "Price Change", "--layer", "2", ...C,
  "--slices", "change-price, archive-item");

// ch.18: "If there are alternative flows for a certain slice, I place a marker below the slice with a
// link to a different model on the board." This is the exact case the marker was invented for — the
// book's own: submit-cart is the slice, and its error flow is the second model.
console.log("\n=== ch.18: the alternative-flow link ===");
slice("mark", "--slice", "submit-cart", "--alt", "submit-cart-error");

execFileSync("node", [SLICE, "reflow", FILE], { encoding: "utf8" });
console.log("\n=== after reflow ===");
const final = validate("final");

// Idempotency: every command re-run must be a no-op.
const before = readFileSync(FILE, "utf8");
run(["add", FILE, "--slice", "add-item", "--pattern", "state-change"], true);
run(["swimlane", FILE, "--label", "Inventory stream — one stream per product", "--streams", "Inventory"], true);
run(["route", FILE, "--from", "evt-add-item", "--to", "rm-cart-items"], true);
const after = readFileSync(FILE, "utf8");
console.log(`\nidempotent re-run: ${before === after ? "byte-identical OK" : "CHANGED — FAIL"}`);
if (before !== after) failed++;

console.log(`\n${failed ? `FAIL — ${failed} round(s) had flow/slice/swimlane errors` : "OK — no flow/slice/swimlane errors in any round"}`);
console.log(final.out.split("\n").filter((l) => /findings|error|warn/i.test(l)).slice(-6).join("\n"));
process.exit(failed ? 1 : 0);
