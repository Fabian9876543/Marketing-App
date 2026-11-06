# Plan: Fokuspilot Studio (Arbeitstitel)

Stand: 06.11.2026 · Status: Entwurf, Website-Repo von Fokuspilot steht noch aus

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

### Phase 1: Grundgerüst und erster Kanal (YouTube)

- Next.js-App mit SQLite-Datenbank und Einstellungen
- Konten verbinden per OAuth, Tokens in der Keychain
- Backlog: Ordner mit fertigen Videos importieren
- Kalender (Woche/Monat), Posting-Slots, Warteschlange mit Freigabe
- Worker als LaunchAgent: postet pünktlich, versucht es bei Fehlern nach 1, 5, 15 und 60 Minuten erneut, holt verpasste Posts nach dem Ruhezustand innerhalb einer einstellbaren Toleranz nach, schreibt Logs
- YouTube-Publisher: Resumable Upload und geplante Veröffentlichung über `publishAt`. Nach dem Audit veröffentlicht YouTube dann selbst, auch wenn der Mac aus ist.

**Meilenstein:** Ein Testvideo erscheint zur geplanten Zeit auf YouTube.

### Phase 2: Studio, in dem Claude Code die Shorts baut

- Content-Ordner anlegen und Marke aus der Website einrichten (BRAND.md, Farben, Logo, Screens). **Braucht das Website-Repo.**
- Remotion-Vorlagen für 2–3 Formate
- Studio-Seite: Chat mit Claude Code, dessen Ausgabe live mitläuft. Schnellaktionen: „Neuer Short“, „Serie“, „Short aus einer Backlog-Idee“.
- Pro Short: Caption, Titel und Hashtags für jede Plattform, dazu die KI-Kennzeichnung
- Untertitel mit whisper.cpp
- MCP-Server: Claude füllt das Backlog, sieht freie Slots und speichert Texte

**Meilenstein:** Ein Prompt ergibt einen fertigen Short, der zur Freigabe in der Warteschlange liegt.

### Phase 3: Die anderen drei Kanäle

- Instagram Reels per Resumable Upload
- TikTok: zuerst als Entwurf in der TikTok-App, nach dem Audit direkt öffentlich
- LinkedIn: persönliches Profil; Unternehmensseite nach Freigabe
- Plattform-Limits beachten, fehlgeschlagene Posts mit Ursache anzeigen, Tokens automatisch erneuern, Erinnerung zum Neu-Verbinden (LinkedIn alle 60 Tage)

### Phase 4: Automation

- Ein gelungener Chat wird zum „Rezept“. Zu einer festen Uhrzeit (über launchd) erzeugt das Tool X Shorts pro Lauf, jeden Tag mit neuem Blickwinkel.
- Freie Slots füllen sich automatisch aus dem Backlog, aber nur mit freigegebenen Shorts.

### Phase 5: Analytics und Lernen

- Zahlen pro Post (Views, Likes, Kommentare, Shares) von allen vier Plattformen, auch für Posts, die nicht über das Tool liefen
- Bewertung gegen den Median des eigenen Kanals
- Wöchentliche Analyse durch Claude. Die Erkenntnisse kommen nach deiner Bestätigung in `learnings.md` und fließen in neue Shorts ein.

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
