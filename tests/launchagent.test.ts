import { describe, expect, it } from "vitest";
import { LABELS, agentDefinitions, buildPlist } from "../scripts/launchagent";

describe("LaunchAgent", () => {
  it("erzeugt Plists für Web-App und Worker mit Neustart nach Absturz", () => {
    const defs = agentDefinitions("/Users/fabian/Marketing-App", "/opt/homebrew/bin/node", "/Users/fabian/Library/Logs");
    expect(defs.map((d) => d.label)).toEqual([LABELS.web, LABELS.worker]);
    const web = buildPlist(defs[0]);
    expect(web).toContain("<string>de.marketing-studio.web</string>");
    expect(web).toContain("<string>127.0.0.1</string>");
    expect(web).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(web).toContain("/opt/homebrew/bin");
    const worker = buildPlist(defs[1]);
    expect(worker).toContain("/Users/fabian/Marketing-App/worker/index.ts");
  });

  it("maskiert Sonderzeichen", () => {
    const xml = buildPlist({ label: "a&b", args: ["<x>"], cwd: "/", logFile: "/l", env: {} });
    expect(xml).toContain("a&amp;b");
    expect(xml).toContain("&lt;x&gt;");
  });
});
