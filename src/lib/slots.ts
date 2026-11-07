import { and, asc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { DB } from "./db/client";
import { slots, type Slot } from "./db/schema";

export const WEEKDAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export function listSlots(db: DB, projectId: number): Slot[] {
  return db.select().from(slots).where(eq(slots.projectId, projectId)).orderBy(asc(slots.time)).all();
}

export function addSlot(db: DB, projectId: number, time: string, weekdays: number[]): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Uhrzeit im Format HH:MM angeben");
  const days = [...new Set(weekdays)].filter((d) => d >= 1 && d <= 7).sort();
  if (!days.length) throw new Error("Mindestens einen Wochentag wählen");
  db.insert(slots).values({ projectId, time, weekdays: days }).run();
}

export function removeSlot(db: DB, projectId: number, id: number): void {
  db.delete(slots).where(and(eq(slots.id, id), eq(slots.projectId, projectId))).run();
}

export function toggleSlot(db: DB, projectId: number, id: number, active: boolean): void {
  db.update(slots).set({ active }).where(and(eq(slots.id, id), eq(slots.projectId, projectId))).run();
}

/** Alle Slot-Zeitpunkte zwischen `from` und `to` (in UTC), sortiert. */
export function slotOccurrences(list: Slot[], from: Date, to: Date, tz: string): Date[] {
  const out: Date[] = [];
  const active = list.filter((s) => s.active);
  if (!active.length) return out;
  let day = DateTime.fromJSDate(from, { zone: tz }).startOf("day");
  const end = DateTime.fromJSDate(to, { zone: tz });
  while (day <= end) {
    for (const s of active) {
      if (!s.weekdays.includes(day.weekday)) continue;
      const [h, m] = s.time.split(":").map(Number);
      const at = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      // Bei Zeitumstellung kann eine Uhrzeit nicht existieren; Luxon verschiebt sie dann – das ist ok.
      const ms = at.toMillis();
      if (ms >= from.getTime() && ms <= to.getTime()) out.push(new Date(ms));
    }
    day = day.plus({ days: 1 });
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Nächster freier Slot ab `from` (mindestens `leadMinutes` in der Zukunft).
 * Ein Slot ist belegt, wenn dort schon ein (nicht abgesagter) Post liegt.
 */
export function nextFreeSlot(
  list: Slot[],
  taken: Date[],
  from: Date,
  tz: string,
  opts: { leadMinutes?: number; horizonDays?: number } = {},
): Date | null {
  const start = new Date(from.getTime() + (opts.leadMinutes ?? 5) * 60_000);
  const end = new Date(from.getTime() + (opts.horizonDays ?? 90) * 86_400_000);
  const takenSet = new Set(taken.map((d) => Math.round(d.getTime() / 60_000)));
  return slotOccurrences(list, start, end, tz).find((d) => !takenSet.has(Math.round(d.getTime() / 60_000))) ?? null;
}
