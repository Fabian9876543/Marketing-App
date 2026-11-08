# Marketing Studio

Lokales Marketing-Tool für **beliebig viele Projekte** – Apps, Marken, Kunden. Es plant Shorts, holt deine Freigabe ein und veröffentlicht sie pünktlich auf YouTube, Instagram, TikTok und LinkedIn. Alles läuft auf deinem Mac, ohne Cloud. Zugangsdaten liegen verschlüsselt in der macOS-Keychain.

**Stand:** Projekte mit Referenzen, Studio (Claude Code baut Shorts), Automationen, Zahlen und Lernen, YouTube, Instagram, TikTok und LinkedIn. Gesamtplan: [docs/PLAN.md](docs/PLAN.md) · Einrichtung: [docs/SETUP.md](docs/SETUP.md)

## Was schon geht
- **Projekte:** Jedes Projekt hat einen eigenen Ordner, eigene Konten, eigene Posting-Zeiten, Standard-Hashtags und eine eigene Farbe. Oben in der Seitenleiste wechselst du das aktive Projekt; mit „Alle Projekte“ siehst du Übersicht, Kalender und Warteschlange über alle Projekte hinweg.
- **Briefing und Referenzen je Projekt:**
  - Briefing: Zielgruppe, Tonalität, Kernbotschaften, Regeln, Handlungsaufforderung.
  - Referenzen hochladen: Logo, Screenshots, Bildschirmaufnahmen, Musik, Dokumente, Schriften, außerdem Links und Notizen; die Kategorie erkennt das Tool automatisch.
  - Alles landet zusammen in `PROJEKT.md` im Projektordner, der Grundlage für Claude Code in Phase 2.
- **Studio:** Claude Code baut Shorts per Auftrag oder Schnellaktion, live im Chat mitverfolgbar. Grundlage sind Briefing und Referenzen; gerendert wird mit der mitgelieferten Remotion-Vorlage. Die fertigen Shorts samt Texten landen im Backlog, nichts geht ohne Freigabe online.
- **Automationen:** Aus einem gelungenen Studio-Chat wird ein Rezept, nach dem Claude zu festen Zeiten neue Shorts baut, jedes Mal mit neuem Thema. Neue Shorts und freie Posting-Zeiten werden automatisch zur Freigabe eingeplant.
- **Zahlen und Lernen:** Der Worker holt die Zahlen aller Konten, auch für Posts, die nicht über das Tool liefen. Jeder Beitrag wird mit dem Median seines Kanals verglichen (stark/normal/schwach). Einmal pro Woche schlägt Claude Erkenntnisse vor. Was du bestätigst, landet in `PROJEKT.md` und gilt für jeden neuen Short.
- **Stimmen (ElevenLabs):** Claude lässt Sprechertexte einsprechen, z. B. für einen Erzähler oder gestellte Telefonate mit zwei Stimmen. Die Stimme wählst du pro Projekt, der API-Schlüssel liegt verschlüsselt in der App.
- **Backlog:** ein Ordner pro Short (`video.mp4` + optional `meta.json`) oder Upload im Browser. Dauer und Format werden geprüft.
- **Planen:** Posting-Zeiten (Slots), „nächster freier Slot“ oder feste Zeit. Kalender als Woche oder Monat.
- **Freigabe:** Warteschlange mit „Freigeben“, „Alle freigeben“, „Verschieben“ und „Absagen“. Nichts geht ohne Freigabe online.
- **YouTube:** Anmeldung per OAuth mit PKCE. Upload in 8-MB-Teilen, der nach einem Abbruch fortgesetzt wird. KI-Kennzeichnung. Vorab-Upload mit Veröffentlichungszeit, sodass YouTube auch bei ausgeschaltetem Mac postet. Tageslimit wird eingehalten.
- **Worker im Hintergrund:**
  - postet pünktlich und versucht es bei Fehlern nach 1, 5, 15 und 60 Minuten erneut
  - holt verpasste Posts innerhalb einer Toleranz nach
  - setzt hängende Uploads nach einem Absturz fort
  - hält den Mac während Uploads wach
- **Instagram Reels:** Anmeldung über Facebook Login for Business. Upload direkt vom Mac ohne Tunnel. Wartet auf Instagrams Verarbeitung und prüft das Tageskontingent.
- **TikTok:** standardmäßig als Entwurf in deiner TikTok-App (ohne Audit möglich). Nach dem Audit auch direkt öffentlich, mit KI-Kennzeichnung.
- **LinkedIn:** Video-Posts aufs persönliche Profil. Text wird für LinkedIn korrekt geschützt, Hashtags bleiben klickbar. Erinnerung zum Neuverbinden alle 60 Tage.
- **Texte je Plattform** aus `meta.json`, Längen-Limits werden eingehalten. Bei KI-Inhalten hängt ein KI-Hinweis an, wo es keine API-Kennzeichnung gibt.
- **Test-Kanal**, um alles ohne echte Konten auszuprobieren.

## Schnellstart

```bash
pnpm install
pnpm local:setup
pnpm dev            # Oberfläche + Worker → http://localhost:4321
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
src/lib/            Logik: Projekte, Referenzen, Backlog, Slots, Posts, Einstellungen, Verschlüsselung
src/lib/publishing/ Plattform-Anbindungen (YouTube, Instagram, TikTok, LinkedIn, Test-Kanal)
src/lib/worker/     Veröffentlichungs-Engine
worker/index.ts     Worker-Prozess (Veröffentlichung und Studio-Aufträge)
mcp/                MCP-Server mit den Studio-Werkzeugen für Claude Code
vorlagen/studio/    Video-Vorlage (Remotion), wird in jeden Projektordner kopiert
scripts/            Einrichtung und launchd-Dienste
drizzle/            Datenbank-Migrationen
tests/              Tests, u. a. gegen nachgebaute Plattform-Server
```
