// THE STACK BINDING: what a domain type IS, in C#.
//
// WHY THIS IS ITS OWN LAYER, AND WHY IT IS NOT THE MODEL'S JOB.
//
// The event model carries domain knowledge and how information flows. That is all. `fields="aggregateId:UUID"`
// is the BUSINESS saying "a universally unique id" — it is not a claim about .NET, and the model has no
// opinion about .NET because the whole point of the model is that it outlives whichever stack builds it.
// Ch. 12-17 of Understanding EventSourcing writes UUID and Double, and the kit's fixture quotes the book
// deliberately.
//
// So `model.mjs` must NOT hold a list of C# types. Doing that would put the stack inside the artifact that
// is meant to be independent of it — the same mistake as finding T0, one layer down.
//
// And `codegen.mjs` must not GUESS. What it used to do was worse than guessing: a `CS` lookup whose every
// entry mapped a name to itself, with the comment "Anything unknown stays verbatim." So `UUID` sailed
// through as a C# type name and produced 68 compile errors in a project generated from the kit's own
// regression fixture, with nothing anywhere naming the cause. See KIT-FINDINGS W9.
//
// The translation is a DECISION with a COST — `Double` or `decimal` for money is not a typo question, it is
// a rounding question somebody has to own. Decisions with costs live in ARCHITECTURE.md, written by the
// `architect` step. This module is the shared format so that architect (which proposes and records) and
// codegen (which consumes) cannot drift.

// The fence info string. Written by architect.mjs record, read by codegen.mjs, never hand-invented.
export const FENCE = "type-bindings";

// PROPOSALS ONLY, and only for what is genuinely unambiguous. Two rules kept this list short:
//
//   * anything with a real trade-off is NOT here. `Money`, `Amount`, `Percentage`, `Duration` all have more
//     than one defensible C# type, and proposing one would hide the decision that architect exists to
//     surface. They arrive as TODO and a human answers them.
//   * a proposal is not a silent assumption, because it lands in ARCHITECTURE.md where a reviewer sees it
//     next to a Because and an It-costs. That is the difference between this and the old CS table.
export const PROPOSED = {
  // identity
  UUID: "Guid", Uuid: "Guid", GUID: "Guid", Guid: "Guid",
  // text
  string: "string", String: "string", text: "string", Text: "string",
  // whole numbers
  int: "int", Int: "int", Integer: "int", Int32: "int",
  long: "long", Long: "long", Int64: "long",
  // fractional — `decimal` for both, deliberately. Money is the overwhelmingly common case in these models
  // and binary floating point is wrong for it; if a field really is a measurement, say so and override.
  decimal: "decimal", Decimal: "decimal", Double: "decimal", double: "decimal",
  Float: "decimal", float: "decimal", Number: "decimal",
  // truth
  bool: "bool", Bool: "bool", Boolean: "bool", boolean: "bool",
  // time
  DateOnly: "DateOnly", Date: "DateOnly",
  DateTime: "DateTime",
  DateTimeOffset: "DateTimeOffset", Timestamp: "DateTimeOffset", Instant: "DateTimeOffset",
};

// Every distinct scalar type a model uses, in first-seen order.
//
// CHILD GROUP NAMES ARE EXCLUDED. `lines:CartLine[]` with `children="CartLine: ..."` names a shape the
// generator EMITS as a record — it is not a domain scalar and there is nothing to bind. Asking about it
// would be asking the human to name the C# type of a type codegen is about to write.
export function distinctTypes(elements) {
  const groups = new Set();
  for (const e of elements ?? []) for (const g of Object.keys(e.children ?? {})) groups.add(g);
  const seen = new Map();
  for (const e of elements ?? []) {
    const all = [...(e.fields ?? []), ...Object.values(e.children ?? {}).flat()];
    for (const f of all) {
      if (!f?.type || groups.has(f.type) || seen.has(f.type)) continue;
      seen.set(f.type, `${e.label}.${f.name}`);      // remember one place it is used, for the report
    }
  }
  return [...seen].map(([type, usedAt]) => ({ type, usedAt, proposed: PROPOSED[type] ?? null }));
}

// Render the fenced block architect writes into the record.
export function renderBindings(rows) {
  const w = Math.max(...rows.map((r) => r.type.length), 4);
  return "```" + FENCE + "\n" +
    rows.map((r) => `${r.type.padEnd(w)} -> ${r.proposed ?? "TODO(architect)"}`).join("\n") +
    "\n```";
}

// Read them back. Returns {} when there is no record and no block — which is the correct answer for a
// project generated before this existed, and is what keeps the four reference implementations working
// unchanged: they already say Guid and decimal, so an empty binding map changes nothing for them.
export function parseBindings(md) {
  const out = {};
  if (!md) return out;
  const re = new RegExp("```" + FENCE + "\\r?\\n([\\s\\S]*?)```", "g");
  for (const m of md.matchAll(re)) {
    for (const line of m[1].split(/\r?\n/)) {
      const p = /^\s*(\S+)\s*->\s*(\S+)\s*$/.exec(line);
      if (p && !/^TODO/.test(p[2])) out[p[1]] = p[2];
    }
  }
  return out;
}
