# Video-Vorlage für Shorts

Diese Vorlage baut aus einer JSON-Datei ein Hochkant-Video (1080 × 1920, 30 Bilder/s, H.264). Sie nutzt [Remotion](https://www.remotion.dev) (React).
Das Marketing Studio kopiert sie in jeden Projektordner nach `studio/`. Du darfst sie pro Projekt anpassen und erweitern.

## Einmalig

```bash
cd studio
npm install
```

## Rendern

```bash
cd studio
npx remotion render src/index.ts Short ../backlog/<ordner>/video.mp4 --props=<datei.json>
```

Vorschau im Browser: `npm run vorschau`.

Dateien, die im Video vorkommen (Logo, Screenshots, Bildschirmaufnahmen, Musik, Schrift), liegen in `studio/public/`. In der JSON gibst du sie relativ dazu an, z. B. `"src": "screens/start.png"`. Kopiere sie aus `../referenzen/`; verschiebe die Originale nicht.

## Marke: `brand.json`

| Feld | Bedeutung |
|---|---|
| `primary` | Hauptfarbe (Hook- und Schlussszene, eigene Sprechblasen) |
| `accent` | Akzentfarbe (Überschriften, Button, Fortschrittsbalken) |
| `background` | Hintergrund der Text-, Bild- und Dialogszenen |
| `text` | Schriftfarbe |
| `font` | Schriftart (CSS), `fontFile` optional eine Datei in `public/` (woff2/ttf/otf) |
| `logo` | Logo in `public/` – erscheint oben links und in der Schlussszene |
| `url` | Website für die Schlussszene |

Einzelne Werte kannst du pro Video in der JSON unter `"brand"` überschreiben.

## Aufbau der JSON

```json
{
  "scenes": [ … ],
  "music": { "src": "musik.mp3", "volume": 0.3 },
  "logoCorner": true,
  "progressBar": true
}
```

Die Länge des Videos ergibt sich aus den Szenen. Jede Szene hat eine Standarddauer, die `"seconds"` überschreibt.

| Szene | Felder | Standard | Wofür |
|---|---|---|---|
| `hook` | `text`, `sub` | 2,5 s | Einstieg, große Schrift auf Hauptfarbe |
| `text` | `title`, `lines` (Liste) | 4 s | Zeilen erscheinen nacheinander |
| `bild` | `src`, `caption`, `zoom` (Standard an) | 3,5 s | Screenshot oder Foto mit langsamem Zoom |
| `video` | `src`, `caption`, `startAt` (s), `muted` | 5 s | Bildschirmaufnahme oder Clip |
| `dialog` | `title`, `lines` mit `who`, `text`, optional `side` (`links`/`rechts`) | 6 s | Chat- oder Telefon-Dialog als Sprechblasen |
| `cta` | `text`, `sub`, `url` | 3 s | Schluss mit Logo und Handlungsaufforderung |

Ein vollständiges Beispiel steht in `beispiele/beispiel.json`.

## Tipps für gute Shorts

- Der Hook entscheidet: höchstens etwa 8 Wörter und eine konkrete Frage oder Behauptung.
- 15–40 Sekunden sind ideal. Pro Szene eine Aussage.
- Echte Screens und Aufnahmen aus `referenzen/` wirken besser als reine Textfolien.
- Lies den Text laut: Was man nicht in der Szenendauer lesen kann, ist zu lang.
- Der sichtbare Bereich spart oben, unten und rechts die Bedienelemente der Apps aus. Die Szenen halten sich daran.
