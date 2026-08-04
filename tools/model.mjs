#!/usr/bin/env node
// The deterministic half of the model tooling. Computes; never judges.
//
//   node tools/model.mjs compile  <file.drawio> [--out model.json]
//   node tools/model.mjs validate <file.drawio> [--json]     grammar + completeness, exit 1 on error
//   node tools/model.mjs mark     <file.drawio>              draw red markers on failures, in place
//   node tools/model.mjs clear    <file.drawio>              remove every marker
//
// Two rule families:
//
//   grammar      — does every connection belong to one of the four Event Modeling patterns
//   completeness — does every attribute of every element have a source in a connected element
//
// Completeness is RECALL ONLY. It reports every attribute with no upstream name-match. Some of
// those are legitimately derivable (the book's totalPrice from itemPrice) and want a mappings=
// entry rather than a new field. Deciding which is which is judgement, and belongs to the
// completeness-checker agent or a human — not here. Never soften a finding to look clean.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { resolve } from "node:path";

// Fallback classification, so a model is checkable before anyone annotates em=.
// Matches the palette table in CLAUDE.md.
const FILL_KIND = {
  "#ffffff": "screen",
  "#dae8fc": "command",
  "#ffe6cc": "event",
  "#fff2cc": "external",
  "#d5e8d4": "readmodel",
  "#e1d5e7": "automation",
  "#f0f0f0": "gwt",
  "#f8cecc": "group",
  "#f5f5f5": "lane",
  "#fafafa": "lane",
};

const TRIGGERS = new Set(["screen", "automation", "external"]);
const MARK_PREFIX = "chk-";

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function attrs(chunk) {
  const out = {};
  for (const [, k, v] of chunk.matchAll(/([\w-]+)="([^"]*)"/g)) out[k] = unescapeXml(v);
  return out;
}

function firstDiagram(xml) {
  const m = /<diagram([^>]*)>([\s\S]*?)<\/diagram>/.exec(xml);
  if (!m) throw new Error("no <diagram> element found");
  let body = m[2].trim();
  if (!body.startsWith("<mxGraphModel")) {
    body = decodeURIComponent(inflateRawSync(Buffer.from(body, "base64")).toString("utf8"));
    throw new Error("diagram is compressed — run: node tools/drawio.mjs inflate <file>");
  }
  return { name: attrs(m[1]).name ?? "(unnamed)", body, whole: m[0] };
}

const geometryOf = (chunk) => {
  const g = /<mxGeometry([^>]*?)as="geometry"/.exec(chunk);
  if (!g) return null;
  const a = attrs(g[1]);
  return { x: +(a.x ?? 0), y: +(a.y ?? 0), w: +(a.width ?? 0), h: +(a.height ?? 0) };
};

// "orderId:Guid, note:string?" -> [{name,type,nullable}]
const parseFields = (spec) =>
  !spec ? [] : spec.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [name, raw] = entry.split(":").map((s) => s?.trim());
    const type = raw || "string";
    return { name, type: type.replace(/\?$/, ""), nullable: type.endsWith("?") };
  });

// "total=totalAmount, qty=quantity" -> { total: "totalAmount" }
const parseMappings = (spec) =>
  !spec ? {} : Object.fromEntries(
    spec.split(",").map((s) => s.split("=").map((x) => x.trim())).filter((p) => p.length === 2)
  );

