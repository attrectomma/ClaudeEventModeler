#!/usr/bin/env node
// The deterministic half of the model tooling. Computes; never judges.
//
//   node tools/model.mjs compile  <file.drawio> [--out model.json]
//   node tools/model.mjs validate <file.drawio> [--json]     grammar + completeness, exit 1 on error
//   node tools/model.mjs validate <system-dir>/ [--json]     every model in the system, plus the
//                                                            cross-model rules a single file
//                                                            structurally cannot see
//   node tools/model.mjs map      <system-dir>/              (re)generate _context-map.drawio
//   node tools/model.mjs mark     <file.drawio>              draw red markers on failures, in place
//   node tools/model.mjs clear    <file.drawio>              remove every marker
//
// Seven rule families:
//
//   grammar      — does every connection belong to one of the four Event Modeling patterns
//   completeness — does every attribute of every element have a source in a connected element
//   gwt          — do the business rules name a Command and Events that actually exist
//   flow         — does every connection point left to right, the one exception being Event -> View
//   conway       — can each slice actually be built by one team, or does it span the org chart
//   slice        — is each vertical slice a real, contiguous band whose declared pattern matches
//                  what it is made of, and is its status= honest about the findings inside it
//   system       — folder-scoped. Does every imported event resolve to a model that publishes it,
//                  with the fields we consume; is every slice name unique; is each model still
//                  small enough to read in one render
//
// Completeness is RECALL ONLY. It reports every attribute with no upstream name-match. Some of
// those are legitimately derivable (the book's totalPrice from itemPrice) and want a mappings=
// entry rather than a new field. Deciding which is which is judgement, and belongs to the
// completeness-checker agent or a human — not here. Never soften a finding to look clean.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { resolve, join, basename, dirname } from "node:path";
import { tryProjectRoot, projectRoot, projectName } from "./project.mjs";

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
// "orderId:Guid, total:decimal?, lines:OrderLine[]"
//
// `[]` means MANY OF THESE, NOT ONE — a repeated group inside one row. It is the answer to the one
// thing a flat comma-separated list cannot say, and the reason a detail screen showing a header plus
// its line items needed two read models before this existed. The group's own shape is declared
// separately, in children= below, because a name:Type list has nowhere to nest one.
const parseFields = (spec) =>
  !spec ? [] : spec.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [name, raw] = entry.split(":").map((s) => s?.trim());
    let type = raw || "string";
    const collection = /\[\]\??$/.test(type);
    type = type.replace(/\[\]/, "");
    return { name, type: type.replace(/\?$/, ""), nullable: type.endsWith("?"), collection };
  });

// "OrderLine: sku:string, qty:int; Discount: code:string, pct:decimal"
//
// The shape of a repeated group referenced by a `Type[]` field. Same name:Type grammar as fields=, so
// there is nothing new to learn beyond the brackets; `;` separates one group from the next.
//   -> { OrderLine: [{name:"sku",...},{name:"qty",...}], Discount: [...] }
const parseChildren = (spec) =>
  !spec ? {} : Object.fromEntries(spec.split(";").map((part) => {
    const i = part.indexOf(":");
    if (i < 0) return null;
    const name = part.slice(0, i).trim();
    return name ? [name, parseFields(part.slice(i + 1))] : null;
  }).filter(Boolean));

// `recipients:string[]` is a list of PRIMITIVES and needs no shape declaring — it already is the
// attribute, and asking for children="string: ..." would be nonsense. Only a list of a named group
// needs children=. Getting this wrong broke the state-view reference implementation with 12 errors,
// because every `recipients` reference stopped resolving.
const PRIMITIVE = new Set([
  "string", "int", "long", "short", "byte", "decimal", "double", "float", "bool",
  "Guid", "UUID", "DateOnly", "DateTime", "DateTimeOffset", "TimeOnly", "TimeSpan", "Double",
]);
// A collection field is a GROUP only when a shape is declared for it. Anything else is a plain list.

// "total=totalAmount, qty=quantity" -> { total: "totalAmount" }
// A RENAME, and only a rename: the checker substitutes the name and looks it up. A sum, a fold or
// a truncation is not a rename — see derived=.
const parseMappings = (spec) =>
  !spec ? {} : Object.fromEntries(
    spec.split(",").map((s) => s.split("=").map((x) => x.trim())).filter((p) => p.length === 2)
  );

// "dayTotal=hours, monthStatus=MonthClosed+MonthClosureSubmitted"
//   -> { dayTotal: ["hours"], monthStatus: ["MonthClosed", "MonthClosureSubmitted"] }
// Computed, not carried: a sum, a count, a fold over which events occurred. Same comma-separated
// shape as mappings= so there is nothing new to learn; `+` lists the inputs. Each input must be
// either an attribute an upstream source supplies, or the label of an upstream source itself —
// so this records what a generator needs AND stays referentially checkable. It is not a silencer.
const parseDerived = (spec) =>
  !spec ? {} : Object.fromEntries(
    spec.split(",").map((s) => s.split("=").map((x) => x.trim())).filter((p) => p.length === 2)
      .map(([target, srcs]) => [target, srcs.split("+").map((x) => x.trim()).filter(Boolean)])
  );

