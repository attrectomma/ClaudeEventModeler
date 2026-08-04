#!/usr/bin/env node
// Turn an Event Modeling diagram into a typed IR, and check it against the rules.
//
//   node tools/model.mjs compile  <file.drawio> [--out model.json]   XML -> IR on stdout or file
//   node tools/model.mjs validate <file.drawio>                      rules check, exit 1 on error
//
// The diagram is the source of truth. Semantics ride on <object> cells as custom attributes,
// which draw.io exposes to humans through Edit Data (Ctrl+M) and Claude edits as XML:
//
//   <object id="evt-order-placed" label="OrderPlaced" em="event" slice="place-order"
//           aggregate="Order" fields="orderId:Guid, placedAt:DateTimeOffset">
//     <mxCell style="fillColor=#ffe6cc;..." vertex="1" parent="1"> ... </mxCell>
//   </object>
//
// Generators must read the IR, never this XML.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { resolve } from "node:path";

// Fallback classification for cells nobody has annotated yet, so `validate` is useful
// before annotation starts. Matches the palette in CLAUDE.md.
const FILL_KIND = {
  "#ffe6cc": "event",
  "#dae8fc": "command",
  "#e1d5e7": "automation",
  "#d5e8d4": "readmodel",
  "#ffffff": "wireframe",
  "#f8cecc": "external",
  "#f5f5f5": "lane",
};

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");

function attrs(chunk) {
  const out = {};
  for (const [, k, v] of chunk.matchAll(/([\w-]+)="([^"]*)"/g)) out[k] = unescapeXml(v);
  return out;
}

function firstDiagram(xml) {
  const m = /<diagram([^>]*)>([\s\S]*?)<\/diagram>/.exec(xml);
  if (!m) throw new Error("no <diagram> element found");
  const name = attrs(m[1]).name ?? "(unnamed)";
  let body = m[2].trim();
  if (!body.startsWith("<mxGraphModel")) {
    body = decodeURIComponent(inflateRawSync(Buffer.from(body, "base64")).toString("utf8"));
  }
  return { name, body };
}

function geometryOf(chunk) {
  const g = /<mxGeometry([^>]*)as="geometry"/.exec(chunk);
  if (!g) return null;
  const a = attrs(g[1]);
  return {
    x: Number(a.x ?? 0),
    y: Number(a.y ?? 0),
    w: Number(a.width ?? 0),
    h: Number(a.height ?? 0),
  };
}

function fillOf(style = "") {
  return (/fillColor=(#[0-9a-fA-F]{6})/.exec(style)?.[1] ?? "").toLowerCase();
}

function parseFields(spec) {
  if (!spec) return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, rawType] = entry.split(":").map((s) => s?.trim());
      const type = rawType ?? "string";
      return { name, type: type.replace(/\?$/, ""), nullable: type.endsWith("?") };
    });
}

function parseRejects(spec) {
  if (!spec) return [];
  return spec
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(":");
      if (i < 0) return { name: entry, condition: null };
      return { name: entry.slice(0, i).trim(), condition: entry.slice(i + 1).trim() };
    });
}

// examples="EmptyOrder: totalAmount=0 | TooLarge: totalAmount=999999"
// One violating input per rejection rule. A condition cannot be solved backwards into an
// input, so the model has to state it — otherwise the rejection is untestable.
function parseExamples(spec) {
  if (!spec) return {};
  const out = {};
  for (const entry of spec.split("|").map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    if (i < 0) continue;
    const rule = entry.slice(0, i).trim();
    out[rule] = Object.fromEntries(
      entry
        .slice(i + 1)
        .split(",")
        .map((kv) => kv.split("=").map((s) => s.trim()))
        .filter((kv) => kv.length === 2)
    );
  }
  return out;
}

function parseCells(body) {
  const nodes = [];
  const edges = [];

  const consume = (id, a, chunk) => {
    const style = a.style ?? "";
    const kind = a.em || FILL_KIND[fillOf(style)] || "unknown";
    if (a.edge === "1") {
      edges.push({ id, source: a.source ?? null, target: a.target ?? null });
      return;
    }
    nodes.push({
      id,
      label: (a.label ?? a.value ?? "").replace(/<[^>]+>/g, "").trim(),
      kind,
      annotated: Boolean(a.em),
      slice: a.slice ?? null,
      aggregate: a.aggregate ?? null,
      fields: parseFields(a.fields),
      rejects: parseRejects(a.rejects),
      examples: parseExamples(a.examples),
      geometry: geometryOf(chunk),
    });
  };

  // <object> cells carry the semantics; their id/label live on the wrapper.
  let rest = body;
  for (const m of body.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const outer = attrs(m[1]);
    const inner = /<mxCell\b([^>]*)>/.exec(m[2]);
    consume(outer.id, { ...outer, ...attrs(inner?.[1] ?? "") , label: outer.label }, m[2]);
    rest = rest.replace(m[0], "");
  }
  // Whatever is left is a bare mxCell — not yet annotated.
  for (const m of rest.matchAll(/<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g)) {
    const a = attrs(m[1]);
    if (a.id === "0" || a.id === "1") continue;
    consume(a.id, a, m[3] ?? "");
  }
  return { nodes, edges };
}

