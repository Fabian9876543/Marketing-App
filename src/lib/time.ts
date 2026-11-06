import { DateTime } from "luxon";

/** Datum/Zeit in der Zeitzone der Einstellungen anzeigen, z. B. „Mo., 10.11. · 09:00“. */
export function formatDateTime(d: Date | number, tz: string): string {
  const dt = DateTime.fromMillis(+d, { zone: tz }).setLocale("de");
  return `${dt.toFormat("ccc, dd.LL.")} · ${dt.toFormat("HH:mm")}`;
}

export function formatTime(d: Date | number, tz: string): string {
  return DateTime.fromMillis(+d, { zone: tz }).toFormat("HH:mm");
}

export function formatDate(d: Date | number, tz: string): string {
  return DateTime.fromMillis(+d, { zone: tz }).setLocale("de").toFormat("ccc, dd.LL.yyyy");
}

/** Wert für <input type="datetime-local"> in der gegebenen Zeitzone. */
export function toLocalInput(d: Date | number, tz: string): string {
  return DateTime.fromMillis(+d, { zone: tz }).toFormat("yyyy-LL-dd'T'HH:mm");
}

/** Liest einen <input type="datetime-local">-Wert als Ortszeit der gegebenen Zeitzone. */
export function fromLocalInput(value: string, tz: string): Date {
  const dt = DateTime.fromFormat(value, "yyyy-LL-dd'T'HH:mm", { zone: tz });
  if (!dt.isValid) throw new Error(`Ungültige Zeitangabe: ${value}`);
  return dt.toJSDate();
}

/** „vor 3 Min.“ / „in 2 Std.“ */
export function relative(d: Date | number, now = Date.now()): string {
  return DateTime.fromMillis(+d).setLocale("de").toRelative({ base: DateTime.fromMillis(now) }) ?? "";
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}
