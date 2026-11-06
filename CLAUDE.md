# Fokuspilot Studio – Hinweise für Claude

Lokales Marketing-Tool (läuft auf dem Mac des Nutzers) für Fokuspilot, einen KI-Telefonassistenten.
Gesamtplan und Phasen: `docs/PLAN.md`. Einrichtung: `docs/SETUP.md`.
Der Nutzer spricht Deutsch. Oberfläche, Fehlermeldungen und Doku sind auf Deutsch.

## Stack
- Next.js 16 (App Router, Turbopack, **ohne** Cache Components), React 19, Tailwind 4
- SQLite über better-sqlite3 + Drizzle. Nach Schemaänderungen `pnpm db:generate` ausführen und die Migration committen.
- Worker: `worker/index.ts`, läuft mit tsx. Die Logik steckt in `src/lib/worker/engine.ts` und ist testbar (Uhr und Publisher werden injiziert).
- Tests: Vitest in `tests/`; YouTube, Meta, TikTok und LinkedIn gegen nachgebaute HTTP-Server (Basis-URLs per Env überschreibbar, siehe `src/lib/env.ts`). Vor jedem Commit: `pnpm typecheck && pnpm test`.

## Regeln
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
