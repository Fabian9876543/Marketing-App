import { lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { oauthStates } from "@/lib/db/schema";
import { missingEnv } from "@/lib/publishing/oauth";
import { getProject } from "@/lib/projects";
import { pkcePair, randomToken } from "@/lib/publishing/pkce";
import { oauthProviders } from "@/lib/publishing/registry";
import { getSettings } from "@/lib/settings";

/** Startet die Anmeldung bei einer Plattform (YouTube, Instagram, TikTok, LinkedIn). */
export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const back = (fehler: string) => {
    const url = new URL("/konten", req.url);
    url.searchParams.set("fehler", fehler);
    return NextResponse.redirect(url, 303);
  };

  const provider = oauthProviders[platform as keyof typeof oauthProviders];
  if (!provider) return back(`Unbekannte Plattform: ${platform}`);
  const missing = missingEnv(provider);
  if (missing.length) return back(`${missing.join(", ")} fehlt in der .env (siehe docs/SETUP.md) – danach die App neu starten`);

  const db = getDb();
  const projectId = Number(new URL(req.url).searchParams.get("projekt"));
  const project = Number.isInteger(projectId) ? getProject(db, projectId) : undefined;
  if (!project) return back("Bitte zuerst ein Projekt wählen – Konten gehören immer zu einem Projekt");

  db.delete(oauthStates).where(lt(oauthStates.createdAt, new Date(Date.now() - 15 * 60_000))).run();
  const state = randomToken();
  const pkce = provider.pkce ? pkcePair(provider.pkce) : { verifier: randomToken(), challenge: null };
  db.insert(oauthStates).values({ state, platform: provider.platform, codeVerifier: pkce.verifier, projectId: project.id }).run();
  return NextResponse.redirect(provider.authUrl({ state, codeChallenge: pkce.challenge, settings: getSettings(db) }), 303);
}
