import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { PLATFORM_LABEL, upsertAccount } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { oauthStates } from "@/lib/db/schema";
import { logEvent } from "@/lib/events";
import { getProject } from "@/lib/projects";
import { oauthProviders } from "@/lib/publishing/registry";
import { getSettings } from "@/lib/settings";

/** Die Plattform leitet nach der Anmeldung hierher zurück. */
export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const url = new URL(req.url);
  const back = (msg: Record<string, string>) => {
    const target = new URL("/konten", req.url);
    for (const [k, v] of Object.entries(msg)) target.searchParams.set(k, v);
    return NextResponse.redirect(target, 303);
  };

  const provider = oauthProviders[platform as keyof typeof oauthProviders];
  if (!provider) return back({ fehler: `Unbekannte Plattform: ${platform}` });
  const label = PLATFORM_LABEL[provider.platform];

  const error = url.searchParams.get("error");
  if (error) {
    const denied = ["access_denied", "user_denied", "user_cancelled_login", "user_cancelled_authorize"].includes(error);
    const detail = url.searchParams.get("error_description") ?? url.searchParams.get("error_reason") ?? error;
    return back({ fehler: denied ? "Anmeldung abgebrochen" : `${label} meldet: ${detail}` });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back({ fehler: `Antwort von ${label} unvollständig` });

  const db = getDb();
  const row = db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.platform, provider.platform)))
    .get();
  db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
  if (!row || Date.now() - row.createdAt.getTime() > 15 * 60_000) {
    return back({ fehler: `Anmeldung abgelaufen – bitte noch einmal auf „${label} verbinden“ klicken` });
  }
  const project = row.projectId ? getProject(db, row.projectId) : undefined;
  if (!project) return back({ fehler: "Das Projekt für diese Anmeldung gibt es nicht mehr" });

  try {
    const found = await provider.connect({ code, codeVerifier: row.codeVerifier, settings: getSettings(db) });
    if (!found.length) throw new Error("Kein passendes Konto gefunden");
    const names: string[] = [];
    for (const acc of found) {
      const saved = await upsertAccount(db, { projectId: project.id, platform: provider.platform, ...acc });
      names.push(saved.name);
    }
    const msg = `${label}: ${names.map((n) => `„${n}“`).join(", ")} mit Projekt „${project.name}“ verbunden`;
    logEvent(db, "info", "konten", msg);
    return back({ ok: msg });
  } catch (err) {
    logEvent(db, "error", "konten", `${label}-Verbindung fehlgeschlagen: ${(err as Error).message}`);
    return back({ fehler: `Verbindung fehlgeschlagen: ${(err as Error).message}` });
  }
}
