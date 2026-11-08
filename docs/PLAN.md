# Plan: Fokuspilot Studio (Arbeitstitel)

Stand: 07.11.2026 · **Phase 1–5 umgesetzt** (Grundgerüst, Studio mit Claude Code, YouTube, Instagram, TikTok, LinkedIn, Automationen, Analytics und Lernen) · Nächstes: echter Test mit deinen Konten, danach die optionalen Punkte

## Update 07.11.2026: Mehrere Projekte

Das Tool ist jetzt **projektneutral** („Marketing Studio“). Fokuspilot ist das erste Projekt; weitere wie die Behörden-App oder Corporate Health kommen einfach dazu.
- Jedes Projekt hat einen eigenen Ordner (`backlog/`, `referenzen/`, `PROJEKT.md`), eigene Konten, Posting-Zeiten, Standard-Hashtags, ein Briefing und Referenzen. Referenzen sind Dateien, Links oder Notizen.
- Für Phase 2 heißt das: Claude Code arbeitet im Projektordner und liest `PROJEKT.md` (Briefing plus Liste aller Referenzen). Statt einer festen `BRAND.md` je App gibt es das Briefing pro Projekt in der Oberfläche.
- Die Entwickler-Apps bei Google, Meta, TikTok und LinkedIn richtest du nur einmal ein; sie gelten für alle Projekte.

## Ziel

Ein Marketing-Tool, das lokal auf dem Mac läuft. Claude Code erstellt damit regelmäßig Kurzvideos für **Fokuspilot (KI-Telefonassistent)**. Nach deiner Freigabe veröffentlicht das Tool sie zeitgesteuert auf **Instagram Reels, TikTok, YouTube Shorts und LinkedIn**. Aus den Zahlen lernt es, was funktioniert.

Der Code entsteht komplett neu. Von Publit.Si übernehmen wir nur die Grundidee, keinen Code, keine Texte und kein Design.

## Festgelegte Entscheidungen

| Thema | Entscheidung |
|---|---|
| Einsatz | Nur für Fokuspilot. Das Datenmodell lässt weitere Projekte zu, die Oberfläche bleibt einfach. |
| Betrieb | Lokal auf deinem Mac, ohne Cloud und ohne Server |
| KI | Claude Code mit deinem Abo, im Headless-Modus gestartet |
| Plattformen | Instagram Reels, TikTok, YouTube Shorts, LinkedIn |
| Content-Quelle | Fokuspilot-Website (Repo oder Dateien folgen) |
| Sprache der Inhalte | Deutsch (Annahme) |

## Architektur

```
Dein Mac
├─ Web-App (Next.js, http://localhost:4321)  ← Oberfläche im Browser
├─ Worker (Node, als LaunchAgent)             ← postet pünktlich, Retries, holt Analytics
├─ SQLite-Datenbank + Medienordner
├─ Claude Code (headless)                     ← arbeitet nur im Content-Ordner
└─ Content-Ordner  fokuspilot-social/
   ├─ brand/        Logo, Farben, Schriften, BRAND.md (aus der Website)
   ├─ assets/       Screens, Demo-Audio, lizenzierte Musik
   ├─ video/        Remotion-Vorlagen und Render-Skripte
   ├─ backlog/<id>/ video.mp4, cover.jpg, meta.json (Texte je Plattform)
   ├─ learnings.md  bestätigte Erkenntnisse aus den Analysen
   └─ CLAUDE.md + .claude/settings.json  Regeln und erlaubte Befehle
```

**Stack:** TypeScript durchgehend, Next.js (Oberfläche + lokale API), SQLite mit Drizzle, Remotion für die Videos, ffmpeg und whisper.cpp für Untertitel (läuft lokal auf Apple Silicon). Dazu ein eigener MCP-Server, über den Claude Code direkt Backlog, Slots und Analytics nutzt.

**Unterschied zu Publit.Si: Wir brauchen keinen Tunnel und keine eigene Domain.** Alle vier Plattformen erlauben, eine lokale Datei direkt hochzuladen:

- Instagram: Resumable Upload. Geht nur mit „Facebook Login for Business“, also Instagram-Account plus verknüpfter Facebook-Seite.
- TikTok: `FILE_UPLOAD`
- YouTube: Resumable Upload
- LinkedIn: Videos API mit Upload in Teilen

Zu prüfen ist noch, ob jede Plattform eine OAuth-Weiterleitung auf `localhost` akzeptiert. Lehnt eine Plattform das ab, legen wir eine kleine Weiterleitungsseite auf die Fokuspilot-Website, sobald sie online ist.