// "closedBy:actor, bookingId:generated" — attributes that enter from ambient context rather than
// from the data flow, the way a screen's inputs= and a clock-filled timestamp already do.
// Deliberately the same "name:kind" shape as fields=, so it reuses parseFields outright.
const TERMINAL_KINDS = new Set([
  "actor",     // the authenticated principal — never in the request body
  "generated", // an id the handler mints
  "clock",     // time, at handling
  "const",     // a literal
]);

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
      // Only meaningful on a slice cell: which of the four patterns this slice is, and where it
      // sits in the implementation workflow.
      pattern: a.pattern ?? null,
      status: a.status ?? null,
      // Only on a swimlane band: which aggregates' events live in this stream, and what identifies
      // one stream of it. `identity` is what a generator needs to append to the right stream at
      // all — Marten keys a stream, and nothing else in the model says by what.
      streams: a.streams ?? null,
      identity: a.identity ?? null,
      // Only on a model cell: this model's identity within its system. Dilger's pink "Model
      // Context" note — "I use a pink sticky note placed on the left side of each model to
      // properly name it."
      context: a.context ?? null,
      system: a.system ?? null,
      // The cross-model surface. `public` marks an event another model in this system may
      // consume; `from` marks an imported one and names the model that publishes it; `origin`
      // names a genuine third party, which nothing here can check.
      isPublic: a.public === "true",
      from: a.from ?? null,
      origin: a.origin ?? null,
      // On an external event: we deliberately APPEND this foreign event into a stream of ours, so it may
      // share a band with events we write. Acknowledges external-in-written-band. A claim on record and
      // nothing more — no rule can tell a considered inbox pattern from an accident, which is why the
      // default is to warn and the acknowledgement is a human's signature.
      ingested: a.ingested === "true",
      // A screen's identity. Screens repeat across every slice that triggers from them, so the
      // slug is what makes three Timesheet cells one screen — see screenRules().
      screen: a.screen ?? null,
      // On a wireframe cell: which attribute this element shows (em="field"), or which Command
      // this affordance issues (em="action").
      binds: a.binds ?? null,
      command: a.command ?? null,
      // Conway. On a lane: which team does work in it. On a slice cell: who is accountable, and
      // `owners` acknowledges a slice that genuinely needs more than one team.
      owner: a.owner ?? null,
      owners: a.owners ?? null,
      aggregate: a.aggregate ?? null,
      fields: parseFields(a.fields),
      // The shape of any repeated group a `Type[]` field references. On a read model this is what lets
      // ONE view hold a header and its line items, instead of the two views that shape used to need.
      children: parseChildren(a.children),
      // On a screen fed by more than one View: the attribute it lines them up on. "none" says it never
      // correlates them. Left off, the checker asks for a shared attribute and warns if there is none.
      joins: a.joins ?? null,
      // On a screen: what it shows (the book marks these green on the wireframe) and what the
      // user types into it. `displays` must be sourced from a View; `inputs` is a terminal source.
      displays: parseFields(a.displays),
      inputs: parseFields(a.inputs),
      mappings: parseMappings(a.mappings),
      derived: parseDerived(a.derived),
      terminal: parseFields(a.terminal),
      gwt: { given: a.given ?? null, when: a.when ?? null, then: a.then ?? null, rule: a.rule ?? null,
              // Where this rule is enforced. A rule the request alone can settle belongs at the
              // periphery; one needing accumulated state belongs where the stream is visible. NOT
              // derivable from given= being empty: a context given= like "the month is open" is on
              // almost every GWT, so this is declared.
              enforce: a.enforce ?? "aggregate" },
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
  // A swimlane is drawn INSIDE the Event Stream lane and is not itself a lane. Keeping it out of
  // `lanes` matters: laneOf() takes the first containing match, and parseCells returns every
  // <object> before every bare <mxCell>, so a swimlane authored as an object would otherwise be
  // found ahead of the lane that contains it and every event would look misplaced.
  const swimlaneNodes = nodes.filter((n) => n.streams && !isMarker(n.id));
  const lanes = nodes.filter(
    (n) => !swimlaneNodes.includes(n) && (n.kind === "lane" || n.id.startsWith("lane-"))
  );
  // The model cell names the model; it is not an element of it. Left in `elements` it would be
  // reported as unsliced, and laneOf() would try to place a note that belongs to no lane.
  const modelCells = nodes.filter((n) => n.kind === "model" && !isMarker(n.id));
  const elements = nodes.filter(
    (n) => !lanes.includes(n) && !swimlaneNodes.includes(n) && !modelCells.includes(n) &&
      !isMarker(n.id) && n.kind !== "group"
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

  // A slice cell is the slice's identity on the canvas: a labelled rectangle drawn around the
  // slice's columns, carrying pattern= and status=. Deliberately a plain rectangle and NOT a
  // draw.io container — a container reparents its children and makes their mxGeometry relative,
  // which would break every absolute-x reader here and in tools/crop.mjs.
  const sliceCells = nodes.filter((n) => n.kind === "group" && n.slice && !isMarker(n.id));
  // Swimlanes cut the Event Stream lane horizontally, one band per stream. "Swimlanes define
  // stream boundaries. Typically, all events in one swimlane end up in a physical stream."
  const swimlanes = swimlaneNodes
    .map((n) => ({ id: n.id, label: n.label, geometry: n.geometry,
                   streams: n.streams.split(",").map((s) => s.trim()).filter(Boolean),
                   identity: (n.identity ?? "").split(",").map((s) => s.trim()).filter(Boolean) }));

  const sliceNames = [...new Set([
    ...elements.map((e) => e.slice).filter(Boolean),
    ...sliceCells.map((c) => c.slice),
  ])].sort();
  const slices = sliceNames.map((sname) => {
    const members = elements.filter((e) => e.slice === sname);
    const pick = (k) => members.filter((m) => m.kind === k);
    const commands = pick("command");
    const cells = sliceCells.filter((c) => c.slice === sname);
    return {
      name: sname,
      cells: cells.map((c) => c.id),
      pattern: cells.find((c) => c.pattern)?.pattern ?? null,
      status: cells.find((c) => c.status)?.status ?? null,
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

  // The model's own extent, which is what "can it be read in one render" is measured against.
  const right = Math.max(0, ...[...elements, ...lanes].map((n) => (n.geometry ? n.geometry.x + n.geometry.w : 0)));

  return {
    source: file.replace(/\\/g, "/"),
    page: name,
    model: modelCells[0]
      ? { id: modelCells[0].id, label: modelCells[0].label, context: modelCells[0].context,
          system: modelCells[0].system, duplicated: modelCells.length > 1 }
      : null,
    width: right,
    lanes: lanes.map(({ id, label, owner }) => ({ id, label, owner: owner ?? null })),
    slices,
    sliceCells,
    swimlanes,
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

    // A repeated group and its shape have to agree, or the completeness check silently decides the group
    // supplies nothing — which reads as "this view is missing every ingredient field" and sends you
    // hunting in entirely the wrong place.
    const declared = Object.keys(e.children ?? {});
    const referenced = [...e.fields, ...e.displays, ...e.inputs].filter((f) => f.collection).map((f) => f.type);
    for (const t of new Set(referenced)) {
      // A list of primitives needs no shape — `recipients:string[]` is already the attribute. Only a
      // list of a NAMED group does, and an unknown name is far more likely a typo than a new primitive.
      if (!declared.includes(t) && !PRIMITIVE.has(t)) {
        push("child-not-declared",
          `${e.label || e.id} has a field of type ${t}[] but declares no shape for it. Add children="${t}: name:Type, ..." — a repeated group's own fields have nowhere else to live. (A list of primitives such as string[] needs no children=.)`,
          e.id);
      }
    }
    for (const t of declared) {
      if (!referenced.includes(t)) {
        d.push({ family: "grammar", severity: "warn", rule: "child-unused",
          message: `${e.label || e.id} declares children="${t}: ..." but no field is of type ${t}[]. Either reference it or drop it.`,
          at: e.id });
      }
    }

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
  // A repeated group is transparent to this check, in BOTH directions, and that symmetry is the whole
  // trick:
  //
  //   * asking side — a read model declaring `ingredients:IngredientLine[]` is really asking for
  //     ingredientName, amount and unit, because that is what an IngredientAdded event can supply. The
  //     collection field itself has no source and never could.
  //   * supplying side — a screen displaying `ingredientName` is satisfied by a view offering
  //     `ingredients:IngredientLine[]`, because the name is in there.
  //
  // Flatten on both sides and the group stops needing any special case downstream: mappings=, derived=,
  // terminal= and mapping-crosses-types all keep working on flat names.
  const flatten = (el, fields) => fields.flatMap((f) => {
    const shape = el?.children?.[f.type];
    // A list of PRIMITIVES stays itself: `recipients:string[]` IS the attribute `recipients`, and
    // expanding it would make every reference to it stop resolving. Only a declared group flattens.
    if (!f.collection || !shape) return [f];
    return shape;
  });

  const supplyFor = (e) => {
    const sources = [];
    const supply = new Map(); // attribute name -> [source labels]
    const types = new Map();  // attribute name -> the type the source declares
    const offer = (src, fields) => {
      for (const f of flatten(src, fields)) {
        if (!supply.has(f.name)) supply.set(f.name, []);
        supply.get(f.name).push(src.label || src.id);
        if (!types.has(f.name)) types.set(f.name, f.type);
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
    return { sources, supply, types };
  };

  for (const e of ir.elements) {
    if (e.kind === "gwt") continue;
    // A screen is judged on what it displays; everything else on its own attributes. Flattened, so a
    // `Type[]` group is checked as the fields it actually contains — the collection name itself is not
    // an attribute anything upstream could ever supply.
    const attributes = flatten(e, e.kind === "screen" ? e.displays : e.fields);
    if (!attributes.length) continue;

    const { sources, supply, types } = supplyFor(e);

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
        // With from= the producer IS in this system, so systemRules can check the contract for
        // real. Saying "confirm it" here would send a reader off to do by hand what the folder
        // check already did.
        d.push({ family: "completeness", severity: "info", rule: "external-terminal",
          message: e.from
            ? `${e.label}.${f.name} is imported from the ${e.from} model, so it is terminal here. The contract is checked across the system, not in this file.`
            : `${e.label}.${f.name} enters from another system, so it is terminal here. Confirm the upstream contract actually carries it.`,
          at: e.id, attribute: f.name });
        continue;
      }

      // Declared as arriving from ambient context. Reported, never silent, so a reader can see
      // what the handler is expected to supply and disagree with it.
      const term = e.terminal.find((t) => t.name === f.name);
      if (term) {
        if (!TERMINAL_KINDS.has(term.type)) {
          d.push({ family: "completeness", severity: "error", rule: "terminal-unknown-kind",
            message: `${e.label}.${f.name} is declared terminal="${term.type}", which is not one of: ${[...TERMINAL_KINDS].join(", ")}.`,
            at: e.id, attribute: f.name });
        } else {
          d.push({ family: "completeness", severity: "info", rule: "terminal-context",
            message: `${e.label}.${f.name} comes from ${term.type}, not from the data flow. Confirm the handler supplies it.`,
            at: e.id, attribute: f.name });
        }
        continue;
      }

      // Computed from upstream rather than carried. Every named input still has to exist.
      if (e.derived[f.name]) {
        const srcLabels = new Set(sources.map(labelOf));
        const unknown = e.derived[f.name].filter((src) => !supply.has(src) && !srcLabels.has(src));
        if (unknown.length) {
          d.push({ family: "completeness", severity: "error", rule: "derived-unknown-source",
            message: `${e.label}.${f.name} is derived from ${unknown.join(", ")}, which no connected source supplies or names. A derivation cannot invent its inputs.`,
            at: e.id, attribute: f.name, connections: sources.map((sid) => ({ from: sid, to: e.id })) });
        } else {
          d.push({ family: "completeness", severity: "info", rule: "derived-attribute",
            message: `${e.label}.${f.name} is computed from ${e.derived[f.name].join(" + ")}, not carried.`,
            at: e.id, attribute: f.name });
        }
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
      } else {
        // A rename cannot change the type. int <- DateOnly is a count; string <- DateOnly is a
        // truncation. Both are computations wearing a rename's clothes, and a generator reading
        // the IR would emit an assignment where a fold belongs.
        const want = attributes.find((f) => f.name === target)?.type;
        const got = types.get(source);
        if (want && got && want !== got) {
          d.push({ family: "completeness", severity: "warn", rule: "mapping-crosses-types",
            message: `${e.label}.${target}:${want} is mapped from "${source}":${got}. A mapping is a rename and cannot change the type — this looks like a computation, so it belongs in derived=.`,
            at: e.id, attribute: target });
        }
      }
    }

    for (const t of e.terminal) {
      if (!attributes.some((f) => f.name === t.name)) {
        d.push({ family: "completeness", severity: "warn", rule: "terminal-unknown-target",
          message: `${e.label} declares terminal="${t.name}" but has no such attribute.`, at: e.id, attribute: t.name });
      }
    }
    for (const target of Object.keys(e.derived)) {
      if (!attributes.some((f) => f.name === target)) {
        d.push({ family: "completeness", severity: "warn", rule: "derived-unknown-target",
          message: `${e.label} derives "${target}" but has no such attribute.`, at: e.id, attribute: target });
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

  // TWO VIEWS ON ONE SCREEN MUST HAVE SOMETHING TO LINE UP ON.
  //
  // This is the hole that let a model the BOOK CALLS INCOMPLETE pass at zero errors. Understanding
  // EventSourcing ch.16 exists to demonstrate the completeness check finding a missing field: a stock
  // indicator is shown "for each item in the cart", and the cart's own read model had no productId, so
  // "we haven't modelled the product-id yet. This is important."
  //
  // The kit found nothing, because the check is NAME-BASED: productId was supplied — by the Inventories
  // view, which is keyed by it — so the name resolved and everything looked sourced. What it could not see
  // is that the two views had no field in common, so no row of one could ever be matched to a row of the
  // other. A join is not a name lookup, and the check had no concept of one.
  //
  // So: a screen fed by two or more Views must share at least one attribute across ALL of them — the thing
  // it lines them up on. Declared with joins= where it is not obvious, and joins="none" acknowledges a
  // screen that genuinely displays unrelated figures side by side and never correlates them.
  //
  // A WARNING, not an error, because whether this screen needs to correlate is a question only a human can
  // answer — a dashboard showing total revenue beside active users needs no join and never will. The kit's
  // house style for exactly this shape is Conway's: warn on the unacknowledged case, note the acknowledged
  // one.
  for (const e of ir.elements) {
    if (e.kind !== "screen") continue;
    const views = e.upstream.map((u) => byId.get(u)).filter((v) => v?.kind === "readmodel");
    if (views.length < 2) continue;

    const declared = (e.joins ?? "").trim();
    const namesOf = (v) => new Set(flatten(v, v.fields).map((f) => f.name));
    const shared = [...namesOf(views[0])].filter((n) => views.every((v) => namesOf(v).has(n)));

    if (/^none$/i.test(declared)) {
      d.push({ family: "completeness", severity: "info", rule: "screen-views-unjoined-ack",
        message: `${e.label} is fed by ${views.length} Views and declares joins="none": its figures are shown side by side and never correlated. Acknowledged.`,
        at: e.id });
    } else if (declared) {
      for (const k of declared.split(",").map((x) => x.trim()).filter(Boolean)) {
        const missing = views.filter((v) => !namesOf(v).has(k));
        if (missing.length) {
          d.push({ family: "completeness", severity: "error", rule: "join-not-supplied",
            message: `${e.label} declares joins="${k}", but ${missing.map((v) => v.label).join(" and ")} does not carry ${k}. A screen cannot line up two Views on a field one of them lacks — add it to that View, and to the events and command behind it.`,
            at: e.id, attribute: k });
        }
      }
    } else if (!shared.length) {
      d.push({ family: "completeness", severity: "warn", rule: "screen-views-cannot-join",
        message: `${e.label} is fed by ${views.map((v) => v.label).join(" and ")}, which share no attribute — so nothing on this screen can line up a row of one with a row of the other. If it needs to, the key is missing from one of them (and from the events and command behind it). If it genuinely never correlates them, say so with joins="none".`,
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
  // Labels are NOT unique and must not be treated as if they were. One event type reachable from
  // two slices is drawn as two cells with the same label — MonthClosed via review and via the
  // admin shortcut — and screens repeat across every slice that triggers from them. A
  // label -> element map keeps only the last of each, so a GWT naming that label silently
  // resolved to whichever cell happened to sit later in the file.
  //
  // The three GWT fields have genuinely different scopes, so each resolves differently:
  //   when=   this slice only     — it must be this slice's Command
  //   then=   this slice first    — the event this slice's Command emits, else anywhere
  //   given=  anywhere            — prior events almost always come from EARLIER slices, so
  //                                 scoping given= to the slice would break every honest GWT
  const byLabel = new Map();
  for (const e of ir.elements) {
    if (!e.label) continue;
    if (!byLabel.has(e.label)) byLabel.set(e.label, []);
    byLabel.get(e.label).push(e);
  }
  const all = (label) => byLabel.get(label) ?? [];
  const names = (spec) => (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const isEvent = (el) => el && (el.kind === "event" || el.kind === "external");
  const push = (severity, rule, message, at) => d.push({ family: "gwt", severity, rule, message, at });

  for (const s of ir.slices) {
    // Asked for on State Change AND State View slices, for different reasons and in different shapes.
    //
    // A State Change slice takes a GWT: GIVEN events, WHEN a command, THEN events or an error.
    // A State View slice takes a GT — a GWT with no when= — because a read model only ever reads events
    // that already exist, so there is no command to be the WHEN. Understanding EventSourcing ch.3: "you
    // typically do not use GWTs but GTs (Given - Then). Read Models only rely on previously stored
    // events, so there is no 'When' part necessary." The little book is blunter: for a State View,
    // "Scenario is always a 'Given / Then' (skipping the 'When' Part)".
    //
    // View slices used to be exempt from this warning, and that is exactly how one reached in-review
    // with no specifications at all: everything downstream was happy to generate nothing. Nothing else
    // asks, so this is the only prompt there is.
    if (!s.gwts.length) {
      if (s.kind === "state-change") {
        push("warn", "slice-needs-gwt",
          `slice "${s.name}" has no GWT. Business rules are invisible without one, and the book is explicit: "Don't save on GWTs."`,
          s.commands[0]);
      } else if (s.pattern === "view") {
        push("warn", "slice-needs-gwt",
          `slice "${s.name}" has no GIVEN/THEN. A View is specified as "GIVEN a set of events, THEN the read model shows this" — a gwt cell with given= and then= and NO when=, because a read model has no command to be the WHEN. Without one, nothing states what this view is for and nothing is generated to check it.`,
          s.readModels[0]);
      }
      continue;
    }

    for (const g of s.gwts) {
      // Prefer this slice's own Command, so a repeated label cannot resolve to a stranger.
      // Falling back keeps the two diagnostics below honest: "not a Command" vs "other slice".
      const cmd = !g.when ? null
        : all(g.when).find((e) => e.kind === "command" && s.commands.includes(e.id))
          ?? all(g.when).find((e) => e.kind === "command")
          ?? all(g.when)[0] ?? null;

      // A MISSING when= IS ONLY AN ERROR ON A STATE CHANGE SLICE.
      //
      // This used to be gated on `s.commands.length`, which was right for a View — no command, so no
      // WHEN — and wrong for everything else. An automation and a translation slice both HAVE a command,
      // and both are specified in two halves:
      //
      //   the infrastructure half   GIVEN these events, THEN that event    (nobody issues anything;
      //                                                                     the processor reacts)
      //   the domain half           GIVEN ..., WHEN the command, THEN ...
      //
      // The little book gives exactly that split — "Test Automation using Given / Then... Given these 2
      // Events, we expect the automation to run automatically, make the external API Call and result in
      // another Event", alongside "Test the state change slices using Given / When / Then". ch.13 of
      // Understanding EventSourcing says the same: "For read model AND AUTOMATION tests, the 'When' step
      // is typically omitted."
      //
      // So the kit documented a shape it then rejected, which is worse than not documenting it. Caught by
      // modelling ch.16 of the book, where the translation's infrastructure half is exactly this.
      if (s.pattern === "command") {
        if (!g.when) {
          push("error", "gwt-needs-when", `GWT "${g.rule || g.label || g.id}" has no when=, so it names no Command. A State Change slice's scenarios are always GIVEN/WHEN/THEN; only a View, Automation or Translation may omit the WHEN.`, g.id);
        } else if (!cmd || cmd.kind !== "command") {
          push("error", "gwt-unknown-command", `GWT "${g.rule || g.id}" names when="${g.when}", which is not a Command in this model.`, g.id);
        } else if (!s.commands.includes(cmd.id)) {
          push("error", "gwt-command-other-slice", `GWT "${g.rule || g.id}" names when="${g.when}", which belongs to a different slice.`, g.id);
        }
      }

      for (const n of names(g.given)) {
        // Global on purpose: a given= names a prior fact, wherever it was produced. Where a label
        // is shared by two cells of the same event type, either answers "did this happen".
        if (!all(n).some(isEvent)) {
          push("error", "gwt-unknown-event", `GWT "${g.rule || g.id}" has given="${n}", which is not an Event in this model.`, g.id);
        }
      }

      const thens = names(g.then);
      if (!thens.length) {
        push("error", "gwt-needs-then", `GWT "${g.rule || g.label || g.id}" has no then=, so it asserts nothing.`, g.id);
      }
      for (const n of thens) {
        if (/^error\b/i.test(n)) continue; // an expected rejection, not an event
        // Resolve against what this slice's Command actually emits before falling back, so a
        // label shared with another slice cannot make a correct GWT look like a contradiction.
        const cands = all(n);
        const el = (cmd?.kind === "command" && cands.find((c) => cmd.downstream.includes(c.id)))
          || cands.find(isEvent) || cands[0] || null;
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

// --- slices: the vertical slice as a first-class thing ------------------------
//
// A slice used to have no identity here. It was a string repeated across the cells that happened
// to belong to it, reconstructed by grouping. That made three things impossible: slice membership
// was invisible on the canvas (drag a cell into another column and nothing noticed), the pattern
// was inferred and never declared (so a wrong shape could not be caught), and there was nowhere
// to hang a fact about the slice itself.
//
// A slice cell — em="group", slice=, pattern=, status= — is that identity.

const PATTERNS = {
  // the four from the Event Modeling cheat sheet, plus the one shape that is none of them
  command:     { commands: 1, views: false, automations: false, events: true },
  view:        { commands: 0, views: true,  automations: false, events: false },
  automation:  { commands: 1, views: true,  automations: true,  events: true },
  translation: { commands: 1, views: true,  automations: true,  events: true },
  // external events landing in our stream, authored elsewhere. Not a pattern; still a column.
  upstream:    { commands: 0, views: false, automations: false, events: true },
};
const STATUSES = ["in-design", "ready", "in-progress", "in-review", "closed"];

function sliceRules(ir, priorFindings) {
  const d = [];
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const push = (severity, rule, message, at) => d.push({ family: "slice", severity, rule, message, at });
  const centre = (g) => (g ? { x: g.x + g.w / 2, y: g.y + g.h / 2 } : null);
  const inside = (c, g) => {
    const p = centre(g);
    return p && c.geometry &&
      p.x >= c.geometry.x && p.x <= c.geometry.x + c.geometry.w &&
      p.y >= c.geometry.y && p.y <= c.geometry.y + c.geometry.h;
  };

  for (const s of ir.slices) {
    if (!s.cells.length) {
      push("error", "slice-needs-cell",
        `slice "${s.name}" has no slice cell, so it has no identity on the canvas and can carry no pattern= or status=.`,
        s.commands[0] ?? s.readModels[0] ?? s.events[0]);
      continue;
    }
    if (s.cells.length > 1) {
      push("error", "slice-cell-duplicated",
        `slice "${s.name}" has ${s.cells.length} slice cells. A vertical slice is one contiguous band — exactly one cell.`,
        s.cells[1]);
    }
    const cell = ir.sliceCells.find((c) => c.id === s.cells[0]);

    // --- pattern: declared vs what the cells actually form
    if (!s.pattern) {
      push("warn", "slice-needs-pattern",
        `slice "${s.name}" declares no pattern=. One of: ${Object.keys(PATTERNS).join(", ")}.`, cell.id);
    } else if (!PATTERNS[s.pattern]) {
      push("error", "slice-unknown-pattern",
        `slice "${s.name}" declares pattern="${s.pattern}", which is not one of: ${Object.keys(PATTERNS).join(", ")}.`, cell.id);
    } else {
      const want = PATTERNS[s.pattern];
      const has = {
        commands: s.commands.length, views: s.readModels.length > 0,
        automations: s.automations.length > 0, events: s.events.length > 0,
      };
      const wrong = [];
      if (has.commands !== want.commands) wrong.push(`${has.commands} command(s), expected ${want.commands}`);
      if (want.views && !has.views) wrong.push("no View");
      if (!want.views && has.views) wrong.push("has a View");
      if (want.automations && !has.automations) wrong.push("no Automation");
      if (!want.automations && has.automations) wrong.push("has an Automation");
      if (want.events && !has.events) wrong.push("no Event");
      if (wrong.length) {
        push("error", "slice-pattern-mismatch",
          `slice "${s.name}" declares pattern="${s.pattern}" but ${wrong.join("; ")}. The declaration and the diagram disagree.`,
          cell.id);
      }
    }

    // --- geometry: the drawn band and the declared membership must agree
    if (cell?.geometry) {
      for (const e of ir.elements) {
        if (e.kind === "gwt") continue;                      // GWTs live below the band
        const within = inside(cell, e.geometry);
        if (within && e.slice !== s.name) {
          push("error", "slice-membership-mismatch",
            `${e.label || e.id} is drawn inside slice "${s.name}" but declares slice="${e.slice ?? "(none)"}".`, e.id);
        } else if (!within && e.slice === s.name) {
          push("error", "slice-member-outside",
            `${e.label || e.id} declares slice="${s.name}" but is drawn outside that slice's band.`, e.id);
        }
      }
    }

    // --- status: the gate, per slice rather than for the whole model
    if (!s.status) {
      push("warn", "slice-needs-status", `slice "${s.name}" declares no status=. One of: ${STATUSES.join(", ")}.`, cell.id);
    } else if (!STATUSES.includes(s.status)) {
      push("error", "slice-unknown-status",
        `slice "${s.name}" declares status="${s.status}", which is not one of: ${STATUSES.join(", ")}.`, cell.id);
    } else if (s.status !== "in-design") {
      // "The implementation cannot begin until this check is passed" — but per slice, so one
      // unresolved attribute elsewhere no longer blocks work that is genuinely ready.
      const mine = new Set([...s.screens, ...s.commands, ...s.events, ...s.readModels, ...s.automations,
        ...s.gwts.map((g) => g.id)]);
      const own = priorFindings.filter((f) => f.severity === "error" && f.at && mine.has(f.at));
      if (own.length) {
        push("error", "slice-not-ready",
          `slice "${s.name}" is status="${s.status}" but still has ${own.length} unresolved error(s): ${
            [...new Set(own.map((f) => f.rule))].join(", ")}. It cannot leave in-design.`, cell.id);
      }
      if (!s.gwts.length && s.kind === "state-change") {
        push("error", "slice-not-ready",
          `slice "${s.name}" is status="${s.status}" but has no GWT, so none of its business rules can be tested.`, cell.id);
      }
    }
  }

  // A slice cell naming a slice no element belongs to is an empty band.
  for (const c of ir.sliceCells) {
    if (!ir.elements.some((e) => e.slice === c.slice)) {
      push("warn", "slice-empty", `slice cell "${c.slice}" contains no elements.`, c.id);
    }
  }
  return d;
}

// --- conway: who can actually build this slice ------------------------------
//
// The other half of step 7. "Ideally, each Slice should be owned by a single team — this is key to
// realizing the full benefits of this approach during implementation… What if the UI and backend
// are owned by different teams? … An Event Model often exposes organizational challenges — this is
// Conway's Law in action. If it's not possible to assign a Slice to a single team, that's a direct
// result of the company's structure." — Understanding EventSourcing, ch. 43
//
// So this does not forbid a split slice; the book says it is often unavoidable. It COMPUTES which
// slices need more than one team and makes you say so out loud, because the cost of discovering it
// during implementation is much higher than during modelling.
//
// A team is declared per lane (`owner=` on the lane), because the usual fault line is UI vs
// backend. An element may override its lane. A slice cell may acknowledge a genuine split with
// `owners="a, b"`, which downgrades the finding to a note.

function conwayRules(ir) {
  const d = [];
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const laneOwner = new Map(ir.lanes.filter((l) => l.owner).map((l) => [l.id, l.owner]));
  if (!laneOwner.size) return d;                   // nobody has declared ownership yet
  const push = (severity, rule, message, at) => d.push({ family: "conway", severity, rule, message, at });

  for (const s of ir.slices) {
    const cell = ir.sliceCells.find((c) => c.id === s.cells[0]);
    const members = [...s.screens, ...s.commands, ...s.events, ...s.readModels, ...s.automations]
      .map((id) => byId.get(id)).filter(Boolean);
    const teams = [...new Set(members.map((m) => m.owner ?? laneOwner.get(m.lane)).filter(Boolean))].sort();
    if (!teams.length) continue;

    if (teams.length > 1) {
      const ack = (cell?.owners ?? "").split(",").map((x) => x.trim()).filter(Boolean).sort();
      const acknowledged = ack.length === teams.length && ack.every((t, i) => t === teams[i]);
      push(acknowledged ? "info" : "warn", "slice-crosses-teams",
        `slice "${s.name}" needs ${teams.length} teams: ${teams.join(", ")}.` +
        (acknowledged
          ? " Acknowledged — it cannot be handed to one team, and its GWTs are the contract between them."
          : ` No single team can build it. Say so with owners="${teams.join(", ")}" on the slice cell, or move the boundary.`),
        cell?.id ?? s.commands[0]);
    } else if (cell && !cell.owner) {
      push("info", "slice-owner-derived",
        `slice "${s.name}" is entirely ${teams[0]}. Consider owner="${teams[0]}" on the slice cell.`, cell.id);
    }
  }
  return d;
}

// --- flow: time runs left to right -------------------------------------------
//
// "The goal is to read the system from left to right. It should be a story that makes sense to
// everybody." A connection pointing left is a connection you cannot read, so it is a defect.
//
// With ONE exception, ruled by the domain expert: Event -> View. A read model is necessarily
// built from events that occur after the point it is first drawn — MyTimesheet is fed by the
// HoursCorrected that the very next slice produces. The alternative is redrawing the View at
// every point it is read, which is the canonical form but doubles the width of the model. The
// exception is deliberate; everything else pointing left is reported.

function flowRules(ir) {
  const d = [];
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const isEvent = (k) => k === "event" || k === "external";
  for (const c of ir.edges) {
    const from = byId.get(c.source), to = byId.get(c.target);
    if (!from?.geometry || !to?.geometry) continue;
    if (to.geometry.x >= from.geometry.x) continue;                 // forward, fine
    if (isEvent(from.kind) && to.kind === "readmodel") continue;    // the one exception
    d.push({ family: "flow", severity: "error", rule: "backward-connection",
      message: `${from.label} (${from.kind}) -> ${to.label} (${to.kind}) points backwards. Time runs left to right; only Event -> View may. Reorder the columns.`,
      at: to.id, connections: [{ from: from.id, to: to.id }] });
  }
  return d;
}

// --- swimlanes: stream boundaries -------------------------------------------
//
// A swimlane is NOT a team boundary. "Swimlanes define stream boundaries. Typically, all events in
// one swimlane end up in a physical stream" — Understanding EventSourcing, ch. 7. One band per
// business capability, and every event in the band belongs to that stream.
//
// The rule worth enforcing is the little book's, ch. 11: "a single command should never interact
// with multiple swimlanes or aggregates. The moment you do this, you introduce the need for a
// transactional boundary around the operation." Two effects that must happen atomically are not
// two aggregates — they are one.

function swimlaneRules(ir) {
  const d = [];
  const byId = new Map(ir.elements.map((e) => [e.id, e]));
  const push = (severity, rule, message, at) => d.push({ family: "swimlane", severity, rule, message, at });
  if (!ir.swimlanes.length) return d;             // not every model draws them

  const bandOf = (e) => {
    if (!e.geometry) return null;
    const mid = e.geometry.y + e.geometry.h / 2;
    return ir.swimlanes.find((s) => s.geometry && mid >= s.geometry.y && mid <= s.geometry.y + s.geometry.h) ?? null;
  };

  for (const e of ir.elements) {
    if (e.kind !== "event" && e.kind !== "external") continue;
    if (!e.aggregate) {
      push("warn", "event-needs-aggregate",
        `${e.label} declares no aggregate=, so it belongs to no stream.`, e.id);
      continue;
    }
    const band = bandOf(e);
    if (!band) {
      push("error", "event-outside-swimlane",
        `${e.label} is drawn outside every swimlane, so which stream it lands in is undefined.`, e.id);
    } else if (!band.streams.includes(e.aggregate)) {
      push("error", "event-wrong-swimlane",
        `${e.label} is aggregate="${e.aggregate}" but is drawn in the "${band.label}" swimlane, which holds ${band.streams.join(", ")}.`,
        e.id);
    }
  }

  // A FOREIGN EVENT SHARING A BAND WITH EVENTS WE WRITE.
  //
  // The band rules below already encode the boundary: identity= is required of a band we write to and a band
  // holding only foreign events is EXEMPT, "because we never start those streams, we only project from
  // them." Drawing both kinds in one band quietly contradicts that — it says the other system's event lands
  // in a stream of ours, which can only be true if something of ours appends it, which is the one thing a
  // Translation exists to avoid. An event store is append-only, so a foreign schema written into ours is in
  // our history for ever.
  //
  // WHY THIS RULE EXISTS AT ALL. `slice.mjs add --pattern translation` puts the external event in whatever
  // band already exists, and with one band that is yours. Accepting that default produced a reference
  // implementation that compiled, passed fifteen tests and ran correctly against real Postgres while
  // persisting another system's events into our own stream. Nothing caught it: not a rule, not the compiler,
  // not a green suite, not a live run. A human asked a question. This is that question, automated.
  //
  // A WARNING, NOT AN ERROR, and acknowledgeable — same house style as `joins="none"` and the acknowledged
  // Conway split. There is a legitimate case: an inbox pattern where arrivals are deliberately recorded as
  // first-class events of ours. That is a real architectural claim, so it goes on the record with
  // ingested="true" on the external cell, where a reviewer can disagree with it.
  //
  // Note the book's own ch.16 sketch draws them together, so tools/fixtures/cart-replay.mjs warns here. That
  // is the rule working rather than failing: the ambiguity is in the drawing, and the fixture gates on
  // errors.
  for (const band of ir.swimlanes) {
    const inBand = (kind) => ir.elements.filter((e) =>
      e.kind === kind && e.geometry &&
      e.geometry.y + e.geometry.h / 2 >= band.geometry.y &&
      e.geometry.y + e.geometry.h / 2 <= band.geometry.y + band.geometry.h);

    const written = inBand("event");
    if (!written.length) continue;                      // a purely foreign band is the shape we want

    for (const foreign of inBand("external")) {
      if (foreign.ingested) {
        push("info", "external-ingested",
          `${foreign.label} is declared ingested="true": we append this foreign event into the "${band.label}" band ourselves. A claim on record — the other system's schema then lives in our append-only history for ever.`,
          foreign.id);
        continue;
      }
      push("warn", "external-in-written-band",
        `${foreign.label} is foreign but is drawn in the "${band.label}" band, which also holds ${
          written.map((e) => e.label).join(", ")} — events we write. That says another system's event lands ` +
        `in a stream of ours, which can only happen if something of ours appends it. Give the source system ` +
        `its own band (it needs no identity=, because we never start those streams), or declare ` +
        `ingested="true" on ${foreign.label} to put the choice on the record.`,
        foreign.id);
    }
  }

  // What identifies ONE stream of this band. Marten keys a stream, and until this exists a
  // generator has nothing to append to — it is the last thing the model was silent about before
  // code, and the silence was invisible because every attribute rule passed.
  //
  // Only bands we WRITE need it. A band holding nothing but imports or foreign events is exempt:
  // we never start those streams, we only project from them.
  for (const band of ir.swimlanes) {
    const owned = ir.elements.filter((e) =>
      e.kind === "event" && e.geometry &&
      e.geometry.y + e.geometry.h / 2 >= band.geometry.y &&
      e.geometry.y + e.geometry.h / 2 <= band.geometry.y + band.geometry.h);
    if (!owned.length) continue;
    if (!band.identity.length) {
      push("error", "band-needs-identity",
        `the "${band.label}" band holds ${owned.length} event(s) we write but declares no identity=. ` +
        `Nothing says what one stream of ${band.streams.join("/")} is keyed by, so nothing can append to it. ` +
        `Candidates carried by every one of its events: ${
          owned.map((e) => e.fields.map((f) => f.name))
            .reduce((a, b) => a.filter((n) => b.includes(n)))
            .join(", ") || "(none — the events share no field)"}.`,
        band.id);
      continue;
    }
    for (const key of band.identity) {
      const missing = owned.filter((e) => !e.fields.some((f) => f.name === key));
      if (missing.length) {
        push("error", "identity-not-on-every-event",
          `the "${band.label}" band is identified by "${key}", but ${
            missing.map((e) => e.label).join(", ")} do not carry it. An event that cannot say which stream it belongs to cannot be appended.`,
          missing[0].id);
      }
    }
  }

  for (const e of ir.elements) {
    if (e.kind !== "command") continue;
    const emitted = e.downstream.map((id) => byId.get(id))
      .filter((x) => x && (x.kind === "event" || x.kind === "external"));
    const streams = [...new Set(emitted.map((x) => x.aggregate).filter(Boolean))];
    if (streams.length > 1) {
      push("error", "command-crosses-swimlane",
        `${e.label} emits events in ${streams.length} streams (${streams.join(", ")}). A Command must never touch more than one — that is a transactional boundary, and two effects that must be atomic are one aggregate, not two.`,
        e.id);
    }
  }
  return d;
}

// --- screens: identity, and a wireframe the checker can actually see -------------------------
//
// Two separate problems, both invisible before this.
//
// 1. A screen had no identity. It was a repeated LABEL — "Timesheet" is three cells in booking,
//    with displays= hand-copied between them and nothing comparing the copies. Exactly the bug
//    the slice cell fixed for slices. screen="timesheet" is the slug, and what it buys is:
//
//      displays= must AGREE across cells sharing a slug — it is a property of the screen
//      inputs=   may DIFFER — the same Timesheet offers book, correct and remove in three slices
//
//    That asymmetry is load-bearing, not a convenience: "there may be only one HoursBooked per
//    day+project, so booking again is a Correction" is a domain fact about affordances, and it is
//    the reason one screen legitimately has three different action buttons.
//
// 2. A wireframe drawn as a picture earns nothing. The book does draw wireframes, and they are
//    sketch-level — but a grey box the tool cannot read will drift from displays= silently. So
//    every element of a wireframe is a cell that DECLARES what it shows: em="field" binds="hours",
//    em="action" command="BookHours". Then the design and the model are checked against each other
//    in both directions, which is the same trick displays= itself plays on read models.
//
// Wireframes are optional. A model mid-session has screens and no wireframe, and nagging about
// that would punish following the method in order — so field-not-drawn only fires once a screen
// has started to be drawn.

function screenRules(ir) {
  const d = [];
  const push = (severity, rule, message, at) => d.push({ family: "screen", severity, rule, message, at });
  const screens = ir.elements.filter((e) => e.kind === "screen");
  if (!screens.length) return d;

  // --- 1. identity
  const bySlug = new Map();
  for (const s of screens) {
    if (!s.screen) {
      push("warn", "screen-needs-slug",
        `${s.label} declares no screen=. Without it nothing knows this is the same screen as the other cells labelled "${s.label}", and their displays= can drift apart unnoticed.`, s.id);
      continue;
    }
    if (!bySlug.has(s.screen)) bySlug.set(s.screen, []);
    bySlug.get(s.screen).push(s);
  }
  for (const [slug, cells] of bySlug) {
    const key = (e) => e.displays.map((f) => f.name).sort().join(", ");
    const first = cells[0];
    for (const c of cells.slice(1)) {
      if (key(c) !== key(first)) {
        push("error", "screen-displays-disagree",
          `screen="${slug}" is drawn in ${cells.length} slices, but ${c.label} (${c.slice}) displays ${key(c) || "nothing"} while ${first.label} (${first.slice}) displays ${key(first) || "nothing"}. What a screen shows is a property of the screen — if these really differ, they are two screens.`,
          c.id);
      }
    }
    const labels = [...new Set(cells.map((c) => c.label))];
    if (labels.length > 1) {
      push("warn", "screen-label-varies",
        `screen="${slug}" is drawn with ${labels.length} different labels (${labels.join(", ")}). One screen, one name.`, cells[1].id);
    }
  }

  // --- 2. the wireframe
  const parts = ir.elements.filter((e) => e.kind === "field" || e.kind === "action" || e.kind === "chrome");
  const inside = (outer, g) =>
    outer.geometry && g &&
    g.x + g.w / 2 >= outer.geometry.x && g.x + g.w / 2 <= outer.geometry.x + outer.geometry.w &&
    g.y + g.h / 2 >= outer.geometry.y && g.y + g.h / 2 <= outer.geometry.y + outer.geometry.h;

  const drawn = new Map();   // screen id -> bound names present
  for (const p of parts) {
    const host = screens.find((s) => inside(s, p.geometry));
    if (!host) {
      push("error", "wireframe-orphan",
        `${p.label || p.id} (${p.kind}) is not drawn inside any screen, so there is no screen for it to be part of.`, p.id);
      continue;
    }
    if (!drawn.has(host.id)) drawn.set(host.id, new Set());

    if (p.kind === "field") {
      if (!p.binds) {
        push("error", "field-binds-nothing",
          `a field on ${host.label} declares no binds=. A wireframe element the checker cannot read is a picture, and will drift from displays= silently.`, p.id);
        continue;
      }
      const known = [...host.displays, ...host.inputs].map((f) => f.name);
      if (!known.includes(p.binds)) {
        push("error", "field-unbound",
          `${host.label} draws a field bound to "${p.binds}", which is neither displayed nor typed on that screen (${known.join(", ") || "nothing declared"}). Either the screen needs it — and a View has to supply it — or the design is showing data the system cannot provide.`, p.id);
      } else {
        drawn.get(host.id).add(p.binds);
      }
    }

    if (p.kind === "action") {
      if (!p.command) {
        push("warn", "action-names-no-command",
          `an action on ${host.label} declares no command=. The affordance is the whole reason one screen appears in several slices.`, p.id);
        continue;
      }
      const issued = ir.elements.filter((e) => e.kind === "command" && host.downstream.includes(e.id));
      if (!issued.some((c) => c.label === p.command)) {
        push("error", "action-unknown-command",
          `${host.label} draws an action issuing "${p.command}", but this cell triggers ${issued.map((c) => c.label).join(", ") || "no command at all"}. The button and the arrow disagree.`, p.id);
      }
    }
  }

  // The other direction: a screen that has been drawn must draw everything it claims to show.
  for (const s of screens) {
    const has = drawn.get(s.id);
    if (!has) continue;                       // not drawn yet — see the note above
    for (const f of [...s.displays, ...s.inputs]) {
      if (!has.has(f.name)) {
        push("warn", "field-not-drawn",
          `${s.label} declares ${f.name} but the wireframe does not show it. Either draw it, or drop it from displays=/inputs= — an attribute nothing displays makes its View over-specified.`, s.id);
      }
    }
  }
  return d;
}

// --- system: many small models, and the only thing allowed to cross between them -------------
//
// "It is perfectly fine to have more than one model on a board. In fact, this is the rule rather
// than the exception for me. I prefer having many smaller models over one large model… I aim to
// capture one business context in each model, so I can read it from left to right without any
// visual interruptions." — Understanding EventSourcing, ch. 18
//
// A folder is a system; each .drawio in it is one business context. The rule that keeps them
// independent is the one ch. 15 gives for crossing a boundary at all: you never let another model
// rebuild your state from your internals. So a model's ONLY public surface is an event marked
// public="true", and a consumer draws it as a yellow external carrying from="<context>".
//
// That is what makes the cross-model check possible. Within a single model an external event is
// terminal by construction — "we have neither control over it nor knowledge of what produced it"
// — and completeness() can only report it. Across a system the producer IS in the folder, so the
// import resolves, and an event nobody publishes becomes an error instead of a note.

const SIZE_BUDGET = 3200;   // px. The book's criterion is "read it left to right without visual
                            // interruptions"; ours is the operational form of the same thing —
                            // if you need tools/crop.mjs to look at it, the model is too big.

function systemRules(models) {
  const d = [];
  const push = (severity, rule, message, model, at) =>
    d.push({ family: "system", severity, rule, message, model, at });

  const contextOf = (m) => m.ir.model?.context ?? m.name;
  const byContext = new Map(models.map((m) => [contextOf(m), m]));

  // Every event another model is allowed to consume, and every import wanting one.
  const published = new Map();     // context -> label -> element
  for (const m of models) {
    const pub = new Map();
    for (const e of m.ir.elements) if (e.kind === "event" && e.isPublic) pub.set(e.label, e);
    published.set(contextOf(m), pub);
  }
  const consumed = new Set();      // `${context}/${label}` actually imported by someone

  for (const m of models) {
    const ctx = contextOf(m);

    if (!m.ir.model) {
      push("warn", "model-needs-cell",
        `${m.name} has no model cell, so it has no identity of its own and nothing states which business context it is.`, ctx);
    } else {
      if (m.ir.model.duplicated) {
        push("error", "model-cell-duplicated", `${m.name} has more than one model cell. A model is one business context.`, ctx, m.ir.model.id);
      }
      if (m.ir.model.context && m.ir.model.context !== m.name) {
        push("warn", "model-context-mismatch",
          `${m.name}.drawio declares context="${m.ir.model.context}". The file name is the context's name everywhere else, so make them agree.`, ctx, m.ir.model.id);
      }
    }

    if (m.ir.width > SIZE_BUDGET) {
      push("warn", "model-too-wide",
        `${ctx} is ${m.ir.width}px wide, over the ${SIZE_BUDGET}px budget. It can no longer be read in one render, which is the point of keeping models small — split it, or move a chapter of slices into their own model.`, ctx);
    }

    for (const e of m.ir.elements) {
      if (e.kind !== "external") continue;

      if (!e.from) {
        if (!e.origin) {
          push("info", "external-unattributed",
            `${e.label} says nothing about where it comes from. from="<context>" if a model in this system publishes it, origin="<system>" if it is genuinely foreign — the first is checked, the second is a claim on record.`, ctx, e.id);
        }
        continue;
      }

      const src = byContext.get(e.from);
      if (!src) {
        push("error", "unknown-source-model",
          `${e.label} declares from="${e.from}", but this system has no such model (${[...byContext.keys()].join(", ")}).`, ctx, e.id);
        continue;
      }
      if (src === m) {
        push("error", "self-import", `${e.label} imports from its own model.`, ctx, e.id);
        continue;
      }
      const pub = published.get(e.from).get(e.label);
      if (!pub) {
        const near = [...published.get(e.from).keys()];
        push("error", "unpublished-import",
          `${e.label} is imported from "${e.from}", which does not publish it. A model's only public surface is an event marked public="true"` +
          (near.length ? ` — ${e.from} publishes ${near.join(", ")}.` : `, and ${e.from} publishes nothing.`), ctx, e.id);
        continue;
      }
      consumed.add(`${e.from}/${e.label}`);

      // The import is a contract. Consuming a field the publisher does not carry is the whole
      // class of bug that only shows up when the two models are read side by side.
      const have = new Map(pub.fields.map((f) => [f.name, f.type]));
      for (const f of e.fields) {
        if (!have.has(f.name)) {
          push("error", "import-field-missing",
            `${ctx} imports ${e.label}.${f.name}, which ${e.from} does not publish on it (${pub.fields.map((x) => x.name).join(", ")}).`, ctx, e.id);
        } else if (have.get(f.name) !== f.type) {
          push("warn", "import-field-type",
            `${ctx} imports ${e.label}.${f.name}:${f.type}, but ${e.from} publishes it as ${have.get(f.name)}.`, ctx, e.id);
        }
      }
    }
  }

  for (const [ctx, pub] of published) {
    for (const [label, e] of pub) {
      if (!consumed.has(`${ctx}/${label}`)) {
        push("info", "unconsumed-export",
          `${ctx} publishes ${label} but no model in this system imports it. Either a consumer is missing, or it does not need to be public.`, ctx, e.id);
      }
    }
  }

  // One event label, one record type. Two cells drawing the same fact with different fields cannot
  // both be generated — MonthClosed is drawn twice in month-closure, once per closing route — and a
  // generator picking whichever cell it met first would emit a type that is wrong for the other.
  // Cheap to check, and it becomes a compile error the moment codegen exists.
  const shapes = new Map();
  for (const m of models) {
    for (const e of m.ir.elements) {
      if (e.kind !== "event" && e.kind !== "external") continue;
      const sig = e.fields.map((f) => `${f.name}:${f.type}${f.nullable ? "?" : ""}`).sort().join(", ");
      if (!shapes.has(e.label)) shapes.set(e.label, []);
      shapes.get(e.label).push({ sig, ctx: contextOf(m), id: e.id, imported: Boolean(e.from) });
    }
  }
  for (const [label, cells] of shapes) {
    const sigs = [...new Set(cells.map((c) => c.sig))];
    if (sigs.length > 1) {
      const odd = cells.find((c) => c.sig === sigs[1]);
      push("error", "event-shape-disagrees",
        `${label} is drawn with ${sigs.length} different field lists, so it cannot become one type. ` +
        cells.map((c) => `${c.ctx}${c.imported ? " (import)" : ""}: ${c.sig || "no fields"}`).join("  |  "),
        odd.ctx, odd.id);
    }
  }

  // A slice is a branch and a ticket, so its name has to mean one thing across the whole system.
  const slices = new Map();
  for (const m of models) {
    for (const s of m.ir.slices) {
      if (!slices.has(s.name)) slices.set(s.name, []);
      slices.get(s.name).push(contextOf(m));
    }
  }
  for (const [name, where] of slices) {
    if (where.length > 1) {
      push("error", "slice-name-collision",
        `slice "${name}" exists in ${where.join(" and ")}. One branch per slice only works if the name is unique across the system.`, where[0]);
    }
  }

  // Two contexts feeding each other is legal — projections read many streams — but it is worth
  // seeing, because it says these two may really be one context, or the boundary is in the
  // wrong place.
  const edges = new Set();
  for (const m of models)
    for (const e of m.ir.elements)
      if (e.kind === "external" && e.from && byContext.has(e.from)) edges.add(`${e.from}>${contextOf(m)}`);
  for (const pair of edges) {
    const [a, b] = pair.split(">");
    if (a < b && edges.has(`${b}>${a}`)) {
      push("info", "context-cycle",
        `${a} and ${b} each consume the other's events. Not illegal — a projection may read many streams — but worth a look: it can mean the boundary is in the wrong place.`, a);
    }
  }

  return d;
}

// --- the system IR: what a generator reads ----------------------------------------------------
//
// Per-model IRs describe three separate pictures. A generator needs one object, and it needs the
// SHARED layer separated from the per-slice layer — because slices are nowhere near independent:
// in hour-booking the Timesheet aggregate is touched by 5 slices, MonthClosure by 6, and every
// event feeds 2-5 views. Generating "a slice" therefore cannot mean generating its events and
// projections; several slices would each write the same file.
//
// So: `shared` is generated once, `slices` can then be generated independently. That is the split
// that makes parallel fan-out possible later, and it costs nothing to compute now.
//
// An event label can appear in several cells — produced in one context, imported as an external in
// others, and twice in one context where two slices emit the same fact. The DEFINITION is the cell
// that is not an import; imports resolve to it.

function buildSystemIr(models, system) {
  const contextOf = (m) => m.ir.model?.context ?? m.name;

  // --- events: one entry per distinct label, however many cells draw it
  const events = new Map();
  const at = (label) => {
    if (!events.has(label)) {
      events.set(label, { label, aggregate: null, fields: [], ownedBy: null, origin: null,
                          importedBy: [], cells: [], isPublic: false });
    }
    return events.get(label);
  };
  for (const m of models) {
    const ctx = contextOf(m);
    for (const e of m.ir.elements) {
      if (e.kind !== "event" && e.kind !== "external") continue;
      const rec = at(e.label);
      rec.cells.push({ id: e.id, context: ctx, slice: e.slice });
      if (e.kind === "external" && e.from) { rec.importedBy.push(ctx); continue; }
      // A definition: either our own event, or a foreign one whose contract we still must model.
      rec.aggregate ??= e.aggregate;
      rec.isPublic ||= e.isPublic;
      if (e.kind === "event") rec.ownedBy ??= ctx; else rec.origin ??= e.origin ?? "unknown";
      if (!rec.fields.length) rec.fields = e.fields;
    }
  }

  // --- aggregates: the transactional boundary, and every command that writes to it
  const aggregates = new Map();
  // identity comes off the swimlane that declares the stream, so a generator knows the stream key.
  const identityOf = new Map();
  for (const m of models)
    for (const b of m.ir.swimlanes)
      if (b.identity.length) for (const s of b.streams) identityOf.set(s, b.identity);

  for (const rec of events.values()) {
    if (!rec.aggregate) continue;
    if (!aggregates.has(rec.aggregate)) {
      aggregates.set(rec.aggregate, { name: rec.aggregate, ownedBy: rec.ownedBy,
                                      identity: identityOf.get(rec.aggregate) ?? [], events: [], commands: [] });
    }
    const a = aggregates.get(rec.aggregate);
    a.ownedBy ??= rec.ownedBy;
    if (rec.ownedBy) a.events.push(rec.label);
  }
  for (const m of models) {
    const ctx = contextOf(m);
    const byId = new Map(m.ir.elements.map((e) => [e.id, e]));
    for (const c of m.ir.elements.filter((e) => e.kind === "command")) {
      const emits = c.downstream.map((id) => byId.get(id)).filter((x) => x && x.kind === "event");
      const agg = c.aggregate ?? emits[0]?.aggregate;
      if (!agg || !aggregates.has(agg)) continue;
      aggregates.get(agg).commands.push({
        label: c.label, context: ctx, slice: c.slice, fields: c.fields,
        terminal: c.terminal, mappings: c.mappings, emits: emits.map((x) => x.label),
      });
    }
  }

  // --- views: fed by events from anywhere, which is why they are shared and not per-slice
  const views = [];
  for (const m of models) {
    const ctx = contextOf(m);
    const byId = new Map(m.ir.elements.map((e) => [e.id, e]));
    for (const v of m.ir.elements.filter((e) => e.kind === "readmodel")) {
      views.push({
        label: v.label, context: ctx, slice: v.slice, fields: v.fields,
        // The shape of any repeated group the fields reference, so a generator can emit the child type.
        children: v.children ?? {},
        // What one ROW of this view is. Undeclared for most views, which is a real gap — a
        // projection cannot group events without it. See OPEN-QUESTIONS.md.
        identity: (v.identity ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        derived: v.derived, mappings: v.mappings,
        from: [...new Set(v.upstream.map((id) => byId.get(id)?.label).filter(Boolean))],
        // A todo-list View is the thing an automation works through, and it needs the tick-off
        // edge to be understood as completion rather than supply.
        todoFor: m.ir.elements.filter((a) => a.kind === "automation" && a.upstream.includes(v.id))
          .map((a) => a.label),
      });
    }
  }

  // --- screens: keyed by SLUG, because one page serves every slice the screen appears in
  const screens = new Map();
  for (const m of models) {
    const ctx = contextOf(m);
    const byId = new Map(m.ir.elements.map((e) => [e.id, e]));
    for (const s of m.ir.elements.filter((e) => e.kind === "screen")) {
      const slug = s.screen ?? s.label;
      if (!screens.has(slug)) {
        // Project-relative, and with no <system> level: the styled page for a screen is found by
        // convention at designs/<slug>.html, never by an attribute on a cell.
        screens.set(slug, { slug, label: s.label, displays: s.displays, inputs: [], commands: [],
                            contexts: [], slices: [], design: `designs/${slug}.html` });
      }
      const rec = screens.get(slug);
      for (const f of s.inputs) if (!rec.inputs.some((x) => x.name === f.name)) rec.inputs.push(f);
      for (const d of s.downstream) {
        const c = byId.get(d);
        if (c?.kind === "command" && !rec.commands.includes(c.label)) rec.commands.push(c.label);
      }
      if (!rec.contexts.includes(ctx)) rec.contexts.push(ctx);
      rec.slices.push({ context: ctx, slice: s.slice, inputs: s.inputs.map((f) => f.name) });
    }
  }

  // --- slices: the unit of work, and of parallelism once `shared` exists
  const slices = [];
  for (const m of models) {
    const ctx = contextOf(m);
    const byId = new Map(m.ir.elements.map((e) => [e.id, e]));
    const cell = (id) => byId.get(id);
    for (const s of m.ir.slices) {
      const scr = s.screens.map(cell).filter(Boolean)[0];
      slices.push({
        context: ctx, name: s.name, pattern: s.pattern, status: s.status, kind: s.kind,
        owner: m.ir.sliceCells.find((c) => c.slice === s.name)?.owner ?? null,
        owners: (m.ir.sliceCells.find((c) => c.slice === s.name)?.owners ?? "")
          .split(",").map((x) => x.trim()).filter(Boolean),
        screen: scr ? (scr.screen ?? scr.label) : null,
        commands: s.commands.map(cell).filter(Boolean).map((c) => c.label),
        emits: s.events.map(cell).filter(Boolean).filter((e) => e.kind === "event").map((e) => e.label),
        imports: s.events.map(cell).filter(Boolean).filter((e) => e.kind === "external").map((e) => e.label),
        views: s.readModels.map(cell).filter(Boolean).map((v) => v.label),
        automations: s.automations.map(cell).filter(Boolean).map((a) => a.label),
        gwts: s.gwts,
        // Nothing to generate from a column that only lands other people's events.
        generates: s.pattern !== "upstream",
      });
    }
  }

  return {
    system,
    generatedAt: null,      // stamped by the caller; keeping it out makes the IR diffable
    models: models.map((m) => ({ context: contextOf(m), source: m.ir.source, width: m.ir.width,
                                 slices: m.ir.slices.length })),
    shared: {
      events: [...events.values()].sort((a, b) => a.label.localeCompare(b.label)),
      aggregates: [...aggregates.values()].sort((a, b) => a.name.localeCompare(b.name)),
      views: views.sort((a, b) => a.label.localeCompare(b.label)),
      screens: [...screens.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    },
    slices: slices.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// --- context map: what a Miro board gives free, and a folder does not ------------------------
//
// Generated from the actual publish/import edges, never hand-edited, so it cannot drift.

function contextMap(models, system) {
  const contextOf = (m) => m.ir.model?.context ?? m.name;
  const order = models.map(contextOf);
  const links = new Map();
  for (const m of models)
    for (const e of m.ir.elements)
      if (e.kind === "external" && e.from) {
        const k = `${e.from}>${contextOf(m)}`;
        if (!links.has(k)) links.set(k, []);
        links.get(k).push(e.label);
      }

  const W = 300, H = 120, GAP = 300, MID = 420;
  const at = (c) => 60 + order.indexOf(c) * (W + GAP);
  const forward = [...links.keys()].filter((k) => order.indexOf(k.split(">")[1]) > order.indexOf(k.split(">")[0]));
  const back = [...links.keys()].filter((k) => !forward.includes(k));
  const top = MID - H / 2 - 40 - 46 * forward.length;
  const bottom = MID + H / 2 + 40 + 46 * back.length;

  const cells = order.map((c) => {
    const m = models.find((x) => contextOf(x) === c);
    const own = m.ir.elements.filter((e) => e.kind === "event" && !e.isPublic).length;
    const pub = m.ir.elements.filter((e) => e.kind === "event" && e.isPublic).length;
    return `        <object id="ctx-${c}" label="${c}&#10;&#10;${m.ir.slices.length} slices · ${m.ir.width}px&#10;${own} internal + ${pub} public events" em="model" context="${c}">
          <mxCell style="rounded=0;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontSize=14;fontStyle=1;verticalAlign=middle;" vertex="1" parent="1">
            <mxGeometry x="${at(c)}" y="${MID - H / 2}" width="${W}" height="${H}" as="geometry" />
          </mxCell>
        </object>`;
  });

  // Label the horizontal run explicitly rather than letting draw.io drop the edge label on
  // whichever segment happens to be the midpoint — on an orthogonal detour that is the vertical
  // one, and the list ends up hanging in space beside the boxes.
  const link = (k, i, isBack) => {
    const [from, to] = k.split(">");
    const labels = links.get(k);
    const y = isBack ? bottom - 46 * i : top + 46 * i;
    const x1 = at(from) + W / 2, x2 = at(to) + W / 2;
    return [
      `        <mxCell id="map-${from}-${to}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#b85450;strokeWidth=2;exitX=0.5;exitY=${isBack ? 1 : 0};exitDx=0;exitDy=0;entryX=0.5;entryY=${isBack ? 1 : 0};entryDx=0;entryDy=0;" edge="1" parent="1" source="ctx-${from}" target="ctx-${to}">
          <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="${x1}" y="${y}" /><mxPoint x="${x2}" y="${y}" /></Array></mxGeometry>
        </mxCell>`,
      `        <mxCell id="map-lbl-${from}-${to}" value="${labels.map(escapeXml).join("&#10;")}" style="text;html=1;align=center;verticalAlign=${isBack ? "top" : "bottom"};fontSize=11;fontColor=#b85450;" vertex="1" parent="1">
          <mxGeometry x="${Math.min(x1, x2)}" y="${isBack ? y + 4 : y - 4 - 18 * labels.length}" width="${Math.abs(x2 - x1)}" height="${18 * labels.length}" as="geometry" />
        </mxCell>`,
    ].join("\n");
  };
  forward.forEach((k, i) => cells.push(link(k, i, false)));
  back.forEach((k, i) => cells.push(link(k, i, true)));

  const w = at(order[order.length - 1]) + W + 60;
  return `<mxfile host="Electron" agent="Claude" type="device">
  <diagram name="${system} — context map" id="context-map">
    <mxGraphModel dx="1420" dy="1100" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${w}" pageHeight="${bottom + 120}" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <object id="map-title" label="&lt;b&gt;${system}&lt;/b&gt; — generated context map. Do not edit: run &lt;b&gt;node tools/model.mjs map&lt;/b&gt;. An arrow is an event one model publishes and another imports; that is the only thing allowed to cross." em="note">
          <mxCell style="text;html=1;align=left;verticalAlign=middle;fontSize=13;fontColor=#888888;" vertex="1" parent="1">
            <mxGeometry x="60" y="30" width="${w - 120}" height="30" as="geometry" />
          </mxCell>
        </object>
${cells.join("\n")}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
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

// The target is optional. One kit copy serves one project, so "the models" is never ambiguous —
// defaulting to <project>/diagrams/ removes the commonest way to get this wrong, which is typing a
// path that resolves relative to the kit instead of the project.
const argvAll = process.argv.slice(2);
const cmd = argvAll[0];
const explicit = argvAll[1] && !argvAll[1].startsWith("--") ? argvAll[1] : null;
const rest = explicit ? argvAll.slice(2) : argvAll.slice(1);
const target = explicit ?? (tryProjectRoot(rest) ? join(tryProjectRoot(rest).root, "diagrams") : null);

if (!cmd || !target) {
  console.error("usage: node tools/model.mjs <compile|validate|mark|clear|map> [file.drawio | dir/] [--json] [--out f] [--project p]\n" +
    "       the target defaults to <project>/diagrams/ — configure it with: node tools/project.mjs init --project <path>");
  process.exit(2);
}
const file = resolve(target);
if (!existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}

// A folder is a system: every .drawio in it is one business context of that system. Files
// starting with "_" are generated (the context map), and are never validated as models.
const isSystem = statSync(file).isDirectory();
const systemFiles = () =>
  readdirSync(file).filter((f) => f.endsWith(".drawio") && !f.startsWith("_")).sort()
    .map((f) => ({ name: basename(f, ".drawio"), path: join(file, f) }));

function runOne(f) {
  const ir = buildIr(f);
  // sliceRules runs last and reads the others: a slice cannot claim to be past in-design while
  // its own cells still carry errors.
  const core = [...grammar(ir), ...completeness(ir), ...gwtRules(ir), ...swimlaneRules(ir),
                ...flowRules(ir), ...conwayRules(ir), ...screenRules(ir)];
  return { ir, findings: [...core, ...sliceRules(ir, core)] };
}

if (isSystem) {
  const models = systemFiles().map((m) => ({ ...m, ...runOne(m.path) }));
  if (!models.length) {
    console.error(`${target}: no models found.`);
    process.exit(1);
  }
  // The <system> folder level is gone: one kit copy serves one project, and the project IS the
  // system. So a model cell's system= still wins, the project name is the fallback, and
  // basename(dir) — which would now say "diagrams" — is only the last resort for a bare folder
  // validated with no project configured, such as the cart fixture.
  const system = models.find((m) => m.ir.model?.system)?.ir.model.system
    ?? projectName(rest) ?? basename(file);

  if (cmd === "map") {
    const out = join(file, "_context-map.drawio");
    writeFileSync(out, contextMap(models, system), "utf8");
    console.log(`${out}  (${models.length} models)`);
    process.exit(0);
  }
  if (cmd === "compile") {
    const ir = buildSystemIr(models, system);
    const json = JSON.stringify(ir, null, 2);
    const i = rest.indexOf("--out");
    // The IR is derived output and belongs to the project. With no project and no --out there is
    // nowhere honest to put it: falling back to a kit-local build/ would drop generated output into
    // the kit, which is the exact failure the project split exists to prevent. --stdout and --out
    // both still work with no project, which is what the fixtures and design.mjs use.
    const out = i >= 0 && rest[i + 1]
      ? resolve(rest[i + 1])
      : join(projectRoot(rest), "build", `${system}.ir.json`);
    if (i >= 0 || !rest.includes("--stdout")) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json + "\n", "utf8");
      console.log(`${ir.shared.events.length} event(s), ${ir.shared.aggregates.length} aggregate(s), ` +
        `${ir.shared.views.length} view(s), ${ir.shared.screens.length} screen(s), ` +
        `${ir.slices.filter((s) => s.generates).length}/${ir.slices.length} generating slice(s) -> ${out}`);
    } else console.log(json);
    process.exit(0);
  }
  if (cmd !== "validate") {
    console.error(`${cmd} takes a single file, not a system folder.`);
    process.exit(2);
  }

  const sysFindings = systemRules(models);
  const all = [...models.flatMap((m) => m.findings.map((x) => ({ ...x, model: m.name }))), ...sysFindings];
  const errors = all.filter((f) => f.severity === "error");

  if (rest.includes("--json")) {
    console.log(JSON.stringify({ system, models: models.map((m) => m.name), findings: all }, null, 2));
    process.exit(errors.length ? 1 : 0);
  }
  const rank = { error: 0, warn: 1, info: 2 };
  const icon = { error: "ERROR", warn: " WARN", info: " INFO" };
  const show = (fs) => {
    fs.sort((a, b) => rank[a.severity] - rank[b.severity] || a.family.localeCompare(b.family));
    for (const f of fs) console.log(`  ${icon[f.severity]}  [${f.family}/${f.rule}] ${f.message}`);
  };
  console.log(`system "${system}" — ${models.length} model(s)\n`);
  for (const m of models) {
    const e = m.findings.filter((f) => f.severity === "error").length;
    console.log(`${m.name} — ${m.ir.slices.length} slice(s), ${m.ir.elements.length} element(s), ${m.ir.width}px` +
      `${e ? `  ${e} ERROR(S)` : ""}`);
    show(m.findings);
    console.log("");
  }
  console.log(`across the system`);
  show(sysFindings);
  console.log(
    `\n${errors.length} error(s), ${all.filter((f) => f.severity === "warn").length} warning(s), ` +
      `${all.filter((f) => f.severity === "info").length} note(s)   ` +
      `${models.length} models / ${models.reduce((n, m) => n + m.ir.slices.length, 0)} slices / ` +
      `${models.reduce((n, m) => n + m.ir.elements.length, 0)} elements`
  );
  process.exit(errors.length ? 1 : 0);
}

if (cmd === "clear") {
  const xml = readFileSync(file, "utf8");
  const out = stripMarkers(xml);
  writeFileSync(file, out, "utf8");
  console.log(out === xml ? "no markers to remove." : "markers removed.");
  process.exit(0);
}

const { ir, findings } = runOne(file);
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
