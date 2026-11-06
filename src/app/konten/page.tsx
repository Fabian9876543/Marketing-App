import { connection } from "next/server";
import { addTestAccountAction, disconnectAccountAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Flash, PageHeader, PlatformChip, flashFrom } from "@/components/ui";
import { PLATFORM_LABEL, listAccounts } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import type { Account, Platform } from "@/lib/db/schema";
import { missingEnv } from "@/lib/publishing/oauth";
import { oauthProviders } from "@/lib/publishing/registry";
import { getSettings } from "@/lib/settings";
import { formatDate, relative } from "@/lib/time";

type Connectable = Exclude<Platform, "simulator">;

const INFO: Record<Connectable, { title: string; text: string; note: string }> = {
  youtube: {
    title: "YouTube Shorts",
    text: "Melde dich mit dem Google-Konto an, dem der Fokuspilot-Kanal gehört.",
    note: "Solange dein Google-Projekt nicht von YouTube geprüft ist (Audit), bleiben per API hochgeladene Videos privat.",
  },
  instagram: {
    title: "Instagram Reels",
    text: "Melde dich mit dem Facebook-Konto an, das die mit Instagram verknüpfte Facebook-Seite verwaltet. Alle verknüpften Instagram-Konten werden übernommen.",
    note: "Nötig: Instagram-Business- oder Creator-Konto, verknüpft mit einer Facebook-Seite. Die Meta-App bleibt im Entwicklungsmodus.",
  },
  tiktok: {
    title: "TikTok",
    text: "Melde dich mit dem TikTok-Konto von Fokuspilot an.",
    note: "Ohne TikTok-Audit landen Videos als Entwurf in deiner TikTok-App – dort Text einfügen und posten.",
  },
  linkedin: {
    title: "LinkedIn",
    text: "Melde dich mit deinem LinkedIn-Profil an. Posts erscheinen auf deinem persönlichen Profil.",
    note: "LinkedIn verlangt alle 60 Tage eine neue Anmeldung. Für die Unternehmensseite muss LinkedIn erst die Community Management API freigeben.",
  },
};

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const accounts = listAccounts(db);
  const settings = getSettings(db);
  const hasTest = accounts.some((a) => a.platform === "simulator");
  const connectable = Object.keys(INFO) as Connectable[];

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
              <AccountRow key={a.id} account={a} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="h2 mb-3">Hinzufügen</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {connectable.map((platform) => {
            const provider = oauthProviders[platform]!;
            const missing = missingEnv(provider);
            const info = INFO[platform];
            return (
              <div key={platform} className="card flex flex-col gap-3 p-4">
                <div className="flex items-center gap-2">
                  <PlatformChip platform={platform} />
                  <h3 className="font-medium">{info.title}</h3>
                  {missing.length ? <Badge tone="warn">Einrichtung fehlt</Badge> : <Badge tone="ok">Bereit</Badge>}
                </div>
                {missing.length === 0 ? (
                  <>
                    <p className="text-sm text-muted">{info.text}</p>
                    <a href={`/api/oauth/${platform}/start`} className="btn btn-primary self-start">
                      {PLATFORM_LABEL[platform]} verbinden
                    </a>
                  </>
                ) : (
                  <div className="space-y-2 text-sm text-muted">
                    <p>
                      Trage in die <code>.env</code> ein: {missing.map((m) => <code key={m} className="mr-1 rounded bg-surface-2 px-1">{m}</code>)} und starte die App neu.
                    </p>
                    <p className="[overflow-wrap:anywhere]">
                      Weiterleitungs-URI für die App: <code className="rounded bg-surface-2 px-1">{provider.redirectUri()}</code>
                    </p>
                    <p>Schritt für Schritt: docs/SETUP.md</p>
                  </div>
                )}
                <p className="mt-auto text-xs text-muted">
                  {info.note}
                  {platform === "tiktok" && (
                    <>
                      {" "}
                      Aktueller Modus:{" "}
                      {{ draft: "Entwurf in der App", direct_private: "direkt, nur für dich", direct_public: "direkt öffentlich" }[settings.tiktok.mode]} (änderbar unter
                      „Einstellungen“).
                    </>
                  )}
                </p>
              </div>
            );
          })}

          <div className="card flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
              <PlatformChip platform="simulator" />
              <h3 className="font-medium">Test-Kanal</h3>
            </div>
            <p className="text-sm text-muted">Zum Ausprobieren ohne echtes Konto: Posts werden als Kopie in den Datenordner „veröffentlicht“.</p>
            {hasTest ? (
              <Badge tone="ok">Bereits angelegt</Badge>
            ) : (
              <form action={addTestAccountAction}>
                <input type="hidden" name="back" value="/konten" />
                <SubmitButton>Test-Kanal anlegen</SubmitButton>
              </form>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function AccountRow({ account: a }: { account: Account }) {
  const soon = a.reconnectBy && a.reconnectBy.getTime() - Date.now() < 7 * 86_400_000;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <PlatformChip platform={a.platform} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{a.name}</div>
        <div className="text-xs text-muted">
          {PLATFORM_LABEL[a.platform]}
          {a.handle ? ` · ${a.handle}` : ""}
          {a.reconnectBy && (
            <span className={soon ? "text-warn" : ""}>
              {" "}
              · neu verbinden bis {formatDate(a.reconnectBy, "Europe/Berlin")} ({relative(a.reconnectBy)})
            </span>
          )}
        </div>
        {a.status === "needs_reconnect" && <p className="mt-1 text-xs text-bad">{a.statusMessage}</p>}
      </div>
      {a.status === "active" ? <Badge tone={soon ? "warn" : "ok"}>{soon ? "Läuft bald ab" : "Aktiv"}</Badge> : <Badge tone="bad">Neu verbinden</Badge>}
      {a.platform !== "simulator" && (a.status === "needs_reconnect" || soon) && (
        <a href={`/api/oauth/${a.platform}/start`} className="btn btn-primary">
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
  );
}