## Sicherheit

- Zugangsdaten (Tokens) werden verschlüsselt gespeichert (AES-GCM); der Schlüssel liegt in der macOS-Keychain.
- Claude Code arbeitet nur im Content-Ordner. Erlaubt sind Rendern, ffmpeg, whisper und die MCP-Tools; alles andere fragt nach. Die Website wird nur gelesen, nie verändert.
- Nichts geht ohne deine Freigabe online.
- App-Secrets stehen nur in `.env` oder der Keychain, nie im Chat und nie im Repo.
- Das Repo `Marketing-App` ist derzeit **öffentlich**. Für ein internes Tool sollte es auf privat gestellt werden.

## Video-Formate (Vorschläge, werden nach Sichtung der Website festgelegt)

Jedes Format besteht aus einer Remotion-Vorlage und einer Liste von Episoden (JSON). Claude schreibt neue Episoden, den Rest erledigt der Renderer, und zwar bei gleicher Eingabe immer mit identischem Ergebnis.

1. **Live-Anruf-Demo:** animiertes Smartphone, Wellenform und Live-Transkript. Der Assistent nimmt einen Anruf an, z. B. eine Terminverschiebung um 22 Uhr.
2. **Branchen-Serie:** ein Short pro Zielbranche von der Website, mit derselben Vorlage und neuen Daten.
3. **Mailbox vs. Assistent:** Vorher/Nachher in 15 Sekunden.
4. **Einwand-Serie** (stark für LinkedIn): „Merken Anrufer, dass es KI ist?“, „Wie ist das mit der DSGVO?“. Antworten nur mit Fakten von der Website.
5. **Rechner:** Was verpasste Anrufe kosten. Nur mit Zahlen, die belegbar sind.
6. **Quiz „Mensch oder KI?“** mit KI-Kennzeichnung.

## Phasen

### Phase 0: Vorbereitung (vor allem du, parallel zu Phase 1)

Manche Freigaben dauern Wochen, deshalb früh beantragen.

- [ ] **Mac:** Node 22, pnpm, ffmpeg und Claude Code installieren, bei Claude Code einloggen
- [ ] **Instagram:** Business- oder Creator-Account mit einer Facebook-Seite verknüpfen; Meta-Entwickler-App mit „Facebook Login for Business“ anlegen
- [ ] **YouTube:** Google-Cloud-Projekt anlegen, YouTube Data API aktivieren, **Audit beantragen**. Ohne Audit bleiben per API hochgeladene Videos privat. Mit einem Google-Workspace-Konto und dem Nutzertyp „Intern“ entfällt die Abmeldung nach 7 Tagen.
- [ ] **TikTok:** Entwickler-App mit Sandbox anlegen. Ohne Audit gibt es nur private Posts oder Entwürfe. Start: Das Tool legt einen Entwurf in deiner TikTok-App ab, du tippst auf „Posten“.
- [ ] **LinkedIn:** Entwickler-App anlegen (braucht eine LinkedIn-Unternehmensseite). Aufs persönliche Profil posten geht sofort; für die Unternehmensseite muss die Community Management API freigegeben werden, also früh beantragen.
- [ ] Website-Repo oder Website-Dateien an mich schicken
- [ ] (ich) Technischer Test: OAuth-Weiterleitung und Upload eines Testvideos für jede Plattform prüfen

### Phase 1: Grundgerüst und erster Kanal (YouTube) ✅ umgesetzt

- Next.js-App mit SQLite-Datenbank und Einstellungen
- Konten verbinden per OAuth, Tokens in der Keychain
- Backlog: Ordner mit fertigen Videos importieren
- Kalender (Woche/Monat), Posting-Slots, Warteschlange mit Freigabe
- Worker als LaunchAgent: postet pünktlich, versucht es bei Fehlern nach 1, 5, 15 und 60 Minuten erneut, holt verpasste Posts nach dem Ruhezustand innerhalb einer einstellbaren Toleranz nach, schreibt Logs
- YouTube-Publisher: Resumable Upload und geplante Veröffentlichung über `publishAt`. Nach dem Audit veröffentlicht YouTube dann selbst, auch wenn der Mac aus ist.

**Meilenstein:** Ein Testvideo erscheint zur geplanten Zeit auf YouTube.
Getestet mit Unit-Tests, einem nachgebauten YouTube-Server und im Browser. Der echte Test mit deinem Kanal folgt, sobald das Google-Projekt eingerichtet ist (docs/SETUP.md).

### Phase 2: Studio, in dem Claude Code die Shorts baut ✅ umgesetzt

