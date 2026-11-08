# Einrichtung auf dem Mac

Rechne mit etwa 20–30 Minuten pro Plattform. Das meiste davon entfällt auf die Entwickler-Konsolen von Google, Meta, TikTok und LinkedIn. Richte nur die Plattformen ein, die du nutzt.
Deine Secrets trägst du nur in die `.env` ein, niemals in einen Chat.

## 1. Werkzeuge installieren (einmalig)

Terminal öffnen (⌘ + Leertaste → „Terminal“). Falls `brew` noch fehlt („command not found: brew“), zuerst [Homebrew](https://brew.sh) installieren:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Das fragt nach deinem Mac-Passwort (beim Tippen erscheinen keine Zeichen) und installiert eventuell die Xcode-Befehlszeilentools; das dauert ein paar Minuten.
Auf Macs mit Apple-Chip (M1 und neuer) danach `brew` dauerhaft bekannt machen (zeigt der Installer auch unter „Next steps“ an):

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Dann die Werkzeuge:

```bash
brew install node@22 pnpm ffmpeg
echo 'export PATH="$(brew --prefix node@22)/bin:$PATH"' >> ~/.zprofile
export PATH="$(brew --prefix node@22)/bin:$PATH"
```

`node@22` legt Homebrew nicht automatisch in den Suchpfad, deshalb die beiden `PATH`-Zeilen.
Prüfen: `node -v` muss 22 oder höher zeigen.
Claude Code brauchst du für das Studio (Abschnitt „Studio: Claude Code baut Shorts“).

## 2. Code holen und einrichten

```bash
git clone https://github.com/Fabian9876543/Marketing-App.git
cd Marketing-App
pnpm install
pnpm local:setup
```

`local:setup` prüft die Werkzeuge, legt die `.env` an und erstellt die Datenbank sowie den Ordner `~/Marketing-Studio`, in dem neue Projekte ihre Unterordner bekommen.
Beim ersten Start fragt macOS eventuell, ob „node“ auf die Schlüsselbundverwaltung zugreifen darf. Erlaube das mit **„Immer erlauben“**: Dort liegt der Schlüssel, mit dem deine Zugangsdaten verschlüsselt werden.

## 3. Erstes Projekt anlegen und ausprobieren

```bash
pnpm dev
```

Öffne http://localhost:4321. Alles im Marketing Studio gehört zu einem **Projekt**, also einer App, einer Marke oder einem Kunden. Jedes Projekt hat:
- einen eigenen Ordner, Standard `~/Marketing-Studio/<projekt>/`, mit `backlog/` für fertige Shorts, `referenzen/` für Logo, Screenshots & Co. und `PROJEKT.md` mit dem Briefing
- eigene Social-Media-Konten, eigene Posting-Zeiten und eigene Referenzen

So probierst du es ohne echte Konten aus:
1. **Erstes Projekt anlegen**: Name, ein Satz zur Beschreibung, optional Website und Standard-Hashtags.
2. **Projekt → Briefing**: Zielgruppe, Tonalität, Kernbotschaften.
3. **Referenzen**: Logo, Screenshots, Bildschirmaufnahmen, Musik, Beispiel-Links und Notizen ablegen.
4. **Projekt → Posting-Zeiten**: z. B. 09:00 und 19:00.
5. **Konten** → „Test-Kanal anlegen“.
6. Ein Video in `~/Marketing-Studio/<projekt>/backlog/<name>/video.mp4` legen oder unter **Backlog** hochladen.
7. **Backlog** → „Einplanen“ mit einer Zeit in 1–2 Minuten.

Kurz darauf steht der Post unter **Warteschlange → Veröffentlicht**. Die Kopie liegt im Datenordner unter `test-kanal/`.

Weitere Projekte legst du unter **Alle Projekte → Neues Projekt** an. Oben in der Seitenleiste wechselst du das aktive Projekt. Mit **„Alle Projekte“** zeigen Übersicht, Kalender und Warteschlange alles auf einmal, jeweils mit Farbpunkt des Projekts.

**Konten gehören immer zu einem Projekt.** Verbinde sie deshalb, während das richtige Projekt oben ausgewählt ist. Die Entwickler-Apps aus den folgenden Abschnitten richtest du dagegen nur **einmal** ein; sie gelten für alle Projekte.

## 4. YouTube verbinden

### 4.1 Google-Cloud-Projekt anlegen
1. https://console.cloud.google.com öffnen → oben „Projekt auswählen“ → **Neues Projekt**, z. B. „Marketing Studio“.
2. **APIs & Dienste → Bibliothek** → „YouTube Data API v3“ → **Aktivieren**.

### 4.2 OAuth-Zustimmungsbildschirm (Google Auth Platform)
1. **Branding**: App-Name „Marketing Studio“, deine E-Mail als Support-Adresse.
2. **Zielgruppe**:
   - Hast du **Google Workspace** und gehören die YouTube-Kanäle zu Konten dieser Organisation? Dann wähle **Intern**. Damit entfällt die Abmeldung nach 7 Tagen.
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
   - Unter **Konfigurationen** eine neue Konfiguration anlegen: Zugriffstoken-Typ **Nutzer-Zugriffstoken**, Berechtigungen `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights` (für die Zahlen), `pages_show_list`, `pages_read_engagement`, `business_management`.
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
- Hast du Instagram schon vor Phase 5 verbunden, fehlt die Berechtigung `instagram_manage_insights`: in der Konfiguration ergänzen und Instagram neu verbinden. Ohne sie zeigt das Tool nur Likes und Kommentare.

## 6. TikTok verbinden

1. https://developers.tiktok.com → **Manage apps → Connect an app**. Plattform **Desktop** wählen.
2. Produkte hinzufügen:
   - **Login Kit**: Weiterleitungs-URI `http://localhost:4321/api/oauth/tiktok/callback`
   - **Content Posting API**: „Upload“ (Entwürfe) aktivieren; für direkte Posts zusätzlich „Direct Post“.
   - **Display API**: für die Zahlen (Views, Likes, Kommentare, Shares deiner Videos).
3. Berechtigungen: `user.info.basic`, `video.upload` und `video.list` (für direkte Posts zusätzlich `video.publish`).
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

Bei einem Wechsel von „Entwurf“ auf „direkt“ musst du TikTok neu verbinden, weil eine zusätzliche Berechtigung nötig ist. Das gilt auch, wenn du TikTok vor Phase 5 verbunden hast: Für die Zahlen braucht es `video.list`.

TikTok liefert Zahlen nur für öffentliche Videos. Entwürfe zählen erst, wenn du sie in der App veröffentlicht hast.

## 7. LinkedIn verbinden

1. https://www.linkedin.com/developers/apps → **App erstellen**. LinkedIn verlangt dafür eine Unternehmensseite; nimm deine eigene oder die eines Projekts.
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
- **Zahlen:** LinkedIn gibt Zahlen zu persönlichen Posts nur mit der Berechtigung `r_member_postAnalytics` heraus, und die gehört zur „Community Management API“ (Freigabe nötig, siehe oben). Bis dahin steht beim LinkedIn-Konto ein Hinweis, und unter **Zahlen** fehlen die LinkedIn-Posts.
- Die API-Version steht in der `.env` als `LINKEDIN_API_VERSION` (Standard `202605`). LinkedIn unterstützt jede Version etwa ein Jahr. Meldet das Tool „Version wird nicht mehr unterstützt“, trage einen neueren Monat ein (z. B. `202611`).

## Wenn eine Plattform `localhost` als Weiterleitung ablehnt

Manche Entwickler-Konsolen ändern ihre Regeln. Lehnt eine Plattform `http://localhost:4321/…` ab, gibt es einen Ausweg über eine eigene Website:
1. Lege auf einer deiner Websites eine kleine Seite an, z. B. `https://deine-website.de/oauth/tiktok`. Sie leitet nur auf deinen Mac weiter:
   ```html
   <script>location.replace("http://localhost:4321/api/oauth/tiktok/callback" + location.search)</script>
   ```
2. Trage diese HTTPS-Adresse in der Entwickler-Konsole als Weiterleitung ein.
3. Ergänze in der `.env`: `TIKTOK_REDIRECT_URI=https://deine-website.de/oauth/tiktok` (entsprechend `INSTAGRAM_…`, `LINKEDIN_…`, `YOUTUBE_REDIRECT_URI`).

## Studio: Claude Code baut Shorts

Im **Studio** gibst du Claude Code Aufträge wie „Mach einen neuen Short“ oder „Serie mit 3 Shorts“. Claude arbeitet im Projektordner, liest Briefing und Referenzen (`PROJEKT.md`) und rendert Videos mit der mitgelieferten Vorlage. Fertige Shorts legt es samt Texten ins Backlog. **Veröffentlicht wird nichts, bevor du freigibst.**

**Voraussetzungen**
- Claude Code ist installiert und angemeldet (Anleitung: https://docs.claude.com/claude-code). Einmal im Terminal `claude` starten und anmelden. Das Studio nutzt dein bestehendes Claude-Abo, keinen API-Key.
- Der Worker läuft (`pnpm dev` oder `pnpm local:install`). Er führt die Aufträge aus, auch wenn du die Seite schließt.

**Erste Schritte**
1. Briefing ausfüllen und Referenzen hochladen (Logo, Screenshots, Bildschirmaufnahmen). Je mehr echtes Material, desto besser die Shorts.
2. **Studio → Studio einrichten**. Das legt im Projektordner an:
   - `studio/`: die Video-Vorlage (Remotion, React), anpassbar pro Projekt
   - `CLAUDE.md`: die Arbeitsanweisung für Claude (Ablauf, Ausgabeformat, Regeln)
   - `.claude/settings.json`: welche Befehle Claude ohne Rückfrage ausführen darf
3. Erster Auftrag, am besten **„Vorlage an Marke anpassen“**. Claude übernimmt Farben, Logo und Schrift und rendert einen kurzen Markentest. Beim ersten Mal installiert es die Vorlage (`npm install`); Remotion lädt dabei einmalig einen Browser zum Rendern herunter (ca. 100 MB).
4. Danach z. B. **„Neuen Short machen“** oder ein eigener Auftrag. Rückmeldungen gibst du im selben Chat („Mach den Hook kürzer“), Claude setzt die Sitzung fort.
5. Fertige Shorts erscheinen im **Backlog**. Dort einplanen; oder Claude plant sie mit „Neue Shorts zur Freigabe einplanen“ ein, dann landen sie unter **Warteschlange → Zur Freigabe**.

**Sicherheit**
- Claude arbeitet nur im Projektordner. Ohne Rückfrage erlaubt sind Dateien lesen und schreiben, `npm install`, `npm run …`, `npx remotion …`, `ffmpeg`/`ffprobe`, `mkdir`, `cp` und `ls`.
- Verboten sind Löschen (`rm`), `git push`, Downloads per `curl`/`wget`, `sudo` sowie Webseiten abrufen oder suchen. Alles andere wird automatisch abgelehnt, weil niemand nachfragen kann.
- Die Zugangsdaten der App (Google, Meta, TikTok, LinkedIn) werden nicht an Claude weitergegeben.
- Die eigenen Werkzeuge des Studios (MCP-Server „studio“) können Briefing und Backlog lesen, freie Zeiten nennen und Shorts **zur Freigabe** einplanen, aber nie veröffentlichen.

**Gut zu wissen**
- Modell und Anzahl gleichzeitiger Aufträge stellst du unter **Einstellungen → Studio** ein.
- Willst du `CLAUDE.md` selbst pflegen, entferne die erste Zeile (Marker). Dann überschreibt das Studio die Datei nicht mehr.
- Die Video-Vorlage nutzt Remotion. Für Einzelpersonen und Firmen bis 3 Mitarbeitende ist Remotion kostenlos, größere Firmen brauchen eine Lizenz (remotion.pro).

## Stimmen mit ElevenLabs

Damit kann Claude Texte einsprechen lassen: einen Erzähler oder gestellte Telefonate mit zwei Stimmen (Anrufer und Assistent).

1. Konto bei https://elevenlabs.io anlegen. **Für Werbung brauchst du ein bezahltes Abo** (ab „Starter“). Im kostenlosen Plan ist die kommerzielle Nutzung nicht erlaubt.
2. In ElevenLabs **Developers → API Keys → Create API Key**. Wenn du die Rechte einschränkst, brauchst du: Text to Speech, Voices (lesen) und User (lesen, für die Verbrauchsanzeige).
3. In der App **Einstellungen → Stimmen (ElevenLabs)**: Schlüssel einfügen und auf **Verbinden** klicken. Die App prüft ihn sofort und speichert ihn verschlüsselt; Claude bekommt ihn nie zu sehen. Dort siehst du auch den Zeichenverbrauch.
4. **Projekt → Einstellungen → Stimmen**: eine **Hauptstimme** wählen (Erzähler, Assistent), optional eine **zweite Stimme** fürs Gegenüber im Dialog.
   - Stimmen aus der ElevenLabs-Bibliothek musst du dort erst zu „My Voices“ hinzufügen, dann erscheinen sie in der Auswahl.
   - Eine eigene Stimme klonen darfst du nur von dir selbst oder mit schriftlicher Einwilligung der Person.
5. Im Studio zum Beispiel schreiben: *„Mach einen Short mit Sprecher: gestelltes Telefonat, Anrufer und Assistent mit verschiedenen Stimmen.“*
   Claude erzeugt die Sprechertexte mit dem Werkzeug `stimme_erzeugen` und legt sie unter `studio/public/stimme/` ab. Die Szenenlängen passt es an die Sprechdauer an. Hintergrundmusik läuft dann automatisch leiser.
   Soll jeder Short einen Sprecher haben, schreib das ins Briefing unter **Regeln**.

**Kosten:** ElevenLabs rechnet nach Zeichen ab. Ein 30-Sekunden-Short mit Sprecher braucht etwa 400 bis 600 Zeichen.
**Kennzeichnung:** Videos mit KI-Stimme markiert Claude in `meta.json` als KI-generiert. Das Tool setzt dann die Plattform-Kennzeichnung bzw. hängt den KI-Hinweis an.

Bestehende Projekte bekommen die erweiterte Video-Vorlage beim nächsten Studio-Auftrag automatisch. Hat Claude die Vorlage in einem Projekt schon angepasst, liegt die neue Fassung als `studio/src/Short.tsx.neu` daneben. Claude übernimmt die Neuerungen dann selbst.

## Automationen: jeden Tag neue Shorts

Hat Claude im Studio einen Short gebaut, der dir gefällt, klickst du im Chat auf **„Als Automation speichern“**. Daraus wird ein **Rezept**: dein Auftrag, deine Rückmeldungen aus dem Chat und der gelungene Short als Vorbild. Du kannst das Rezept vor dem Speichern anpassen.

Pro Automation stellst du ein:
- **Wochentage und Uhrzeit**, z. B. Mo–Fr um 06:00
- **Shorts pro Lauf** (1–5)
- **Neue Shorts danach in freie Posting-Zeiten einplanen**: Sie landen unter **Warteschlange → Zur Freigabe**. Online gehen sie erst, wenn du freigibst, z. B. morgens beim Kaffee.

Jeder Lauf startet frisch nach demselben Rezept. Claude prüft dabei das Backlog und wählt jedes Mal ein neues Thema. Unter **Studio → Automationen** siehst du die nächsten Läufe und kannst eine Automation pausieren, sofort ausführen, bearbeiten oder löschen. Jeder Lauf erscheint als eigener Chat im Studio.

Ist dein Mac zur geplanten Zeit aus oder im Ruhezustand, holt der Worker den Lauf innerhalb von 6 Stunden nach, sonst wird er übersprungen. Für zuverlässige Läufe den Mac nicht zuklappen oder einen eigenen Mac mini bzw. Server nutzen.

**Freie Zeiten automatisch füllen** (Projekt → Posting-Zeiten): Freie Posting-Zeiten der nächsten Tage (einstellbar, Standard 3) bekommen Shorts aus dem Backlog, die noch nie geplant waren, die ältesten zuerst. Auch diese landen nur **zur Freigabe**.

## Zahlen: aus den Ergebnissen lernen

Der Worker holt alle 6 Stunden (einstellbar) die Zahlen aller verbundenen Konten: Views, Likes, Kommentare, Shares, bei Instagram auch Reichweite und Speicherungen. Das gilt für die letzten 90 Tage, auch für Posts, die nicht über das Tool liefen. Mit **Zahlen → Jetzt aktualisieren** geht es sofort.

- **Bewertung:** Jeder Beitrag wird mit dem **Median seines eigenen Kanals** verglichen. Ab dem 1,5-Fachen gilt er als **stark**, bis zum 0,5-Fachen als **schwach**. Beiträge jünger als 48 Stunden sind „zu frisch“. Ein Kanal braucht mindestens 3 ältere Beiträge für einen Median.
  So lässt sich ein TikTok mit 10.000 Views fair mit einem LinkedIn-Post mit 400 Views vergleichen.
- **Wochenanalyse:** Einmal pro Woche (Standard Montag 07:30, unter Einstellungen änderbar) startet pro Projekt ein Studio-Chat. Claude schaut sich die starken und schwachen Posts an und schlägt höchstens drei **Erkenntnisse** vor, z. B. „Hook als Frage in den ersten 2 Sekunden“. Die Analyse nutzt dein Claude-Abo; ohne mindestens 3 Beiträge mit Zahlen startet sie nicht.
- **Erkenntnisse bestätigen:** Unter **Zahlen → Erkenntnisse** übernimmst du einen Vorschlag (Text vorher anpassbar) oder lehnst ihn ab. Abgelehnte schlägt Claude nicht erneut vor. Eigene Erkenntnisse kannst du direkt eintragen.
- **Wirkung:** Bestätigte Erkenntnisse stehen in `PROJEKT.md` (Abschnitt „Erkenntnisse aus den Zahlen“) und im Auftrag jeder Automation. Claude berücksichtigt sie bei jedem neuen Short. Ohne deine Bestätigung ändert sich nichts.

Der Test-Kanal erzeugt erfundene Zahlen für seine „veröffentlichten“ Posts. So kannst du die Seite ausprobieren, bevor echte Konten verbunden sind.

## 8. Dauerhaft im Hintergrund laufen lassen

```bash
pnpm local:install     # baut die App, startet Oberfläche und Worker als Hintergrunddienste
pnpm local:status      # läuft alles?
pnpm local:uninstall   # wieder entfernen
```

Beide Dienste starten beim Anmelden am Mac und nach einem Absturz neu.
Die Logs liegen unter `~/Library/Application Support/MarketingStudio/logs/`.

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

Ein Ordner pro Short im Backlog-Ordner des Projekts, z. B. `~/Marketing-Studio/<projekt>/backlog/`:

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

Fehlt `hashtags`, gelten die Standard-Hashtags des Projekts.

`aiGenerated: true` kennzeichnet das Video als KI-Inhalt (synthetische Stimme oder realistische KI-Bilder):
- **YouTube:** über das offizielle Feld der API
- **TikTok-Direktposts:** über `is_aigc`
- **Instagram, LinkedIn und TikTok-Entwürfe:** mit dem KI-Hinweis aus den Einstellungen im Text

Fehlen eigene Texte für eine Plattform, baut das Tool sie aus `description` und `hashtags`. Dabei hält es die Längen-Limits ein: Instagram und TikTok 2.200 Zeichen, LinkedIn 3.000 Zeichen, Instagram höchstens 30 Hashtags.

## Von „Fokuspilot Studio“ umsteigen

Hast du die frühere Version schon benutzt, wird beim ersten Start alles übernommen:
- Konten, Shorts, Posting-Zeiten und Posts landen im Projekt **„Fokuspilot“**. Dessen Ordner ist dein bisheriger Content-Ordner (Standard `~/Fokuspilot-Social`).
- Datenbank und Schlüssel bleiben gültig: Der alte Datenordner wird weiterverwendet, der Keychain-Schlüssel übernommen.
- Die alten Hintergrunddienste entfernt `pnpm local:install` automatisch und installiert die neuen.
