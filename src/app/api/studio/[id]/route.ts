import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { getSession, sessionMessages, sessionRuns } from "@/lib/studio/sessions";

/** Neue Nachrichten eines Studio-Chats (für die Live-Ansicht). ?after=<letzte Nachrichten-ID> */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const db = getDb();
  if (!Number.isInteger(id) || !getSession(db, id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const after = Number(new URL(req.url).searchParams.get("after")) || 0;
  const runs = sessionRuns(db, id);
  const last = runs.at(-1) ?? null;
  return NextResponse.json(
    {
      messages: sessionMessages(db, id, after),
      run: last && { id: last.id, state: last.state, error: last.error, newShorts: last.newShorts, cancelRequested: last.cancelRequested },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
