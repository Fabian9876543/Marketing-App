# Einrichtung auf dem Mac

Rechne mit etwa 20–30 Minuten pro Plattform. Das meiste davon entfällt auf die Entwickler-Konsolen von Google, Meta, TikTok und LinkedIn. Richte nur die Plattformen ein, die du nutzt.
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

Öffne http://localhost:4321 und gehe so vor:

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
2. **Autorisierte Weiterleitungs-URIs**: `http://localhost:4321/api/oauth/youtube/callback`
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

## 5. Instagram verbinden

**Voraussetzung:** Ein Instagram-**Business**- oder **Creator**-Konto, verknüpft mit einer Facebook-Seite (Instagram-App → Einstellungen → Konto → Verknüpfte Facebook-Seite).

1. https://developers.facebook.com → **Meine Apps → App erstellen** → Anwendungsfall „Andere“ → Typ **Business**.
2. Produkt **Facebook Login for Business** hinzufügen.
   - Unter **Konfigurationen** eine neue Konfiguration anlegen: Zugriffstoken-Typ **Nutzer-Zugriffstoken**, Berechtigungen `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`.
   - Die angezeigte **Konfigurations-ID** notieren.
   - Hintergrund: Nur mit Facebook Login for Business darf das Tool Reels direkt vom Mac hochladen (ohne öffentlichen Server).
3. **Weiterleitung:** Solange die App im **Entwicklungsmodus** ist, erlaubt Meta `http://localhost` automatisch. Lass die App deshalb im Entwicklungsmodus. Für dein eigenes Konto reicht das, weil du als Admin der App eingetragen bist.
4. **App-Einstellungen → Allgemein**: App-ID und App-Geheimcode in die `.env`:
   ```
   META_APP_ID=…
   META_APP_SECRET=…
   META_CONFIG_ID=…
   ```
5. App neu starten → **Konten** → **Instagram verbinden** → mit dem Facebook-Konto anmelden, das die Seite verwaltet, und die Seite samt Instagram-Konto auswählen.

Hinweise:
- Instagram erlaubt 100 Posts pro 24 Stunden über die API. Das Tool prüft das vor jedem Upload.
- Für KI-Inhalte gibt es keine Kennzeichnung per API. Das Tool hängt deshalb den KI-Hinweis aus den Einstellungen an die Caption an.
- Meta verlangt etwa alle 90 Tage eine erneute Anmeldung. Das Tool erinnert dich eine Woche vorher.

## 6. TikTok verbinden

1. https://developers.tiktok.com → **Manage apps → Connect an app**. Plattform **Desktop** wählen.
2. Produkte hinzufügen:
   - **Login Kit**: Weiterleitungs-URI `http://localhost:4321/api/oauth/tiktok/callback`
   - **Content Posting API**: „Upload“ (Entwürfe) aktivieren; für direkte Posts zusätzlich „Direct Post“.
3. Berechtigungen: `user.info.basic` und `video.upload` (für direkte Posts zusätzlich `video.publish`).
4. Unter **Sandbox** eine Sandbox anlegen und dein TikTok-Konto als Testnutzer eintragen. Bis zur Freigabe der App funktioniert nur das.
5. Client Key und Client Secret in die `.env`:
   ```
   TIKTOK_CLIENT_KEY=…
   TIKTOK_CLIENT_SECRET=…
   ```
6. App neu starten → **Konten** → **TikTok verbinden**.

**Wie gepostet wird** (Einstellungen → TikTok-Modus):
- **Entwurf in der App** (Standard, kein Audit nötig): Das Video landet in deiner TikTok-App im Posteingang. Du fügst dort den Text ein (steht beim Post im Tool zum Kopieren bereit), setzt bei KI-Inhalten das KI-Label und tippst auf „Posten“.
- **Direkt, nur für mich**: zum Testen. Das Video wird privat veröffentlicht.
- **Direkt öffentlich**: erst möglich, wenn TikTok deine App geprüft hat (Audit). Der KI-Hinweis wird dann automatisch gesetzt.

Bei einem Wechsel von „Entwurf“ auf „direkt“ musst du TikTok neu verbinden, weil eine zusätzliche Berechtigung nötig ist.

## 7. LinkedIn verbinden

1. https://www.linkedin.com/developers/apps → **App erstellen**. LinkedIn verlangt dafür eine Unternehmensseite; nimm die von Fokuspilot.
2. Reiter **Produkte**: „**Share on LinkedIn**“ und „**Sign In with LinkedIn using OpenID Connect**“ hinzufügen (beide sofort verfügbar).
3. Reiter **Auth** → **Authorized redirect URLs**: `http://localhost:4321/api/oauth/linkedin/callback`
4. Client ID und Client Secret in die `.env`:
   ```
   LINKEDIN_CLIENT_ID=…
   LINKEDIN_CLIENT_SECRET=…
   ```
5. App neu starten → **Konten** → **LinkedIn verbinden**.

Hinweise:
- Gepostet wird auf dein **persönliches Profil**. Für die Unternehmensseite muss LinkedIn die „Community Management API“ freigeben. Das beantragst du im selben Reiter **Produkte**; die Prüfung dauert oft Wochen.
- LinkedIn verlangt **alle 60 Tage** eine neue Anmeldung. Das Tool erinnert dich eine Woche vorher in der Übersicht.
- Die API-Version steht in der `.env` als `LINKEDIN_API_VERSION` (Standard `202605`). LinkedIn unterstützt jede Version etwa ein Jahr. Meldet das Tool „Version wird nicht mehr unterstützt“, trage einen neueren Monat ein (z. B. `202611`).

## Wenn eine Plattform `localhost` als Weiterleitung ablehnt

Manche Entwickler-Konsolen ändern ihre Regeln. Lehnt eine Plattform `http://localhost:4321/…` ab, gibt es einen Ausweg, sobald die Fokuspilot-Website online ist:
1. Lege auf der Website eine kleine Seite an, z. B. `https://fokuspilot.de/oauth/tiktok`. Sie leitet nur auf deinen Mac weiter:
   ```html
   <script>location.replace("http://localhost:4321/api/oauth/tiktok/callback" + location.search)</script>
   ```
2. Trage diese HTTPS-Adresse in der Entwickler-Konsole als Weiterleitung ein.
3. Ergänze in der `.env`: `TIKTOK_REDIRECT_URI=https://fokuspilot.de/oauth/tiktok` (entsprechend `INSTAGRAM_…`, `LINKEDIN_…`, `YOUTUBE_REDIRECT_URI`).

## 8. Dauerhaft im Hintergrund laufen lassen

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

## 9. Updates

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

`aiGenerated: true` kennzeichnet das Video als KI-Inhalt (synthetische Stimme oder realistische KI-Bilder):
- **YouTube:** über das offizielle Feld der API
- **TikTok-Direktposts:** über `is_aigc`
- **Instagram, LinkedIn und TikTok-Entwürfe:** mit dem KI-Hinweis aus den Einstellungen im Text

Fehlen eigene Texte für eine Plattform, baut das Tool sie aus `description` und `hashtags`. Dabei hält es die Längen-Limits ein: Instagram und TikTok 2.200 Zeichen, LinkedIn 3.000 Zeichen, Instagram höchstens 30 Hashtags.