function parseCells(body) {
  const nodes = [];
  const edges = [];
  const consume = (a, chunk) => {
    const id = a.id;
    if (!id || id === "0" || id === "1") return;
    const style = a.style ?? "";
    const fill = (/fillColor=(#[0-9a-fA-F]{6})/.exec(style)?.[1] ?? "").toLowerCase();
    if (a.edge === "1") {
      edges.push({ id, source: a.source ?? null, target: a.target ?? null });
      return;
    }
    nodes.push({
      id,
      label: (a.label ?? a.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      kind: a.em || FILL_KIND[fill] || "unknown",
      annotated: Boolean(a.em),
      slice: a.slice ?? null,
      aggregate: a.aggregate ?? null,
      fields: parseFields(a.fields),
      inputs: parseFields(a.inputs),
      mappings: parseMappings(a.mappings),
      gwt: { given: a.given ?? null, when: a.when ?? null, then: a.then ?? null, rule: a.rule ?? null },
      geometry: geometryOf(chunk),
    });
  };

  let rest = body;
  for (const m of body.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const outer = attrs(m[1]);
    const inner = attrs(/<mxCell\b([^>]*)>/.exec(m[2])?.[1] ?? "");
    consume({ ...inner, ...outer }, m[2]);
    rest = rest.replace(m[0], "");
  }
  for (const m of rest.matchAll(/<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g)) {
    consume(attrs(m[1]), m[3] ?? "");
  }
  return { nodes, edges };
}

function buildIr(file) {
  const { name, body } = firstDiagram(readFileSync(file, "utf8"));
  const { nodes, edges } = parseCells(body);

  const isMarker = (id) => id.startsWith(MARK_PREFIX);
  const lanes = nodes.filter((n) => n.kind === "lane" || n.id.startsWith("lane-"));
  const elements = nodes.filter(
    (n) => !lanes.includes(n) && !isMarker(n.id) && n.kind !== "group"
  );
  const live = edges.filter((e) => !isMarker(e.id));

  const byId = new Map(elements.map((e) => [e.id, e]));
  const laneOf = (n) => {
    if (!n.geometry) return null;
    const mid = n.geometry.y + n.geometry.h / 2;
    return lanes.find((l) => l.geometry && mid >= l.geometry.y && mid <= l.geometry.y + l.geometry.h)?.id ?? null;
  };
  for (const e of elements) {
    e.lane = laneOf(e);
    e.upstream = live.filter((x) => x.target === e.id).map((x) => x.source).filter((s) => byId.has(s));
    e.downstream = live.filter((x) => x.source === e.id).map((x) => x.target).filter((t) => byId.has(t));
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
      screens: pick("screen").map((x) => x.id),
      commands: commands.map((x) => x.id),
      events: [...pick("event"), ...pick("external")].map((x) => x.id),
      readModels: pick("readmodel").map((x) => x.id),
      automations: pick("automation").map((x) => x.id),
      gwts: pick("gwt").map((x) => ({ id: x.id, ...x.gwt, label: x.label })),
    };
  });

  return {
    source: file.replace(/\\/g, "/"),
    page: name,
    lanes: lanes.map(({ id, label }) => ({ id, label })),
    slices,
    elements,
    edges: live,
  };
}

// --- grammar: every connection must belong to one of the four patterns -------

function grammar(ir) {
  const d = [];
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const kindOf = (id) => byId.get(id)?.kind ?? "unknown";
  const labelOf = (id) => byId.get(id)?.label || id;
  const eventLane = ir.lanes.find((l) => /event/i.test(l.label))?.id ?? null;
  const push = (rule, message, at) => d.push({ family: "grammar", severity: "error", rule, message, at });

  for (const e of ir.elements) {
    if (e.kind === "gwt") continue;

    if (e.kind === "event" || e.kind === "external") {
      for (const u of e.upstream) {
        if (kindOf(u) === "event" || kindOf(u) === "external") {
          push("no-event-to-event", `${labelOf(u)} points straight at ${e.label}. Events never connect to events.`, e.id);
        }
      }
      if (e.kind === "event" && !e.upstream.length) {
        push("event-needs-producer", `${e.label} has no Command producing it.`, e.id);
      }
      if (eventLane && e.lane !== eventLane) {
        push("events-in-event-lane", `${e.label} sits outside the Event Stream lane.`, e.id);
      }
    } else if (eventLane && e.lane === eventLane) {
      push("events-in-event-lane", `${e.label} (${e.kind}) is in the Event Stream lane. Only events belong there.`, e.id);
    }

    // An automation is a Trigger: it watches a todo-list View and issues a Command.
    if (e.kind === "automation") {
      for (const u of e.upstream) {
        if (kindOf(u) === "event" || kindOf(u) === "external") {
          push("automation-reads-view", `${labelOf(u)} -> ${e.label}: an automation is a Trigger and must watch a todo-list View, never receive an event directly.`, e.id);
        }
      }
      if (!e.upstream.some((u) => kindOf(u) === "readmodel")) {
        push("automation-needs-view", `${e.label} watches no View. Without a todo list there is no record of pending work, and nothing stops it working the same row twice.`, e.id);
      }
      for (const dn of e.downstream) {
        if (kindOf(dn) === "event" || kindOf(dn) === "external") {
          push("automation-issues-command", `${e.label} -> ${labelOf(dn)}: an automation emits a Command, not an Event.`, e.id);
        }
      }
    }

    if (e.kind === "command") {
      for (const u of e.upstream) {
        if (!TRIGGERS.has(kindOf(u))) {
          push("command-needs-trigger", `${labelOf(u)} (${kindOf(u)}) -> ${e.label}: a Command is only issued by a Trigger — a screen, an external system, or an automation.`, e.id);
        }
      }
      if (!e.upstream.length) push("command-needs-trigger", `${e.label} has no Trigger issuing it.`, e.id);
      if (!e.downstream.some((dn) => kindOf(dn) === "event" || kindOf(dn) === "external")) {
        push("command-must-emit", `${e.label} emits no Event.`, e.id);
      }
    }

    if (e.kind === "readmodel") {
      for (const u of e.upstream) {
        if (kindOf(u) !== "event" && kindOf(u) !== "external") {
          push("view-from-events", `${labelOf(u)} (${kindOf(u)}) -> ${e.label}: a View is built only from Events.`, e.id);
        }
      }
      if (!e.upstream.length) {
        push("view-from-events", `${e.label} is built from no Events, so none of its attributes can have a source.`, e.id);
      }
    }
  }

  // "Can we have more than one Command?" — "No." (the little book, ch. 6)
  for (const s of ir.slices) {
    if (s.commands.length > 1) {
      d.push({ family: "grammar", severity: "error", rule: "one-command-per-slice",
        message: `slice "${s.name}" has ${s.commands.length} commands. A State Change slice has exactly one.`, at: s.commands[1] });
    }
  }
  return d;
}

// --- completeness: every attribute needs a source in a connected element -----

function completeness(ir) {
  const d = [];
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const kindOf = (id) => byId.get(id)?.kind ?? "unknown";
  const labelOf = (id) => byId.get(id)?.label || id;

  // Which upstream elements may legitimately supply this element's attributes.
  const sourcesFor = (e) => {
    if (e.kind === "readmodel") {
      return e.upstream.filter((u) => kindOf(u) === "event" || kindOf(u) === "external");
    }
    if (e.kind === "event" || e.kind === "external") {
      return e.upstream.filter((u) => kindOf(u) === "command");
    }
    if (e.kind === "command") {
      // A Trigger supplies from the View it displays, plus anything typed on it (inputs=).
      const out = [];
      for (const t of e.upstream.filter((u) => TRIGGERS.has(kindOf(u)))) {
        out.push(t);
        out.push(...(byId.get(t)?.upstream ?? []).filter((u) => kindOf(u) === "readmodel"));
      }
      return out;
    }
    return [];
  };

  for (const e of ir.elements) {
    if (e.kind === "gwt" || !e.fields.length) continue;

    const sources = sourcesFor(e);
    const supply = new Map(); // attribute name -> [source labels]
    for (const sid of sources) {
      const s = byId.get(sid);
      if (!s) continue;
      for (const f of [...s.fields, ...s.inputs]) {
        if (!supply.has(f.name)) supply.set(f.name, []);
        supply.get(f.name).push(s.label || s.id);
      }
    }

    for (const f of e.fields) {
      const wanted = e.mappings[f.name] ?? f.name;
      if (supply.has(wanted)) continue;

      // A clock-filled timestamp is generated, not carried. Everything else must be traceable.
      if ((e.kind === "event" || e.kind === "external") && /^DateTime(Offset)?$/.test(f.type)) {
        d.push({ family: "completeness", severity: "info", rule: "clock-filled",
          message: `${e.label}.${f.name} has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.`,
          at: e.id, attribute: f.name });
        continue;
      }

      d.push({
        family: "completeness", severity: "error", rule: "unsourced-attribute",
        message: sources.length
          ? `${e.label}.${f.name} is supplied by none of its sources (${sources.map(labelOf).join(", ")}). Walk backwards: where does this data really come from?`
          : `${e.label}.${f.name} has no incoming source at all.`,
        at: e.id, attribute: f.name,
        // The connection to mark red: whichever source should have carried it.
        connections: sources.map((sid) => ({ from: sid, to: e.id })),
      });
    }

    for (const [target, source] of Object.entries(e.mappings)) {
      if (!e.fields.some((f) => f.name === target)) {
        d.push({ family: "completeness", severity: "warn", rule: "mapping-unknown-target",
          message: `${e.label} maps "${target}" but has no such attribute.`, at: e.id, attribute: target });
      } else if (!supply.has(source)) {
        d.push({ family: "completeness", severity: "error", rule: "mapping-unknown-source",
          message: `${e.label}.${target} is mapped from "${source}", which no source supplies.`, at: e.id, attribute: target });
      }
    }
  }

  for (const e of ir.elements) {
    if (!e.slice && e.kind !== "unknown") {
      d.push({ family: "hygiene", severity: "info", rule: "no-slice",
        message: `${e.label || e.id} is not assigned to a slice, so nothing downstream will be generated from it.`, at: e.id });
    }
    if (e.kind === "unknown") {
      d.push({ family: "hygiene", severity: "warn", rule: "unclassified",
        message: `${e.id} has no em= and an unrecognised fill, so it cannot be classified.`, at: e.id });
    }
  }
  return d;
}

// --- marking: overlay cells only, never mutate a modelled cell ---------------

function stripMarkers(xml) {
  return xml
    .replace(new RegExp(`\\s*<object\\b[^>]*id="${MARK_PREFIX}[^"]*"[\\s\\S]*?</object>`, "g"), "")
    .replace(new RegExp(`\\s*<mxCell\\b[^>]*id="${MARK_PREFIX}[^"]*"(?:\\s*/>|[\\s\\S]*?</mxCell>)`, "g"), "");
}

function markerCells(ir, findings) {
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const cells = [];
  const seen = new Set();

  const byElement = new Map();
  for (const f of findings) {
    if (f.severity !== "error" || !f.at) continue;
    if (!byElement.has(f.at)) byElement.set(f.at, []);
    byElement.get(f.at).push(f);
  }

  for (const [id, fs] of byElement) {
    const el = byId.get(id);
    if (!el?.geometry) continue;
    const { x, y, w } = el.geometry;
    const attrsList = [...new Set(fs.map((f) => f.attribute).filter(Boolean))];
    const tip = escapeXml(
      (attrsList.length ? `unsourced: ${attrsList.join(", ")}\n` : "") + fs.map((f) => `• ${f.message}`).join("\n")
    );
    // Badge sits on the corner rather than restyling the element, so clearing is exact.
    cells.push(
      `        <object id="${MARK_PREFIX}badge-${id}" label="!" tooltip="${tip}">\n` +
      `          <mxCell style="ellipse;whiteSpace=wrap;html=1;fillColor=#b85450;strokeColor=#ffffff;strokeWidth=2;fontColor=#ffffff;fontStyle=1;fontSize=14;" vertex="1" parent="1">\n` +
      `            <mxGeometry x="${x + w - 11}" y="${y - 11}" width="22" height="22" as="geometry" />\n` +
      `          </mxCell>\n        </object>`
    );

    for (const f of fs) {
      for (const c of f.connections ?? []) {
        const key = `${c.from}->${c.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cells.push(
          `        <mxCell id="${MARK_PREFIX}edge-${c.from}-${c.to}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;dashed=1;strokeColor=#b85450;strokeWidth=3;endArrow=block;opacity=70;" edge="1" parent="1" source="${c.from}" target="${c.to}">\n` +
          `          <mxGeometry relative="1" as="geometry" />\n        </mxCell>`
        );
      }
    }
  }
  return cells;
}

// --- cli ---------------------------------------------------------------------

const [cmd, target, ...rest] = process.argv.slice(2);
if (!cmd || !target) {
  console.error("usage: node tools/model.mjs <compile|validate|mark|clear> <file.drawio> [--json] [--out f]");
  process.exit(2);
}
const file = resolve(target);
if (!existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}

if (cmd === "clear") {
  const xml = readFileSync(file, "utf8");
  const out = stripMarkers(xml);
  writeFileSync(file, out, "utf8");
  console.log(out === xml ? "no markers to remove." : "markers removed.");
  process.exit(0);
}

const ir = buildIr(file);
const findings = [...grammar(ir), ...completeness(ir)];
const errors = findings.filter((f) => f.severity === "error");

if (cmd === "compile") {
  const json = JSON.stringify(ir, null, 2);
  const i = rest.indexOf("--out");
  if (i >= 0 && rest[i + 1]) {
    writeFileSync(resolve(rest[i + 1]), json + "\n", "utf8");
    console.log(`${ir.slices.length} slice(s) -> ${rest[i + 1]}`);
  } else console.log(json);
  process.exit(0);
}

if (cmd === "mark") {
  const xml = stripMarkers(readFileSync(file, "utf8"));
  const cells = markerCells(ir, findings);
  writeFileSync(file, cells.length ? xml.replace(/(\s*)<\/root>/, `\n${cells.join("\n")}$1</root>`) : xml, "utf8");
  console.log(`${cells.length} marker(s) for ${errors.length} error(s). Render to check placement.`);
  process.exit(errors.length ? 1 : 0);
}

if (cmd === "validate") {
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ page: ir.page, source: ir.source, slices: ir.slices.map((s) => s.name), findings }, null, 2));
    process.exit(errors.length ? 1 : 0);
  }
  const rank = { error: 0, warn: 1, info: 2 };
  const icon = { error: "ERROR", warn: " WARN", info: " INFO" };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.family.localeCompare(b.family));
  console.log(`${ir.page} — ${ir.slices.length} slice(s), ${ir.elements.length} element(s)\n`);
  for (const f of findings) console.log(`  ${icon[f.severity]}  [${f.family}/${f.rule}] ${f.message}`);
  console.log(
    `\n${errors.length} error(s), ${findings.filter((f) => f.severity === "warn").length} warning(s), ` +
      `${findings.filter((f) => f.severity === "info").length} note(s)`
  );
  process.exit(errors.length ? 1 : 0);
}

console.error(`unknown command: ${cmd}`);
process.exit(2);
