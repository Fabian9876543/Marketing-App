#!/usr/bin/env node
// Nachbau von „claude -p --output-format stream-json“ für Tests.
// Liest den Auftrag von stdin, schreibt Ereignisse wie die echte CLI und legt bei „render“ einen Short ins Backlog.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("9.9.9 (Claude Code, Test)"); process.exit(0); }
if (args.includes("--help")) { console.log("Options:\n  --permission-prompts <target>\n  --strict-mcp-config\n  --session-id <uuid>\n  --resume [value]"); process.exit(0); }
if (process.env.FAKE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd(), envKeys: Object.keys(process.env) }) + "\n");

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const sid = args[args.indexOf("--session-id") + 1] || args[args.indexOf("--resume") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (/nicht angemeldet/.test(prompt)) { process.stderr.write("Invalid API key · Please run /login\n"); process.exit(1); }
out({ type: "system", subtype: "init", session_id: sid, model: "test-modell", tools: ["Bash"] });
out({ type: "assistant", message: { content: [{ type: "text", text: `Verstanden: ${prompt.slice(0, 40)}` }] } });
if (/langsam/.test(prompt)) await sleep(10_000);

if (/^Wochenanalyse/.test(prompt)) {
  // Wie die echte CLI: Werkzeuge des MCP-Servers „studio“ aus --mcp-config aufrufen
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.studio;
  const client = new Client({ name: "fake-claude", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env }, cwd: process.cwd() }));
  let n = 0;
  const call = async (name, input) => {
    const id = `a${++n}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__studio__${name}`, input }] } });
    const r = await client.callTool({ name, arguments: input });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: r.content, is_error: Boolean(r.isError) }] } });
    return r.content.map((c) => c.text).join("\n");
  };
  const stats = await call("statistik", { tage: 90 });
  await call("erkenntnisse", {});
  await call("erkenntnis_vorschlagen", { text: "Hook als Frage in den ersten 2 Sekunden", begruendung: "Die beiden stärksten Posts beginnen mit einer Frage." });
  await client.close();
  const strong = (stats.match(/stark ×/g) ?? []).length;
  out({ type: "assistant", message: { content: [{ type: "text", text: `Wochenanalyse: ${strong} starke Posts. Vorschlag: Hook als Frage. Bitte in der App bestätigen.` }] } });
} else if (/render/i.test(prompt)) {
  const slug = `2026-11-07-test-short-${crypto.randomBytes(2).toString("hex")}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `cd studio && npx remotion render src/index.ts Short ../backlog/${slug}/video.mp4` } }] } });
  const dir = path.join(process.cwd(), "backlog", slug);
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.FAKE_REAL_RENDER) {
    // Echt rendern mit der Vorlage im Projektordner (wie es Claude tun würde)
    const studio = path.join(process.cwd(), "studio");
    if (!fs.existsSync(path.join(studio, "node_modules", "remotion"))) execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: studio, stdio: "ignore" });
    fs.mkdirSync(path.join(studio, "props"), { recursive: true });
    fs.writeFileSync(path.join(studio, "props", `${slug}.json`), JSON.stringify({ scenes: [{ type: "hook", text: "Verpasster Anruf? Nicht mehr.", seconds: 2 }, { type: "dialog", title: "22:14 Uhr", lines: [{ who: "Anrufer", text: "Haben Sie morgen noch einen Termin frei?" }, { who: "Assistent", text: "Ja – 9:30 Uhr passt. Ich trage Sie ein." }], seconds: 4 }, { type: "cta", text: "Rund um die Uhr erreichbar", seconds: 2 }] }));
    const extra = process.env.REMOTION_BROWSER ? [`--browser-executable=${process.env.REMOTION_BROWSER}`] : [];
    execFileSync("npx", ["remotion", "render", "src/index.ts", "Short", path.join(dir, "video.mp4"), `--props=props/${slug}.json`, ...extra], { cwd: studio, stdio: "ignore" });
  } else if (process.env.FAKE_VIDEO) fs.copyFileSync(process.env.FAKE_VIDEO, path.join(dir, "video.mp4"));
  else fs.writeFileSync(path.join(dir, "video.mp4"), crypto.randomBytes(2048));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ title: "Test-Short von Claude", hashtags: ["Test"], aiGenerated: false }));
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Rendered 450/450\n+ video.mp4 1.1 MB", is_error: false }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__studio__backlog_einlesen", input: {} }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "1 neu, 0 aktualisiert." }] }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: `Fertig: backlog/${slug}` }] } });
}

const failed = /fehler/.test(prompt);
out({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, result: failed ? "Etwas ist schiefgelaufen" : "Fertig", session_id: sid, total_cost_usd: 0.0123, duration_ms: 61000, num_turns: 4 });
process.exit(failed ? 1 : 0);
