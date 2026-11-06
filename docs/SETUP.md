# Einrichtung auf dem Mac

Rechne mit etwa 45 Minuten. Das meiste davon entfällt auf das Google-Cloud-Projekt für YouTube.
Deine Secrets trägst du nur in die `.env` ein, niemals in einen Chat.

## 1. Werkzeuge installieren (einmalig)

Im Terminal, mit [Homebrew](https://brew.sh):

```bash
brew install node@22 pnpm ffmpeg
```

Prüfen: `node -v` muss 22 oder höher zeigen.
Claude Code brauchst du erst ab Phase 2 (Studio).

## 2. Code holen und einrichten

```bash
git clone https://github.com/Fabian9876543/Marketing-App.git
cd Marketing-App
pnpm install
pnpm local:setup
```

`local:setup` prüft die Werkzeuge, legt die `.env` an, erstellt die Datenbank und den Ordner `~/Fokuspilot-Social/backlog`.
Beim ersten Start fragt macOS eventuell, ob „node“ auf die Schlüsselbundverwaltung zugreifen darf. Erlaube das mit **„Immer erlauben“**: Dort liegt der Schlüssel, mit dem deine Zugangsdaten verschlüsselt werden.

## 3. Ausprobieren ohne echte Konten

```bash
pnpm dev
```

Öffne http://127.0.0.1:4321 und gehe so vor:

1. **Konten** → „Test-Kanal anlegen“
2. **Einstellungen** → Posting-Zeiten anlegen, z. B. 09:00 und 19:00
3. Ein Video in `~/Fokuspilot-Social/backlog/<name>/video.mp4` legen oder unter **Backlog** hochladen
4. **Backlog** → „Einplanen“ mit einer Zeit in 1–2 Minuten

Kurz darauf steht der Post unter **Warteschlange → Veröffentlicht**. Die Kopie liegt im Datenordner unter `test-kanal/`.

## 4. YouTube verbinden

### 4.1 Google-Cloud-Projekt anlegen
1. https://console.cloud.google.com öffnen → oben „Projekt auswählen“ → **Neues Projekt**, z. B. „Fokuspilot Studio“.
2. **APIs & Dienste → Bibliothek** → „YouTube Data API v3“ → **Aktivieren**.

### 4.2 OAuth-Zustimmungsbildschirm (Google Auth Platform)
1. **Branding**: App-Name „Fokuspilot Studio“, deine E-Mail als Support-Adresse.
2. **Zielgruppe**:
   - Hast du **Google Workspace** (z. B. @fokuspilot.de) und gehört der YouTube-Kanal zu diesem Konto? Dann wähle **Intern**. Damit entfällt die Abmeldung nach 7 Tagen.
   - Sonst wähle **Extern**, lass die App im **Testmodus** und trage unter **Testnutzer** das Google-Konto ein, dem der Kanal gehört.
     Im Testmodus läuft die Anmeldung nach 7 Tagen ab. Das Tool zeigt dann „Neu verbinden“ an.
3. **Datenzugriff**: Berechtigungen `.../auth/youtube.upload` und `.../auth/youtube.readonly` hinzufügen.

### 4.3 OAuth-Client
1. **Clients → Client erstellen** → Typ **Webanwendung**.
2. **Autorisierte Weiterleitungs-URIs**: `http://127.0.0.1:4321/api/oauth/youtube/callback`
3. Client-ID und Client-Secret in die `.env` eintragen:
   ```
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   ```
4. Die App neu starten (`pnpm dev` beenden und wieder starten) → **Konten** → **YouTube verbinden**.

### 4.4 Wichtig: das YouTube-Audit
Google-Projekte, die noch nicht geprüft sind, dürfen per API nur **private** Videos hochladen.
Bis zum Audit kommen deine Shorts also privat bei YouTube an. Du kannst sie dort von Hand auf „öffentlich“ stellen.

Das Audit beantragst du über das Formular „YouTube API Services – Audit and Quota Extension“ (in der Google-Cloud-Konsole unter der YouTube Data API verlinkt).
Beschreibe dort ehrlich, wofür du die API nutzt: ein internes Tool, das Videos des eigenen Kanals plant und hochlädt. Die Prüfung kann einige Wochen dauern. Beantrage sie deshalb früh.

Bis dahin empfiehlt sich unter **Einstellungen → YouTube** die Sichtbarkeit **„Privat (zum Testen)“**.

## 5. Dauerhaft im Hintergrund laufen lassen

```bash
pnpm local:install     # baut die App, startet Oberfläche und Worker als Hintergrunddienste
pnpm local:status      # läuft alles?
pnpm local:uninstall   # wieder entfernen
```

Beide Dienste starten beim Anmelden am Mac und nach einem Absturz neu.
Die Logs liegen unter `~/Library/Application Support/FokuspilotStudio/logs/`.

**Rechner aus oder im Ruhezustand?**
- Verpasste Posts holt der Worker nach, solange die Verspätung innerhalb der Toleranz liegt (Standard: 2 Stunden). Danach landen sie unter „Fehler“, und du planst sie neu.
- Öffentliche YouTube-Videos werden bis zu 14 Tage vorab hochgeladen. YouTube veröffentlicht sie dann selbst, auch bei ausgeschaltetem Mac.

## 6. Updates

```bash
git pull
pnpm install
pnpm local:install   # nur wenn die Hintergrunddienste installiert sind
```

## Backlog-Format

Ein Ordner pro Short in `~/Fokuspilot-Social/backlog/`:

```
2026-11-10-anruf-um-22-uhr/
├─ video.mp4        (9:16, max. 3 Minuten für YouTube Shorts)
├─ cover.jpg        (optional)
└─ meta.json        (optional)
```

`meta.json`:

```json
{
  "title": "Anruf um 22 Uhr – wer geht ran?",
  "description": "Die Praxis ist zu, der Anruf kommt trotzdem an.",
  "hashtags": ["KI", "Telefonassistent"],
  "aiGenerated": true,
  "platforms": {
    "youtube": { "title": "Eigener YouTube-Titel", "description": "…", "tags": ["KI"] },
    "instagram": { "caption": "…" },
    "tiktok": { "caption": "…" },
    "linkedin": { "text": "…" }
  }
}
```

`aiGenerated: true` kennzeichnet das Video bei YouTube als KI-Inhalt (synthetische Stimme oder realistische KI-Bilder).
Die Texte für Instagram, TikTok und LinkedIn werden ab Phase 3 genutzt.
