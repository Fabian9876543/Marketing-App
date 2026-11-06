import { connection } from "next/server";
import { addTestAccountAction, disconnectAccountAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Flash, PageHeader, PlatformChip, flashFrom } from "@/components/ui";
import { PLATFORM_LABEL, listAccounts } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { youtubeConfigured } from "@/lib/env";
import { youtubeRedirectUri } from "@/lib/publishing/youtube/oauth";

const UPCOMING = [
  { platform: "instagram" as const, note: "Phase 3 – Instagram Reels über die Meta-API" },
  { platform: "tiktok" as const, note: "Phase 3 – zuerst als Entwurf in deiner TikTok-App" },
  { platform: "linkedin" as const, note: "Phase 3 – persönliches Profil, später Unternehmensseite" },
];

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const accounts = listAccounts(db);
  const ytReady = youtubeConfigured();
  const hasTest = accounts.some((a) => a.platform === "simulator");

  return (
    <>
      <PageHeader title="Konten" subtitle="Verbundene Kanäle. Zugangsdaten liegen verschlüsselt auf diesem Rechner." />
      <Flash {...await flashFrom(searchParams)} />

      <section className="mb-8">
        <h2 className="h2 mb-3">Verbunden</h2>
        {accounts.length === 0 ? (
          <p className="card p-4 text-sm text-muted">Noch keine Konten verbunden.</p>
        ) : (
          <ul className="card divide-y divide-line">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <PlatformChip platform={a.platform} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{a.name}</div>
                  <div className="text-xs text-muted">
                    {PLATFORM_LABEL[a.platform]}
                    {a.handle ? ` · ${a.handle}` : ""}
                  </div>
                  {a.status === "needs_reconnect" && <p className="mt-1 text-xs text-bad">{a.statusMessage}</p>}
                </div>
                {a.status === "active" ? <Badge tone="ok">Aktiv</Badge> : <Badge tone="bad">Neu verbinden</Badge>}
                {a.platform === "youtube" && a.status === "needs_reconnect" && (
                  <a href="/api/oauth/youtube/start" className="btn btn-primary">
                    Neu verbinden
                  </a>
                )}
                <form action={disconnectAccountAction}>
                  <input type="hidden" name="accountId" value={a.id} />
                  <input type="hidden" name="back" value="/konten" />
                  <SubmitButton className="btn btn-danger" confirm={`${a.name} trennen? Geplante Posts auf diesem Konto werden abgebrochen.`}>
                    Trennen
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="h2 mb-3">Hinzufügen</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="card space-y-3 p-4">
            <div className="flex items-center gap-2">
              <PlatformChip platform="youtube" />
              <h3 className="font-medium">YouTube Shorts</h3>
            </div>
            {ytReady ? (
              <>
                <p className="text-sm text-muted">Melde dich mit dem Google-Konto an, dem der Fokuspilot-Kanal gehört.</p>
                <a href="/api/oauth/youtube/start" className="btn btn-primary">
                  YouTube verbinden
                </a>
              </>
            ) : (
              <div className="space-y-2 text-sm text-muted">
                <p>
                  Noch nicht eingerichtet. Trage <code>GOOGLE_CLIENT_ID</code> und <code>GOOGLE_CLIENT_SECRET</code> aus deinem Google-Cloud-Projekt in die{" "}
                  <code>.env</code> ein und starte die App neu.
                </p>
                <p>
                  Weiterleitungs-URI im OAuth-Client: <code className="break-all rounded bg-surface-2 px-1">{youtubeRedirectUri()}</code>
                </p>
                <p>Schritt für Schritt: docs/SETUP.md</p>
              </div>
            )}
            <p className="text-xs text-muted">
              Wichtig: Solange dein Google-Projekt nicht von YouTube geprüft (Audit) ist, bleiben per API hochgeladene Videos privat.
            </p>
          </div>

          <div className="card space-y-3 p-4">
            <div className="flex items-center gap-2">
              <PlatformChip platform="simulator" />
              <h3 className="font-medium">Test-Kanal</h3>
            </div>
            <p className="text-sm text-muted">
              Zum Ausprobieren ohne echtes Konto: Posts werden als Kopie in den Datenordner „veröffentlicht“.
            </p>
            {hasTest ? (
              <Badge tone="ok">Bereits angelegt</Badge>
            ) : (
              <form action={addTestAccountAction}>
                <input type="hidden" name="back" value="/konten" />
                <SubmitButton>Test-Kanal anlegen</SubmitButton>
              </form>
            )}
          </div>

          {UPCOMING.map((u) => (
            <div key={u.platform} className="card space-y-2 p-4 opacity-70">
              <div className="flex items-center gap-2">
                <PlatformChip platform={u.platform} />
                <h3 className="font-medium">{PLATFORM_LABEL[u.platform]}</h3>
                <Badge>Folgt</Badge>
              </div>
              <p className="text-sm text-muted">{u.note}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
