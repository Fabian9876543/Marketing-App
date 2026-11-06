import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { upsertAccount } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { oauthStates } from "@/lib/db/schema";
import { logEvent } from "@/lib/events";
import { exchangeCode, fetchMyChannel } from "@/lib/publishing/youtube/oauth";

/** Google leitet nach der Anmeldung hierher zurück. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (params: Record<string, string>) => {
    const target = new URL("/konten", req.url);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return NextResponse.redirect(target, 303);
  };

  const error = url.searchParams.get("error");
  if (error) return back({ fehler: error === "access_denied" ? "Anmeldung abgebrochen" : `Google meldet: ${error}` });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back({ fehler: "Antwort von Google unvollständig" });

  const db = getDb();
  const row = db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.platform, "youtube")))
    .get();
  db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
  if (!row || Date.now() - row.createdAt.getTime() > 15 * 60_000) {
    return back({ fehler: "Anmeldung abgelaufen – bitte noch einmal auf „YouTube verbinden“ klicken" });
  }

  try {
    const tokens = await exchangeCode(code, row.codeVerifier);
    if (!tokens.refreshToken) {
      return back({ fehler: "Google hat kein Refresh-Token geliefert. Entferne den Zugriff unter myaccount.google.com/permissions und verbinde neu." });
    }
    const channel = await fetchMyChannel(tokens.accessToken);
    const account = await upsertAccount(db, {
      platform: "youtube",
      externalId: channel.id,
      name: channel.title,
      handle: channel.handle,
      tokens,
    });
    logEvent(db, "info", "konten", `YouTube-Kanal „${account.name}“ verbunden`);
    return back({ ok: `YouTube-Kanal „${account.name}“ verbunden` });
  } catch (err) {
    logEvent(db, "error", "konten", `YouTube-Verbindung fehlgeschlagen: ${(err as Error).message}`);
    return back({ fehler: `Verbindung fehlgeschlagen: ${(err as Error).message}` });
  }
}