- Content-Ordner anlegen und Marke aus der Website einrichten (BRAND.md, Farben, Logo, Screens). **Braucht das Website-Repo.**
- Remotion-Vorlagen für 2–3 Formate
- Studio-Seite: Chat mit Claude Code, dessen Ausgabe live mitläuft. Schnellaktionen: „Neuer Short“, „Serie“, „Short aus einer Backlog-Idee“.
- Pro Short: Caption, Titel und Hashtags für jede Plattform, dazu die KI-Kennzeichnung
- Untertitel mit whisper.cpp
- MCP-Server: Claude füllt das Backlog, sieht freie Slots und speichert Texte

**Meilenstein:** Ein Prompt ergibt einen fertigen Short, der zur Freigabe in der Warteschlange liegt.

Umgesetzt am 07.11.2026 (projektneutral, für jedes Projekt):
- Studio-Seite mit Chats, Live-Verlauf, Schnellaktionen, Folgeaufträgen (Sitzung wird fortgesetzt) und Abbrechen.
- Der Worker startet `claude -p` im Projektordner (stream-json); höchstens n Aufträge gleichzeitig, pro Chat nacheinander.
- Video-Vorlage (Remotion) mit Szenen hook/text/bild/video/dialog/cta, Marke aus `studio/brand.json`. Im Test echt gerendert.
- `CLAUDE.md` + `.claude/settings.json` im Projektordner: Ablauf, Ausgabeformat (`backlog/<datum>-<slug>/video.mp4 + meta.json`), Regeln, erlaubte Befehle.
- MCP-Server „studio“: Briefing, Backlog, freie Slots, Konten, Backlog einlesen, zur Freigabe einplanen (nie veröffentlichen).
- Untertitel per whisper.cpp folgen später; bis dahin schreibt die Vorlage den Text selbst ins Bild.

### Phase 3: Die anderen drei Kanäle ✅ umgesetzt

- Instagram Reels per Resumable Upload
- TikTok: zuerst als Entwurf in der TikTok-App, nach dem Audit direkt öffentlich
- LinkedIn: persönliches Profil; Unternehmensseite nach Freigabe
- Plattform-Limits beachten, fehlgeschlagene Posts mit Ursache anzeigen, Tokens automatisch erneuern, Erinnerung zum Neu-Verbinden (LinkedIn alle 60 Tage)

Getestet mit Unit-Tests gegen nachgebaute Server von Meta, TikTok und LinkedIn. Der echte Test folgt, sobald die Entwickler-Apps eingerichtet sind (docs/SETUP.md, Abschnitte 5–7).
Alle Weiterleitungen laufen über `http://localhost:4321`, weil Meta im Entwicklungsmodus nur localhost akzeptiert.

### Phase 4: Automation ✅ umgesetzt

- Ein gelungener Chat wird zum „Rezept“. Zu einer festen Uhrzeit (über launchd) erzeugt das Tool X Shorts pro Lauf, jeden Tag mit neuem Blickwinkel.
- Freie Slots füllen sich automatisch aus dem Backlog. Die Posts warten immer auf Freigabe (umgesetzt als „zur Freigabe einplanen“; nichts geht ohne Freigabe online).

Umgesetzt am 07.11.2026:
- „Als Automation speichern“ macht aus einem Chat ein Rezept (Auftrag + Rückmeldungen + Vorbild-Short), das sich bearbeiten lässt.
- Der Worker startet fällige Läufe als frische Studio-Chats (Wochentage, Uhrzeit, 1–5 Shorts pro Lauf). Verpasste Läufe holt er innerhalb von 6 Stunden nach, ältere überspringt er.
- Nach dem Lauf plant er neue Shorts optional in freie Slots ein, zur Freigabe.
- Pro Projekt lassen sich freie Zeiten der nächsten n Tage mit ungeplanten Backlog-Shorts füllen, zur Freigabe.
- Bestätigte Erkenntnisse aus Phase 5 stehen im Auftrag jedes Laufs.

### Phase 5: Analytics und Lernen ✅ umgesetzt

- Zahlen pro Post (Views, Likes, Kommentare, Shares) von allen vier Plattformen, auch für Posts, die nicht über das Tool liefen
- Bewertung gegen den Median des eigenen Kanals
- Wöchentliche Analyse durch Claude. Die Erkenntnisse kommen nach deiner Bestätigung in `PROJEKT.md` (statt einer eigenen `learnings.md`) und fließen in neue Shorts ein.

