// ONE DEFINITION OF "IS THIS VIEW MULTI-STREAM?", SHARED — KIT-FINDINGS V9.
//
// `codegen.mjs` and `architect.mjs` each had their own, and they disagreed:
//
//   codegen    one feeding stream AND identity= equal to that stream's key -> single. Otherwise MULTI
//   architect  streamTypes.length > 1 — the count of feeding aggregate types
//
// A view fed by ONE stream but keyed by something OTHER than that stream's key is multi-stream to the
// generator and single-stream to the architect. codegen registers it `Async`; architect never raised
// `stale-read` for it; nobody ever decided whether that staleness was acceptable. Measured on Voltway:
// FOUR views, every one Async and unquestioned — and two of them were the correspondence lookups a
// translation resolves every foreign notice through, so the unasked question was "can a charge arrive
// before the bay that produced it has projected?"
//
// codegen's was the correct one, because it is what actually decides the registration. This file is that
// definition, extracted rather than copied: the kit's own lesson is that TWO COPIES OF A RULE ARE TWO
// RULES, and the cure for the same shape in the .drawio parsers (V23) was likewise one module both sides
// read through.
//
// The inputs are primitives rather than an IR node, because the two callers hold different shapes:
// codegen has `ir.shared`, architect has per-model `ir.elements`. Passing the three facts the rule
// actually needs is what lets both use it without either having to adopt the other's data model.

/**
 * @param feedingAggregates  the aggregate name of every event feeding this view (duplicates fine, nulls fine)
 * @param streamKeyOfSingle  identity= of the ONE feeding stream, where there is exactly one. Ignored otherwise
 * @param declaredIdentity   identity= declared on the read model, or null/[] where it declares none
 */
export const isMultiStream = ({ feedingAggregates, streamKeyOfSingle, declaredIdentity }) => {
  const streams = [...new Set((feedingAggregates ?? []).filter(Boolean))];
  const streamKey = streams.length === 1 ? (streamKeyOfSingle ?? []) : [];
  const declared = declaredIdentity?.length ? declaredIdentity : null;
  // ONE ROW IS ONE STREAM when a single stream feeds it and the row's grain is that stream's key — either
  // because nothing narrower was declared, or because what was declared IS the stream key.
  const rowIsStream = streams.length === 1 && (
    declared === null ||
    (streamKey.length === declared.length && streamKey.every((k) => declared.includes(k))));
  return !rowIsStream;
};
