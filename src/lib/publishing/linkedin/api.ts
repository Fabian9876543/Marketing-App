import { linkedinConfig } from "../../env";
import { readJson } from "../oauth";
import { PublishError } from "../types";

type LiErrorBody = { message?: string; status?: number; serviceErrorCode?: number; code?: string };

/** HTTP-Fehler der LinkedIn-API in eine verständliche PublishError übersetzen. */
export function toLinkedInError(status: number, body: LiErrorBody, context: string): PublishError {
  const text = `${context}: ${body.message ?? body.code ?? `HTTP ${status}`}`;
  if (status === 401) return new PublishError("auth", "LinkedIn-Anmeldung abgelaufen – bitte unter „Konten“ neu verbinden (LinkedIn verlangt das alle 60 Tage).");
  if (status === 403) return new PublishError("auth", `LinkedIn verweigert den Zugriff – fehlen Rechte? Bitte neu verbinden. (${body.message ?? ""})`);
  if (status === 426) {
    return new PublishError("fatal", `Die LinkedIn-API-Version ${linkedinConfig().version} wird nicht mehr unterstützt – LINKEDIN_API_VERSION in der .env aktualisieren.`);
  }
  if (status === 429 || status >= 500) return new PublishError("retryable", text);
  return new PublishError("fatal", text);
}

/** Aufruf der versionierten LinkedIn-REST-API (https://api.linkedin.com/rest/…). */
export async function li<T>(
  method: "GET" | "POST",
  path: string,
  token: string,
  context: string,
  body?: unknown,
): Promise<{ data: T; headers: Headers }> {
  const c = linkedinConfig();
  const res = await fetch(`${c.apiBase}/rest/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": c.version,
      "X-Restli-Protocol-Version": "2.0.0",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await readJson<T & LiErrorBody>(res);
  if (!res.ok) throw toLinkedInError(res.status, data, context);
  return { data, headers: res.headers };
}

/** Von LinkedIn reservierte Zeichen im „Little Text“-Format – müssen mit \ geschützt werden. */
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const escapeLittle = (s: string) => s.replace(RESERVED, (c) => `\\${c}`);

/**
 * Wandelt normalen Text in LinkedIns „Little Text“-Format:
 * Sonderzeichen werden geschützt (sonst schneidet LinkedIn den Text z. B. an Klammern ab),
 * Hashtags werden zu {hashtag|\#|Tag}, damit sie anklickbar bleiben.
 */
export function toLittleText(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    out += escapeLittle(text.slice(last, m.index));
    out += `{hashtag|\\#|${escapeLittle(m[1])}}`;
    last = m.index! + m[0].length;
  }
  return out + escapeLittle(text.slice(last));
}

