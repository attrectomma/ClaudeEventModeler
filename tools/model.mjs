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
      // On a screen: what it shows (the book marks these green on the wireframe) and what the
      // user types into it. `displays` must be sourced from a View; `inputs` is a terminal source.
      displays: parseFields(a.displays),
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

  // The full chain, each link checked:
  //   screen.displays  <- Views feeding the screen        (screen.inputs is terminal: the user)
  //   command.fields   <- the triggering screen's displays + inputs, or an automation's todo View
  //   event.fields     <- the Command that triggers it
  //   readmodel.fields <- the Events feeding it
  const supplyFor = (e) => {
    const sources = [];
    const supply = new Map(); // attribute name -> [source labels]
    const offer = (src, fields) => {
      for (const f of fields) {
        if (!supply.has(f.name)) supply.set(f.name, []);
        supply.get(f.name).push(src.label || src.id);
      }
    };
    const take = (id, fields) => {
      const s = byId.get(id);
      if (!s) return;
      sources.push(id);
      offer(s, fields ?? s.fields);
    };

    if (e.kind === "readmodel") {
      for (const u of e.upstream.filter((u) => kindOf(u) === "event" || kindOf(u) === "external")) take(u);
    } else if (e.kind === "event" || e.kind === "external") {
      for (const u of e.upstream.filter((u) => kindOf(u) === "command")) take(u);
    } else if (e.kind === "screen") {
      for (const u of e.upstream.filter((u) => kindOf(u) === "readmodel")) take(u);
    } else if (e.kind === "command") {
      for (const t of e.upstream.filter((u) => TRIGGERS.has(kindOf(u)))) {
        const trig = byId.get(t);
        if (!trig) continue;
        if (trig.kind === "screen") {
          if (trig.displays.length) {
            // Strict: a screen can only pass on what it shows or what is typed into it.
            take(t, [...trig.displays, ...trig.inputs]);
          } else {
            // The screen has not declared its displayed data, so fall back to its Views to keep
            // the model checkable. screen-declares-nothing warns that this hole is open.
            take(t, trig.inputs);
            for (const u of trig.upstream.filter((x) => kindOf(x) === "readmodel")) take(u);
          }
        } else if (trig.kind === "automation") {
          // An automation types nothing: everything comes from the todo-list View it watches.
          for (const u of trig.upstream.filter((x) => kindOf(x) === "readmodel")) take(u);
        } else {
          take(t, [...trig.fields, ...trig.inputs]);
        }
      }
    }
    return { sources, supply };
  };

  for (const e of ir.elements) {
    if (e.kind === "gwt") continue;
    // A screen is judged on what it displays; everything else on its own attributes.
    const attributes = e.kind === "screen" ? e.displays : e.fields;
    if (!attributes.length) continue;

    const { sources, supply } = supplyFor(e);

    for (const f of attributes) {
      const wanted = e.mappings[f.name] ?? f.name;
      if (supply.has(wanted)) continue;

      // An external event enters from another system. We have neither control over it nor
      // knowledge of what produced it — that is what em="external" means, and grammar() already
      // acts on it by exempting these from event-needs-producer. Requiring a Command upstream
      // would be unsatisfiable by construction: no legal model could ever clear the finding.
      // So: terminal, exactly like a screen's inputs=.
      //
      // Reported rather than skipped, because the field list is an integration contract. These
      // names are the ones OUR views happen to need, which is not evidence the upstream system
      // publishes them. That wants confirming once, against their schema.
      //
      // Checked BEFORE clock-filled on purpose. An external timestamp was stamped by the
      // upstream clock and arrives as payload; calling it clock-filled invites an implementer to
      // write UtcNow at ingest and silently rewrite a foreign fact.
      if (e.kind === "external") {
        d.push({ family: "completeness", severity: "info", rule: "external-terminal",
          message: `${e.label}.${f.name} enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.`,
          at: e.id, attribute: f.name });
        continue;
      }

      // A clock-filled timestamp is generated, not carried. Everything else must be traceable.
      if (e.kind === "event" && /^DateTime(Offset)?$/.test(f.type)) {
        d.push({ family: "completeness", severity: "info", rule: "clock-filled",
          message: `${e.label}.${f.name} has no upstream source and is a timestamp — assumed filled by the clock. Confirm that is intended.`,
          at: e.id, attribute: f.name });
        continue;
      }

      const dead = !sources.length;
      d.push({
        family: "completeness", severity: "error",
        rule: e.kind === "screen" ? "undisplayable-data" : "unsourced-attribute",
        message:
          e.kind === "screen" && dead
            ? `${e.label} displays ${f.name} but no View feeds it. The screen cannot know this — it needs a read model.`
            : e.kind === "screen"
              ? `${e.label} displays ${f.name}, which none of its Views supply (${sources.map(labelOf).join(", ")}).`
              : dead
                ? `${e.label}.${f.name} has no incoming source at all.`
                : `${e.label}.${f.name} is supplied by none of its sources (${sources.map(labelOf).join(", ")}). Walk backwards: where does this data really come from?`,
        at: e.id, attribute: f.name,
        // The connection to mark red: whichever source should have carried it.
        connections: sources.map((sid) => ({ from: sid, to: e.id })),
      });
    }

    for (const [target, source] of Object.entries(e.mappings)) {
      if (!attributes.some((f) => f.name === target)) {
        d.push({ family: "completeness", severity: "warn", rule: "mapping-unknown-target",
          message: `${e.label} maps "${target}" but has no such attribute.`, at: e.id, attribute: target });
      } else if (!supply.has(source)) {
        d.push({ family: "completeness", severity: "error", rule: "mapping-unknown-source",
          message: `${e.label}.${target} is mapped from "${source}", which no source supplies.`, at: e.id, attribute: target });
      }
    }
  }

  // A screen that issues a command but never says what it shows is the hole this check exists to
  // close: its read model could be missing every attribute and nothing would notice.
  for (const e of ir.elements) {
    if (e.kind !== "screen") continue;
    // Only a screen that is fed a View has undeclared displayed data. A screen whose command
    // data is entirely typed (inputs=) has no hole, so warning about it would be noise.
    const issues = e.downstream.some((dn) => kindOf(dn) === "command");
    const fed = e.upstream.some((u) => kindOf(u) === "readmodel");
    if (issues && fed && !e.displays.length) {
      d.push({ family: "completeness", severity: "warn", rule: "screen-declares-nothing",
        message: `${e.label} triggers a command but declares no displays=. Until it does, nothing verifies that its View actually supplies what the screen shows.`,
        at: e.id });
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

// --- GWTs: do the business rules name things that actually exist? ------------
//
// "GIVEN a set of Events, WHEN a Command, THEN a new set of Events." A GWT naming an event that
// isn't in the model is a rule nobody can implement or test, and it reads as correct on the
// canvas. THEN may also be an error outcome: then="error: TooManyAddresses".

function gwtRules(ir) {
  const d = [];
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const byLabel = new Map();
  for (const e of ir.elements) if (e.label) byLabel.set(e.label, e);
  const names = (spec) => (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const isEvent = (el) => el && (el.kind === "event" || el.kind === "external");
  const push = (severity, rule, message, at) => d.push({ family: "gwt", severity, rule, message, at });

  for (const s of ir.slices) {
    // Required on State Change slices, where the business rules live. Optional on State View
    // slices, where a GWT is really "GIVEN events THEN this view shows".
    if (!s.gwts.length) {
      if (s.kind === "state-change") {
        push("warn", "slice-needs-gwt",
          `slice "${s.name}" has no GWT. Business rules are invisible without one, and the book is explicit: "Don't save on GWTs."`,
          s.commands[0]);
      }
      continue;
    }

    for (const g of s.gwts) {
      const cmd = g.when ? byLabel.get(g.when) : null;

      if (s.commands.length) {
        if (!g.when) {
          push("error", "gwt-needs-when", `GWT "${g.rule || g.label || g.id}" has no when=, so it names no Command.`, g.id);
        } else if (!cmd || cmd.kind !== "command") {
          push("error", "gwt-unknown-command", `GWT "${g.rule || g.id}" names when="${g.when}", which is not a Command in this model.`, g.id);
        } else if (!s.commands.includes(cmd.id)) {
          push("error", "gwt-command-other-slice", `GWT "${g.rule || g.id}" names when="${g.when}", which belongs to a different slice.`, g.id);
        }
      }

      for (const n of names(g.given)) {
        if (!isEvent(byLabel.get(n))) {
          push("error", "gwt-unknown-event", `GWT "${g.rule || g.id}" has given="${n}", which is not an Event in this model.`, g.id);
        }
      }

      const thens = names(g.then);
      if (!thens.length) {
        push("error", "gwt-needs-then", `GWT "${g.rule || g.label || g.id}" has no then=, so it asserts nothing.`, g.id);
      }
      for (const n of thens) {
        if (/^error\b/i.test(n)) continue; // an expected rejection, not an event
        const el = byLabel.get(n);
        // On a State View slice the outcome is the View's contents, not an event.
        if (!s.commands.length && el?.kind === "readmodel") continue;
        if (!isEvent(el)) {
          push("error", "gwt-unknown-event", `GWT "${g.rule || g.id}" has then="${n}", which is neither an Event in this model nor an "error: ..." outcome.`, g.id);
          continue;
        }
        if (cmd && cmd.kind === "command" && !cmd.downstream.includes(el.id)) {
          push("error", "gwt-then-not-emitted",
            `GWT "${g.rule || g.id}" expects ${n} from ${g.when}, but ${g.when} has no connection to it. The GWT and the diagram disagree.`,
            g.id);
        }
      }
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
const findings = [...grammar(ir), ...completeness(ir), ...gwtRules(ir)];
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
