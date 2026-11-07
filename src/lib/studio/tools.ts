import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { listAccounts, PLATFORM_LABEL } from "../accounts";
import { importBacklog } from "../backlog";
import type { DB } from "../db/client";
import { contents, PLATFORMS, type Platform, type Project } from "../db/schema";
import { describePlan, planIntoNextSlot } from "../autoplan";
import { contentUsage, takenTimes } from "../posts";
import { getSettings } from "../settings";
import { listSlots, slotOccurrences } from "../slots";
import { formatDateTime } from "../time";

/**
 * Werkzeuge, die Claude Code im Studio über den MCP-Server „studio“ aufrufen kann.
 * Bewusst klein gehalten: lesen, einlesen, zur Freigabe einplanen – nie veröffentlichen.
 */

export function briefingTool(project: Project): string {
  const file = path.join(project.folder, "PROJEKT.md");
  const md = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# ${project.name}\n\n(Noch kein Briefing)`;
  return `${md}\n\n---\nProjektordner: ${project.folder}\nBacklog: ${path.join(project.folder, "backlog")}\nReferenzen: ${path.join(project.folder, "referenzen")}\nVorlage: ${path.join(project.folder, "studio")}`;
}

export function backlogTool(db: DB, project: Project): string {
  const rows = db.select().from(contents).where(and(eq(contents.projectId, project.id), eq(contents.available, true))).all();
  if (!rows.length) return "Das Backlog ist leer.";
  const usage = contentUsage(db, project.id);
  return rows
    .map((c) => {
      const u = usage.get(c.id);
      const status = u?.published ? `${u.published}× veröffentlicht` : u?.planned ? `${u.planned}× geplant` : "noch nicht geplant";
      const dur = c.durationSec ? `${Math.round(c.durationSec)} s` : "?";
      return `- ${c.slug} – „${c.title}“ (${dur}, ${status})`;
    })
    .join("\n");
}

export function freeSlotsTool(db: DB, project: Project, count = 5): string {
  const tz = getSettings(db).timezone;
  const slots = listSlots(db, project.id);
  if (!slots.filter((s) => s.active).length) return "Für dieses Projekt sind keine Posting-Zeiten angelegt (Projekt → Posting-Zeiten).";
  const taken = new Set(takenTimes(db, new Date(), project.id).map((d) => Math.round(d.getTime() / 60_000)));
  const free = slotOccurrences(slots, new Date(Date.now() + 5 * 60_000), new Date(Date.now() + 60 * 86_400_000), tz)
    .filter((d) => !taken.has(Math.round(d.getTime() / 60_000)))
    .slice(0, count);
  return free.length ? free.map((d) => `- ${formatDateTime(d, tz)} (${d.toISOString()})`).join("\n") : "In den nächsten 60 Tagen ist kein Slot frei.";
}

export function accountsTool(db: DB, project: Project): string {
  const accs = listAccounts(db, { projectId: project.id });
  if (!accs.length) return "Für dieses Projekt ist noch kein Konto verbunden.";
  return accs.map((a) => `- ${PLATFORM_LABEL[a.platform]}: ${a.name}${a.status !== "active" ? " (muss neu verbunden werden)" : ""}`).join("\n");
}

export async function importTool(db: DB, project: Project): Promise<string> {
  const r = await importBacklog(db, project);
  const lines = [`${r.added} neu, ${r.updated} aktualisiert${r.missing ? `, ${r.missing} fehlen` : ""}.`];
  for (const e of r.errors) lines.push(`Problem: ${e}`);
  return lines.join("\n");
}

/** Short zur Freigabe einplanen – landet in „Warteschlange → Zur Freigabe“, nie direkt online. */
export async function proposeTool(
  db: DB,
  project: Project,
  input: { slug: string; zeit?: string; plattformen?: string[] },
): Promise<string> {
  await importBacklog(db, project);
  const content = db
    .select()
    .from(contents)
    .where(and(eq(contents.projectId, project.id), eq(contents.slug, input.slug)))
    .get();
  if (!content) throw new Error(`Kein Short „${input.slug}“ im Backlog. Liegt video.mp4 im Ordner backlog/${input.slug}/?`);

  const wanted = (input.plattformen ?? []).map((p) => p.toLowerCase()).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  let at: Date | undefined;
  if (input.zeit && input.zeit !== "naechster_slot") {
    at = new Date(input.zeit);
    if (Number.isNaN(at.getTime())) throw new Error(`Ungültige Zeit: ${input.zeit} (erwartet ISO 8601, z. B. 2026-11-10T09:00:00+01:00)`);
  }
  const r = planIntoNextSlot(db, project, content.id, { createdBy: "agent", platforms: wanted, at });
  if (!r.ok) {
    throw new Error(r.reason === "keine freie Posting-Zeit" ? "Kein freier Slot – gib eine Zeit an (ISO 8601) oder lege Posting-Zeiten an." : `Nicht möglich: ${r.reason}.`);
  }
  const tz = getSettings(db).timezone;
  return `„${content.title}“ ist zur Freigabe eingeplant für ${describePlan(r, tz)}. Veröffentlicht wird erst nach Freigabe in der App.`;
}
