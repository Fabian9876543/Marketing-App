# Marketing Studio – Hinweise für Claude

Lokales Marketing-Tool (läuft auf dem Mac des Nutzers) für mehrere Projekte (Apps, Marken, Kunden).
Erstes Projekt des Nutzers ist Fokuspilot, ein KI-Telefonassistent; das Tool selbst ist projektneutral.
Gesamtplan und Phasen: `docs/PLAN.md`. Einrichtung: `docs/SETUP.md`.
Der Nutzer spricht Deutsch. Oberfläche, Fehlermeldungen und Doku sind auf Deutsch.

## Stack
- Next.js 16 (App Router, Turbopack, **ohne** Cache Components), React 19, Tailwind 4
- SQLite über better-sqlite3 + Drizzle. Nach Schemaänderungen `pnpm db:generate` ausführen und die Migration committen.
- Worker: `worker/index.ts`, läuft mit tsx. Die Logik steckt in `src/lib/worker/engine.ts` und ist testbar (Uhr und Publisher werden injiziert).
- Tests: Vitest in `tests/`; YouTube, Meta, TikTok und LinkedIn gegen nachgebaute HTTP-Server (Basis-URLs per Env überschreibbar, siehe `src/lib/env.ts`). Vor jedem Commit: `pnpm typecheck && pnpm test`.

## Regeln
- Alles hängt an `projects`: Konten, Shorts (contents), Posting-Zeiten (slots) und Referenzen haben eine `projectId`.
  Posts gehören über ihren Short zu einem Projekt. Konten eines Posts müssen zum Projekt des Shorts passen.
- Das aktive Projekt steht im Cookie `studio_projekt` (`src/lib/active-project.ts`, „alle“ = alle Projekte).
  Seiten, die ein einzelnes Projekt brauchen (Backlog, Konten hinzufügen), zeigen bei „alle“ eine Projektauswahl.
- Jeder Projektordner hat `backlog/`, `referenzen/<kategorie>/` und `PROJEKT.md`. PROJEKT.md wird bei jeder Änderung
  an Briefing oder Referenzen neu geschrieben (`writeBriefFile`) und ist die Grundlage für Phase 2.
- Dateien werden nur per ID ausgeliefert (`/api/media/[id]`, `/api/referenzen/[id]`), nie per Pfad; Pfade bleiben im Projektordner.
- Migration 0002 hat bestehende Daten in Projekt 1 „Fokuspilot“ übernommen; `adoptLegacyProject` setzt dessen Ordner.
- Studio (Phase 2): `src/lib/studio/` – `runner.ts` startet `claude -p --output-format stream-json` im Projektordner (über den Worker,
  `StudioQueue`), `workspace.ts` legt `studio/` (Vorlage aus `vorlagen/studio/`), `CLAUDE.md` und `.claude/settings.json` an,
  `tools.ts` + `mcp/studio-server.ts` sind die MCP-Werkzeuge. Neue Claude-Optionen nur nutzen, wenn `claude --help` sie kennt (`claudeInfo`).
  Tests nutzen `tests/fixtures/fake-claude.mjs` (CLAUDE_BIN). Agent-Posts haben `createdBy = agent` und `state = review`.
- Seiten, die die DB lesen, rufen zuerst `await connection()` auf (sonst prerendert Next sie zur Build-Zeit).
- Server-Aktionen in `src/app/actions.ts` geben Rückmeldung per Redirect mit `?ok=` oder `?fehler=`.
- Zeiten werden in UTC gespeichert und in der Zeitzone aus den Einstellungen angezeigt (`src/lib/time.ts`, Luxon).
- Zugangsdaten nur verschlüsselt speichern (`src/lib/accounts.ts`). Secrets nie loggen, nie committen.
- Neue Plattform = ein `Publisher` (`src/lib/publishing/types.ts`) plus ein `OAuthProvider` (`oauth.ts`), beide in `registry.ts` eintragen.
  Fehler als `PublishError` mit der passenden Art werfen: retryable, quota, processing, auth oder fatal.
  Was schon bei der Plattform liegt (Container, publish_id, Video-URN), in `uploadSession.remoteId` merken, damit kein zweiter Upload passiert.
- OAuth-Weiterleitungen laufen über `http://localhost:4321/api/oauth/<plattform>/callback` (Meta akzeptiert im Entwicklungsmodus nur localhost).
- TikTok-PKCE ist hex-codiert, LinkedIn-Texte müssen ins „Little Text“-Format (`toLittleText`).
- Nichts darf ohne Freigabe (`posts.state = approved`) veröffentlicht werden.
- Keine Inhalte, Texte oder Designs von Publit.Si übernehmen. Das Tool ist eine Eigenentwicklung.