function buildIr(file) {
  const { name, body } = firstDiagram(readFileSync(file, "utf8"));
  const { nodes, edges } = parseCells(body);

  const lanes = nodes
    .filter((n) => n.kind === "lane" || n.id.startsWith("lane-"))
    .map((n) => ({ id: n.id, label: n.label, ...n.geometry }));
  const elements = nodes.filter((n) => !lanes.some((l) => l.id === n.id));

  const laneOf = (n) => {
    if (!n.geometry) return null;
    const mid = n.geometry.y + n.geometry.h / 2;
    return lanes.find((l) => mid >= l.y && mid <= l.y + l.h)?.id ?? null;
  };
  for (const e of elements) e.lane = laneOf(e);

  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const e of elements) {
    e.upstream = edges.filter((x) => x.target === e.id).map((x) => x.source).filter((s) => byId.has(s));
    e.downstream = edges.filter((x) => x.source === e.id).map((x) => x.target).filter((t) => byId.has(t));
  }

  const sliceNames = [...new Set(elements.map((e) => e.slice).filter(Boolean))].sort();
  const slices = sliceNames.map((sname) => {
    const members = elements.filter((e) => e.slice === sname);
    const pick = (k) => members.filter((m) => m.kind === k);
    const commands = pick("command");
    return {
      name: sname,
      kind: commands.length ? "state-change" : pick("readmodel").length ? "state-view" : "unknown",
      aggregate: members.find((m) => m.aggregate)?.aggregate ?? null,
      wireframes: pick("wireframe").map(({ id, label }) => ({ id, label })),
      commands: commands.map(({ id, label, aggregate, fields, rejects, examples, downstream }) => ({
        id, label, aggregate, fields, rejects, examples,
        emits: downstream.filter((d) => byId.get(d)?.kind === "event").map((d) => byId.get(d).label),
      })),
      events: pick("event").map(({ id, label, aggregate, fields, upstream }) => ({
        id, label, aggregate, fields,
        producedBy: upstream.map((u) => byId.get(u).label),
      })),
      readModels: pick("readmodel").map(({ id, label, fields, upstream }) => ({
        id, label, fields, from: upstream.map((u) => byId.get(u).label),
      })),
      automations: pick("automation").map(({ id, label }) => ({ id, label })),
    };
  });

  return {
    source: file.replace(/\\/g, "/"),
    page: name,
    lanes: lanes.map(({ id, label }) => ({ id, label })),
    slices,
    unassigned: elements.filter((e) => !e.slice).map(({ id, label, kind }) => ({ id, label, kind })),
    elements,
  };
}

// --- rules -------------------------------------------------------------------