Umgesetzt am 07.11.2026:
- Der Worker holt alle 6 Stunden (einstellbar) die Zahlen der letzten 90 Tage:
  - YouTube: Data API, Uploads-Playlist plus Statistik.
  - Instagram: Graph API, Likes und Kommentare plus Insights mit `instagram_manage_insights`.
  - TikTok: Display API mit `video.list`.
  - Ein Verlaufspunkt pro Stunde. Eigene Posts werden über die externe ID erkannt und dem Short im Backlog zugeordnet.
- LinkedIn: Zahlen zu persönlichen Posts erst nach Freigabe der Community Management API (`r_member_postAnalytics`). Bis dahin zeigt das Konto einen Hinweis.
- Bewertung: Views im Verhältnis zum Median des eigenen Kanals (90 Tage, nur Beiträge älter als 48 Stunden, mindestens 3). Stark ab ×1,5, schwach bis ×0,5.
- Seite „Zahlen“ mit Zeitraum 7/30/90 Tage: Kennzahlen mit Veränderung zum Vorzeitraum, Views nach Plattform, stärkste Beiträge, beste Uhrzeiten, alle Beiträge mit Bewertung.
- Wochenanalyse als Studio-Chat (Wochentag und Uhrzeit einstellbar, verpasste bis zu einem Tag nachgeholt, auch von Hand startbar). Claude nutzt die neuen Werkzeuge `statistik`, `erkenntnisse` und `erkenntnis_vorschlagen`.
- Erkenntnisse: Vorschläge übernehmen (Text änderbar), ablehnen (wird nicht erneut vorgeschlagen) oder eigene eintragen. Bestätigte stehen in `PROJEKT.md` und im Auftrag jeder Automation.

### Ergänzung: Stimmen mit ElevenLabs ✅ umgesetzt (08.11.2026)

- API-Schlüssel unter Einstellungen (verschlüsselt, mit Verbrauchsanzeige), Modell wählbar.
- Pro Projekt eine Hauptstimme und eine zweite Stimme fürs Gegenüber im Dialog. Beide stehen auch in `PROJEKT.md`.
- Studio-Werkzeuge `stimmen_liste` und `stimme_erzeugen`: Die MP3 kommt mit Zeitstempeln je Wort nach `studio/public/stimme/`. Den Schlüssel sieht Claude nie.
- Video-Vorlage Version 2: `voice` je Szene, `voice` und `at` je Dialogzeile, leisere Musik bei Sprecher. Bestehende Projekte werden automatisch aktualisiert; angepasste Vorlagen bekommen eine `.neu`-Fassung zum Übernehmen.

### Später (optional)

LinkedIn-Karussells (PDF), Antwortvorschläge für Kommentare, Mac automatisch aufwecken, Browser-Hilfe für öffentliche TikTok-Posts, weitere Projekte.

## Rechtliches, das wir einplanen

- Eigener Code und eigenes Design, nichts von Publit.Si übernehmen.
- **Anrufaufnahmen** nur als gestellte Demo-Gespräche oder mit Einwilligung aller Beteiligten (§ 201 StGB, DSGVO). Keine echten Kundengespräche.
- KI-Stimmen und KI-Inhalte kennzeichnen (Plattformregeln, Transparenzpflichten im EU AI Act).
- Werbeaussagen nur, wenn sie belegbar sind (UWG). Claude nutzt nur Fakten aus Website und BRAND.md.
- Remotion ist kostenlos für Firmen bis 3 Mitarbeitende, darüber braucht es eine Firmenlizenz.
- Musik nur mit Lizenz.

## Offene Punkte (blockieren den Start nicht)

1. Website-Repo oder -Dateien: nötig ab Phase 2
2. LinkedIn: persönliches Profil, Unternehmensseite oder beides?
3. Gibt es ein Google-Workspace-Konto? Das vereinfacht YouTube.
4. Stimme für die Demos: gestellte Anrufe mit dem echten Fokuspilot-Assistenten (empfohlen, zeigt das echte Produkt) oder ein Sprachausgabe-Dienst mit Zusatzkosten?
5. Wie viele Mitarbeitende hat Fokuspilot? (wegen der Remotion-Lizenz)
6. Posting-Rhythmus, z. B. 1 Short pro Tag plus 2 LinkedIn-Posts pro Woche?

## Entwicklungsweise

Ich entwickle in der Cloud-Sitzung im Repo `Marketing-App`; du klonst es auf den Mac. Mac-spezifische Teile (Keychain, launchd) laufen hier über austauschbare Platzhalter, den echten Test machst du auf dem Mac. Phase 1 kann sofort starten, ohne das Website-Repo.
