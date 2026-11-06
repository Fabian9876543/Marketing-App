import { metaConfig } from "../../env";
import { readJson } from "../oauth";
import { PublishError } from "../types";

type GraphErrorBody = { error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string } };

/** Fehler der Meta Graph API in eine verständliche PublishError übersetzen. */
export function toGraphError(status: number, body: GraphErrorBody, context: string): PublishError {
  const e = body.error ?? {};
  const msg = e.error_user_msg || e.message || `HTTP ${status}`;
  const text = `${context}: ${msg}${e.code ? ` (Code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : ""}`;
  if (e.code === 190 || status === 401) {
    return new PublishError("auth", "Instagram-Anmeldung ungültig oder abgelaufen – bitte unter „Konten“ neu verbinden.");
  }
  if (e.code === 9 && e.error_subcode === 2207042) {
    return new PublishError("quota", "Instagram-Tageslimit für API-Posts erreicht – neuer Versuch in einer Stunde.", new Date(Date.now() + 3600_000));
  }
  if (e.code === 10 || (e.code && e.code >= 200 && e.code < 300)) {
    return new PublishError("auth", `Instagram verweigert die Berechtigung – bitte neu verbinden und alle Rechte erlauben. (${msg})`);
  }
  if ([1, 2, 4, 17, 32, 341, 368, 613].includes(e.code ?? -1) || status === 429 || status >= 500) {
    return new PublishError("retryable", text);
  }
  return new PublishError("fatal", text);
}

/** Aufruf der Graph API; wirft PublishError bei Fehlern. */
export async function graph<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  context: string,
): Promise<T> {
  const c = metaConfig();
  const url = new URL(`${c.graphBase}/${c.version}/${path.replace(/^\//, "")}`);
  const init: RequestInit = { method };
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    init.body = new URLSearchParams(params);
  }
  const res = await fetch(url, init);
  const body = await readJson<T & GraphErrorBody>(res);
  if (!res.ok || body.error) throw toGraphError(res.status, body, context);
  return body;
}
