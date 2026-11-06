import { lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { oauthStates } from "@/lib/db/schema";
import { youtubeConfigured } from "@/lib/env";
import { pkcePair, randomToken } from "@/lib/publishing/pkce";
import { buildAuthUrl } from "@/lib/publishing/youtube/oauth";

/** Startet die Google-Anmeldung für einen YouTube-Kanal. */
export async function GET(req: Request) {
  if (!youtubeConfigured()) {
    const url = new URL("/konten", req.url);
    url.searchParams.set("fehler", "GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET fehlen in der .env (siehe docs/SETUP.md)");
    return NextResponse.redirect(url, 303);
  }
  const db = getDb();
  db.delete(oauthStates).where(lt(oauthStates.createdAt, new Date(Date.now() - 15 * 60_000))).run();
  const state = randomToken();
  const { verifier, challenge } = pkcePair();
  db.insert(oauthStates).values({ state, platform: "youtube", codeVerifier: verifier }).run();
  return NextResponse.redirect(buildAuthUrl({ state, codeChallenge: challenge }), 303);
}
