import path from "node:path";
import { connection } from "next/server";
import { saveSettingsAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Flash, PageHeader, flashFrom } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { PLATFORM_LABEL } from "@/lib/accounts";
import { dataDir, logDir } from "@/lib/env";
import { missingEnv } from "@/lib/publishing/oauth";
import { oauthProviders } from "@/lib/publishing/registry";
import { getEncryptionKey } from "@/lib/secrets/keystore";
import { getSettings, readHeartbeat, workerAlive } from "@/lib/settings";
import { relative } from "@/lib/time";

const BACK = "/einstellungen";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const s = getSettings(db);
  const alive = workerAlive(db);
  const hb = readHeartbeat(db);
  let keySource = "unbekannt";
  try {
    keySource = (await getEncryptionKey()).source === "keychain" ? "macOS-Keychain" : `Datei (${path.join(dataDir(), "secret.key")})`;
  } catch (err) {
    keySource = `Fehler: ${(err as Error).message}`;
  }

  return (
    <>
      <PageHeader title="Einstellungen" subtitle="Gelten für alle Projekte. Posting-Zeiten, Ordner und Briefing stellst du je Projekt ein." />
      <Flash {...await flashFrom(searchParams)} />

      <div className="grid gap-6 lg:grid-cols-2">
        <form action={saveSettingsAction} className="card space-y-4 p-4 lg:col-span-2">
          <input type="hidden" name="back" value={BACK} />
          <h2 className="h2">Allgemein</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="timezone">
                Zeitzone
              </label>
              <input id="timezone" name="timezone" defaultValue={s.timezone} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="tol">
                Verpasste Posts nachholen bis (Minuten)
              </label>
              <input id="tol" type="number" min={0} max={1440} name="missedToleranceMinutes" defaultValue={s.missedToleranceMinutes} className="input" />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="projectsDir">
              Ordner für neue Projekte (je Projekt ein Unterordner)
            </label>
            <input id="projectsDir" name="projectsDir" defaultValue={s.projectsDir} className="input font-mono text-xs" />
          </div>

          <h2 className="h2 border-t border-line pt-4">YouTube</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="ytPrivacy">
                Sichtbarkeit
              </label>
              <select id="ytPrivacy" name="ytPrivacy" defaultValue={s.youtube.privacy} className="input">
                <option value="public">Öffentlich</option>
                <option value="unlisted">Nicht gelistet</option>
                <option value="private">Privat (zum Testen)</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ytAhead">
                Vorab hochladen (Tage, 0 = aus)
              </label>
              <input id="ytAhead" type="number" min={0} max={30} name="ytUploadAheadDays" defaultValue={s.youtube.uploadAheadDays} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="ytLimit">
                Uploads pro Tag (Kontingent)
              </label>
              <input id="ytLimit" type="number" min={1} max={10000} name="ytDailyUploadLimit" defaultValue={s.youtube.dailyUploadLimit} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="ytCat">
                Kategorie
              </label>
              <select id="ytCat" name="ytCategoryId" defaultValue={s.youtube.categoryId} className="input">
                <option value="28">Wissenschaft &amp; Technik</option>
                <option value="27">Bildung</option>
                <option value="22">Menschen &amp; Blogs</option>
                <option value="26">Praktische Tipps &amp; Styling</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="ytAddShortsTag" defaultChecked={s.youtube.addShortsTag} /> #Shorts an die Beschreibung anhängen
          </label>
          <p className="text-xs text-muted">
            Vorab hochladen: Öffentliche Videos gehen bis zu so viele Tage vorher als „privat mit Veröffentlichungszeit“ zu YouTube. YouTube schaltet sie dann
            selbst frei – auch wenn dein Mac aus ist.
          </p>

          <h2 className="h2 border-t border-line pt-4">Studio (Claude Code)</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="studioModel">
                Modell
              </label>
              <select id="studioModel" name="studioModel" defaultValue={s.studio.model} className="input">
                <option value="">Standard (deine Claude-Code-Einstellung)</option>
                <option value="opus">Opus – am gründlichsten</option>
                <option value="sonnet">Sonnet – schneller</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="studioParallel">
                Gleichzeitige Aufträge
              </label>
              <input id="studioParallel" type="number" min={1} max={4} name="studioMaxParallel" defaultValue={s.studio.maxParallel} className="input" />
            </div>
          </div>

          <h2 className="h2 border-t border-line pt-4">Instagram, TikTok, LinkedIn</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="tiktokMode">
                TikTok-Modus
              </label>
              <select id="tiktokMode" name="tiktokMode" defaultValue={s.tiktok.mode} className="input">
                <option value="draft">Entwurf in der TikTok-App (ohne Audit)</option>
                <option value="direct_private">Direkt, nur für mich sichtbar (Test)</option>
                <option value="direct_public">Direkt öffentlich (nach Audit)</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="liVisibility">
                LinkedIn-Sichtbarkeit
              </label>
              <select id="liVisibility" name="liVisibility" defaultValue={s.linkedin.visibility} className="input">
                <option value="PUBLIC">Öffentlich</option>
                <option value="CONNECTIONS">Nur Kontakte</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="igShareToFeed" defaultChecked={s.instagram.shareToFeed} /> Instagram-Reels auch im Feed zeigen
          </label>
          <div>
            <label className="label" htmlFor="aiDisclosure">
              KI-Hinweis im Text (wo die Plattform keine eigene Kennzeichnung per API hat)
            </label>
            <input id="aiDisclosure" name="aiDisclosure" maxLength={200} defaultValue={s.aiDisclosure} className="input" />
          </div>
          <p className="text-xs text-muted">
            Ändert sich der TikTok-Modus von „Entwurf“ auf „direkt“, braucht TikTok die zusätzliche Berechtigung zum Veröffentlichen – verbinde das
            TikTok-Konto danach neu.
          </p>
          <div className="text-right">
            <SubmitButton className="btn btn-primary">Speichern</SubmitButton>
          </div>
        </form>

        <section id="worker" className="card space-y-3 p-4 lg:col-span-2">
          <h2 className="h2">Worker und Daten</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {alive ? <Badge tone="ok">Läuft</Badge> : <Badge tone="bad">Gestoppt</Badge>}
            {hb && (
              <span className="text-muted">
                PID {hb.pid} · gestartet {relative(hb.startedAt)} · letztes Lebenszeichen {relative(hb.at)}
              </span>
            )}
          </div>
          {!alive && (
            <p className="text-sm text-muted">
              Zum Testen: <code>pnpm dev</code> (startet Oberfläche und Worker). Dauerhaft im Hintergrund auf dem Mac: <code>pnpm local:install</code>.
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[180px_1fr]">
            <dt className="text-muted">Datenordner</dt>
            <dd className="break-all font-mono text-xs">{dataDir()}</dd>
            <dt className="text-muted">Logs</dt>
            <dd className="break-all font-mono text-xs">{logDir()}</dd>
            <dt className="text-muted">Schlüssel für Zugangsdaten</dt>
            <dd className="break-all text-xs">{keySource}</dd>
            <dt className="text-muted">Plattform-Zugangsdaten (.env)</dt>
            <dd className="flex flex-wrap gap-1">
              {Object.values(oauthProviders).map((p) => (
                <Badge key={p.platform} tone={missingEnv(p).length ? "warn" : "ok"}>
                  {PLATFORM_LABEL[p.platform]}: {missingEnv(p).length ? "fehlt" : "eingetragen"}
                </Badge>
              ))}
            </dd>
          </dl>
        </section>
      </div>
    </>
  );
}