function validate(ir) {
  const d = [];
  const push = (severity, rule, message) => d.push({ severity, rule, message });
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const eventLane = ir.lanes.find((l) => /event/i.test(l.label))?.id ?? null;

  for (const e of ir.elements) {
    if (e.kind === "event") {
      if (!e.upstream.length) push("error", "event-needs-producer", `${e.label} has no producer — an event must be emitted by a command or automation.`);
      for (const u of e.upstream) {
        if (byId.get(u)?.kind === "event") push("error", "no-event-to-event", `${byId.get(u).label} points straight at ${e.label} — route it through an automation or read model.`);
      }
      if (eventLane && e.lane !== eventLane) push("error", "events-in-event-lane", `${e.label} sits outside the Event Stream lane.`);
    } else if (eventLane && e.lane === eventLane) {
      push("error", "events-in-event-lane", `${e.label} (${e.kind}) is in the Event Stream lane — only events belong there.`);
    }
    // The four canonical patterns (eventmodeling.org cheat sheet) are the whole grammar:
    //   Trigger -> Command -> Event(s)
    //   Event(s) -> View
    //   Event(s) -> View -> Automated Trigger -> Command -> Event(s)
    // An automation is a Trigger, so it reads a View and issues a Command. It never receives
    // an event and never emits one — Event -> Processor -> Event is the classic anti-pattern.
    const kindOf = (id) => byId.get(id)?.kind ?? "unknown";
    const labelOf = (id) => byId.get(id)?.label ?? id;
    const isTrigger = (k) => k === "wireframe" || k === "automation" || k === "external";

    if (e.kind === "automation") {
      for (const u of e.upstream) {
        if (kindOf(u) === "event") {
          push("error", "automation-reads-view", `${labelOf(u)} -> ${e.label}: an automation is a Trigger, so it must watch a todo-list View, never receive an event directly.`);
        }
      }
      if (!e.upstream.some((u) => kindOf(u) === "readmodel")) {
        push("error", "automation-needs-view", `${e.label} watches no View — without a todo list there is no record of pending work and nothing stops it working the same row twice.`);
      }
      for (const d of e.downstream) {
        if (kindOf(d) === "event") {
          push("error", "automation-issues-command", `${e.label} -> ${labelOf(d)}: an automation emits a Command, not an Event. Insert the command it issues.`);
        }
      }
    }

    if (e.kind === "command") {
      for (const u of e.upstream) {
        if (!isTrigger(kindOf(u))) {
          push("error", "command-needs-trigger", `${labelOf(u)} (${kindOf(u)}) -> ${e.label}: a Command is only ever issued by a Trigger — a screen, an external system, or an automation.`);
        }
      }
      if (!e.upstream.length) push("error", "command-needs-trigger", `${e.label} has no Trigger — nothing issues it.`);
    }

    if (e.kind === "readmodel") {
      for (const u of e.upstream) {
        if (kindOf(u) !== "event") {
          push("error", "view-from-events", `${labelOf(u)} (${kindOf(u)}) -> ${e.label}: a View is built only from Events.`);
        }
      }
      if (!e.upstream.length) push("error", "view-from-events", `${e.label} is built from no events, so none of its fields have a source.`);
    }

    if (e.kind === "unknown") push("warn", "unclassified", `${e.id} has no em= attribute and an unrecognised fill — cannot classify it.`);
    if (!e.slice) push("info", "no-slice", `${e.label || e.id} is not assigned to a slice, so nothing will be generated from it.`);
    if (e.annotated && !e.geometry) push("warn", "no-geometry", `${e.id} has no geometry.`);
  }

  for (const s of ir.slices) {
    if (s.kind === "unknown") push("warn", "slice-kind", `slice "${s.name}" has neither a command nor a read model.`);
    for (const c of s.commands) {
      if (!c.aggregate) push("error", "needs-aggregate", `command ${c.label} has no aggregate=.`);
      if (!c.fields.length) push("error", "needs-fields", `command ${c.label} has no fields= — nothing to generate a payload from.`);
      if (!c.emits.length) push("error", "command-must-emit", `command ${c.label} emits no event.`);
      for (const r of c.rejects) {
        if (!r.condition) push("error", "reject-needs-condition", `${c.label} rejection "${r.name}" has no condition.`);
        const ex = c.examples?.[r.name];
        if (!ex) {
          push("error", "reject-needs-example", `${c.label} rejection "${r.name}" has no entry in examples= — without a violating input it cannot be tested.`);
        } else {
          for (const k of Object.keys(ex)) {
            if (!c.fields.some((f) => f.name === k)) push("error", "example-unknown-field", `${c.label} example for "${r.name}" sets "${k}", which is not a field of ${c.label}.`);
          }
        }
      }
    }
    for (const ev of s.events) {
      if (!ev.fields.length) push("error", "needs-fields", `event ${ev.label} has no fields=.`);
      // Every event field must be traceable: copied from the command, or filled by the clock.
      const cmd = s.commands.find((c) => c.emits.includes(ev.label));
      if (cmd) {
        for (const f of ev.fields) {
          const fromCmd = cmd.fields.some((cf) => cf.name === f.name);
          const fromClock = /^DateTime(Offset)?$/.test(f.type);
          if (!fromCmd && !fromClock) {
            push("error", "unsourced-field", `${ev.label}.${f.name} is on neither ${cmd.label} nor the clock — the generator cannot fill it.`);
          }
        }
      }
    }
  }
  return d;
}

// --- cli ---------------------------------------------------------------------

const [cmd, target, ...rest] = process.argv.slice(2);
if (!cmd || !target) {
  console.error("usage: node tools/model.mjs <compile|validate> <file.drawio> [--out model.json]");
  process.exit(2);
}
const file = resolve(target);
if (!existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}

const ir = buildIr(file);

if (cmd === "compile") {
  const json = JSON.stringify(ir, null, 2);
  const outIdx = rest.indexOf("--out");
  if (outIdx >= 0 && rest[outIdx + 1]) {
    writeFileSync(resolve(rest[outIdx + 1]), json + "\n", "utf8");
    console.log(`${ir.slices.length} slice(s) -> ${rest[outIdx + 1]}`);
  } else {
    console.log(json);
  }
  process.exit(0);
}

if (cmd === "validate") {
  const d = validate(ir);
  const rank = { error: 0, warn: 1, info: 2 };
  const icon = { error: "ERROR", warn: " WARN", info: " INFO" };
  d.sort((a, b) => rank[a.severity] - rank[b.severity]);
  console.log(`${ir.page} — ${ir.slices.length} slice(s), ${ir.elements.length} element(s)\n`);
  for (const x of d) console.log(`  ${icon[x.severity]}  [${x.rule}] ${x.message}`);
  const errors = d.filter((x) => x.severity === "error").length;
  console.log(
    `\n${errors} error(s), ${d.filter((x) => x.severity === "warn").length} warning(s), ` +
      `${d.filter((x) => x.severity === "info").length} note(s)`
  );
  process.exit(errors ? 1 : 0);
}

console.error(`unknown command: ${cmd}`);
process.exit(2);
