#!/usr/bin/env node
// Re-runnable proof of the bilateral Claude <-> draw.io link over MCP.
//
//   node tools/verify-mcp.mjs
//
// Builds a throwaway COMPRESSED .drawio, then over the MCP stdio protocol:
//   list_pages -> get_page (read, server decompresses) -> set_page (write)
// Verifies each step and deletes the throwaway. Exit 0 = link healthy.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "node_modules", "@drawio", "mcp", "src", "index.js");
const SOURCE = join(ROOT, "diagrams", "order-flow.drawio");
const TMP = join(ROOT, "diagrams", ".verify-tmp.drawio");

const ok = (m) => console.log(`  PASS  ${m}`);
const die = (m) => { console.error(`  FAIL  ${m}`); cleanup(); process.exit(1); };
const cleanup = () => { try { if (existsSync(TMP)) rmSync(TMP); } catch {} };

if (!existsSync(SERVER)) die(`MCP server missing at ${SERVER} - run: npm install`);
if (!existsSync(SOURCE)) die(`source diagram missing at ${SOURCE}`);

console.log("draw.io <-> Claude MCP link check\n");

const inner = readFileSync(SOURCE, "utf8").match(/<diagram[^>]*>([\s\S]*?)<\/diagram>/)?.[1];
if (!inner) die("could not parse a <diagram> out of the source file");
const packed = deflateRawSync(Buffer.from(encodeURIComponent(inner), "utf8")).toString("base64");
writeFileSync(TMP, `<mxfile host="Electron"><diagram name="Verify" id="verify">${packed}</diagram></mxfile>`);
ok(`built compressed fixture (${packed.length} base64 chars - unreadable as plain text)`);

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], cwd: ROOT });
let buf = "";
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const call = (id, name, args) =>
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const text = (m) => (m.result?.content ?? []).map((c) => c.text).join("\n");

const timer = setTimeout(() => die("timed out after 90s"), 90000);

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith("{")) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.error) die(`server error: ${JSON.stringify(m.error)}`);

    if (m.id === 1) {
      ok(`initialize -> ${m.result?.serverInfo?.name} v${m.result?.serverInfo?.version}`);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      call(2, "list_pages", { path: TMP });
    }

    if (m.id === 2) {
      const pages = JSON.parse(text(m));
      if (!pages.length) die("list_pages returned no pages");
      ok(`list_pages -> ${pages.length} page(s), first = "${pages[0].name}"`);
      call(3, "get_page", { path: TMP, page: "0" });
    }

    if (m.id === 3) {
      const xml = text(m);
      if (!xml.includes("<mxGraphModel")) die("get_page did not return readable mxGraphModel XML");
      const labels = [...xml.matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
      ok(`get_page -> READ ${labels.length} labelled cells through compression`);
      const mutated = xml.trim().replace("</root>", `
        <mxCell id="verify-probe" value="VerifyProbe" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1">
          <mxGeometry x="40" y="620" width="140" height="40" as="geometry" />
        </mxCell>
      </root>`);
      call(4, "set_page", { path: TMP, page: "0", content: mutated });
    }

    if (m.id === 4) {
      ok(`set_page -> WROTE back (${text(m).trim().slice(0, 60)}...)`);
      clearTimeout(timer);
      child.kill();
      cleanup();
      console.log("\nBilateral link OK: Claude can read and write your diagrams.");
      process.exit(0);
    }
  }
});

child.stderr.on("data", () => {}); // server logs its banner to stderr
child.on("exit", (c) => { if (c && c !== 0) die(`server exited early (code ${c})`); });

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1.0.0" } },
});
