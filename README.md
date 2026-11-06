# Fokuspilot Studio

Lokales Marketing-Tool für **Fokuspilot (KI-Telefonassistent)**. Es plant Shorts, holt deine Freigabe ein und veröffentlicht sie pünktlich. Alles läuft auf deinem Mac, ohne Cloud. Zugangsdaten liegen verschlüsselt in der macOS-Keychain.

**Stand: Phase 1** – Grundgerüst plus YouTube. Gesamtplan: [docs/PLAN.md](docs/PLAN.md) · Einrichtung: [docs/SETUP.md](docs/SETUP.md)

## Was schon geht
- **Backlog:** ein Ordner pro Short (`video.mp4` + optional `meta.json`) oder Upload im Browser. Dauer und Format werden geprüft.
- **Planen:** Posting-Zeiten (Slots), „nächster freier Slot“ oder feste Zeit. Kalender als Woche oder Monat.
- **Freigabe:** Warteschlange mit „Freigeben“, „Alle freigeben“, „Verschieben“ und „Absagen“. Nichts geht ohne Freigabe online.
- **YouTube:** Anmeldung per OAuth mit PKCE. Upload in 8-MB-Teilen, der nach einem Abbruch fortgesetzt wird. KI-Kennzeichnung. Vorab-Upload mit Veröffentlichungszeit, sodass YouTube auch bei ausgeschaltetem Mac postet. Tageslimit wird eingehalten.
- **Worker im Hintergrund:**
  - postet pünktlich und versucht es bei Fehlern nach 1, 5, 15 und 60 Minuten erneut
  - holt verpasste Posts innerhalb einer Toleranz nach
  - setzt hängende Uploads nach einem Absturz fort
  - hält den Mac während Uploads wach
- **Test-Kanal**, um alles ohne echte Konten auszuprobieren.

## Schnellstart

```bash
pnpm install
pnpm local:setup
pnpm dev            # Oberfläche + Worker → http://127.0.0.1:4321
```

## Befehle

| Befehl | Zweck |
|---|---|
| `pnpm dev` | Oberfläche und Worker im Entwicklungsmodus |
| `pnpm local:install` / `local:uninstall` / `local:status` | Hintergrunddienste auf dem Mac (launchd) |
| `pnpm test` | Tests (Vitest) |
| `pnpm typecheck` | TypeScript prüfen |
| `pnpm db:generate` | Migration nach Schemaänderung erzeugen |

## Aufbau

```
src/app/            Oberfläche (Next.js) und API-Routen (Medien, Upload, OAuth)
src/lib/            Logik: Backlog, Slots, Posts, Einstellungen, Verschlüsselung
src/lib/publishing/ Plattform-Anbindungen (YouTube, Test-Kanal)
src/lib/worker/     Veröffentlichungs-Engine
worker/index.ts     Worker-Prozess
scripts/            Einrichtung und launchd-Dienste
drizzle/            Datenbank-Migrationen
tests/              Tests, u. a. gegen einen nachgebauten YouTube-Server
```
