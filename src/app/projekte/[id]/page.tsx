import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  addReferenceLinkAction,
  addReferenceNoteAction,
  addSlotAction,
  archiveProjectAction,
  deleteProjectAction,
  deleteReferenceAction,
  openProjectFolderAction,
  removeSlotAction,
  switchProjectAction,
  toggleSlotAction,
  updateBriefAction,
  updateProjectAction,
  updateReferenceAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Flash, PageHeader, Tabs } from "@/components/ui";
import { getScope } from "@/lib/active-project";
import { getDb } from "@/lib/db/client";
import { REFERENCE_CATEGORIES, type Project, type ProjectReference } from "@/lib/db/schema";
import { CATEGORY_LABEL, getProject, projectStats } from "@/lib/projects";
import { ACCEPTED_EXTENSIONS, listReferences } from "@/lib/references";
import { WEEKDAY_SHORT, listSlots } from "@/lib/slots";

const TABS = [
  { key: "briefing", label: "Briefing" },
  { key: "referenzen", label: "Referenzen" },
  { key: "zeiten", label: "Posting-Zeiten" },
  { key: "einstellungen", label: "Einstellungen" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const id = Number((await params).id);
  const sp = await searchParams;
  const db = getDb();
  const project = Number.isInteger(id) ? getProject(db, id) : undefined;
  if (!project) notFound();
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "briefing";
  const scope = await getScope(db);
  const isActive = scope.active?.id === project.id;
  const refs = listReferences(db, project.id);
  const slots = listSlots(db, project.id);
  const stats = projectStats(db).get(project.id);
  const back = `/projekte/${project.id}?tab=${tab}`;

  return (
    <>
      <PageHeader
        title={project.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: project.color }} />
            {project.description || "Projekt"}
            {project.archived && <Badge tone="warn">Archiviert</Badge>}
          </span>
        }
        actions={
          <>
            {!isActive && !project.archived && (
              <form action={switchProjectAction}>
                <input type="hidden" name="projekt" value={project.id} />
                <input type="hidden" name="back" value={back} />
                <SubmitButton>Als aktives Projekt wählen</SubmitButton>
              </form>
            )}
            <form action={openProjectFolderAction}>
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="back" value={back} />
              <SubmitButton>Ordner öffnen</SubmitButton>
            </form>
          </>
        }
      />
      <Flash {...{ ok: one(sp.ok), error: one(sp.fehler) }} />
      <Tabs
        active={tab}
        tabs={TABS.map((t) => ({
          ...t,
          href: `/projekte/${project.id}?tab=${t.key}`,
          count: t.key === "referenzen" ? refs.length : t.key === "zeiten" ? slots.length : undefined,
        }))}
      />

      {tab === "briefing" && <BriefingTab project={project} back={back} />}
      {tab === "referenzen" && <ReferencesTab project={project} refs={refs} back={back} />}
      {tab === "zeiten" && <SlotsTab project={project} slots={slots} back={back} />}
      {tab === "einstellungen" && <SettingsTab project={project} back={back} hasData={Boolean(stats?.shorts || stats?.accounts)} />}
    </>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/* ---------- Briefing ---------- */

function BriefingTab({ project, back }: { project: Project; back: string }) {
  const b = project.brief;
  const fields: { key: keyof typeof b; label: string; hint: string; rows: number }[] = [
    { key: "audience", label: "Zielgruppe", hint: "Wer soll die Shorts sehen? z. B. Inhaber von Arztpraxen, 35–60, wenig Zeit, genervt von verpassten Anrufen", rows: 3 },
    { key: "tone", label: "Tonalität", hint: "Wie soll es klingen? z. B. locker, auf Augenhöhe, mit einem Augenzwinkern, Du-Ansprache", rows: 2 },
    { key: "messages", label: "Kernbotschaften", hint: "Was soll hängen bleiben? Eine Botschaft pro Zeile", rows: 4 },
    { key: "rules", label: "Regeln (Do's & Don'ts)", hint: "z. B. keine Preise nennen, immer echte Screens zeigen, keine Konkurrenten erwähnen", rows: 3 },
    { key: "cta", label: "Handlungsaufforderung", hint: "z. B. Jetzt 14 Tage kostenlos testen auf fokuspilot.de", rows: 1 },
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <form action={updateBriefAction} className="card space-y-4 p-5">
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="back" value={back} />
        {fields.map((f) => (
          <div key={f.key}>
            <label className="label" htmlFor={f.key}>
              {f.label}
            </label>
            <textarea id={f.key} name={f.key} rows={f.rows} defaultValue={b[f.key] ?? ""} placeholder={f.hint} className="input" />
          </div>
        ))}
        <div className="text-right">
          <SubmitButton className="btn btn-primary">Briefing speichern</SubmitButton>
        </div>
      </form>
      <aside className="space-y-3 text-sm text-muted">
        <div className="card space-y-2 p-4">
          <h3 className="font-medium text-fg">Wofür das Briefing?</h3>
          <p>
            Briefing und Referenzen landen zusammen in <code>PROJEKT.md</code> im Projektordner. Daraus arbeitet später Claude Code, wenn es Shorts für
            dieses Projekt baut – und du hast alles an einer Stelle.
          </p>
          <p className="break-all font-mono text-xs">{path.join(project.folder, "PROJEKT.md")}</p>
        </div>
        <div className="card space-y-1 p-4">
          <h3 className="font-medium text-fg">Fehlt noch etwas?</h3>
          <p>
            Logo, Farben, Screenshots, Bildschirmaufnahmen, Musik oder Beispiel-Videos legst du unter{" "}
            <Link href={`/projekte/${project.id}?tab=referenzen`} className="underline">
              Referenzen
            </Link>{" "}
            ab.
          </p>
        </div>
      </aside>
    </div>
  );
}

/* ---------- Referenzen ---------- */

function CategorySelect({ name = "category", defaultValue, withAuto = false }: { name?: string; defaultValue?: string; withAuto?: boolean }) {
  return (
    <select name={name} defaultValue={defaultValue ?? (withAuto ? "auto" : "sonstiges")} className="input">
      {withAuto && <option value="auto">Automatisch erkennen</option>}
      {REFERENCE_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {CATEGORY_LABEL[c]}
        </option>
      ))}
    </select>
  );
}

function ReferencesTab({ project, refs, back }: { project: Project; refs: ProjectReference[]; back: string }) {
  const byCat = REFERENCE_CATEGORIES.map((c) => [c, refs.filter((r) => r.category === c)] as const).filter(([, list]) => list.length);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <form action="/api/referenzen/upload" method="post" encType="multipart/form-data" className="card space-y-3 p-4 lg:col-span-1">
          <h3 className="h2">Dateien hochladen</h3>
          <input type="hidden" name="projectId" value={project.id} />
          <input name="files" type="file" multiple required accept={ACCEPTED_EXTENSIONS} className="input" />
          <CategorySelect withAuto />
          <textarea name="note" rows={2} className="input" placeholder="Wofür? z. B. „Logo immer unten rechts, nie verzerren“" />
          <p className="text-xs text-muted">Bilder, Videos, Audio, PDFs, Texte, Schriften. Bis 500 MB pro Datei.</p>
          <button className="btn btn-primary w-full">Hochladen</button>
        </form>

        <form action={addReferenceLinkAction} className="card space-y-3 p-4">
          <h3 className="h2">Link merken</h3>
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="back" value={back} />
          <input name="url" required className="input" placeholder="https://… (Beispiel-Video, Wettbewerber, Styleguide)" />
          <input name="title" className="input" placeholder="Titel (optional)" />
          <CategorySelect defaultValue="inspiration" />
          <textarea name="note" rows={2} className="input" placeholder="Was gefällt daran?" />
          <SubmitButton className="btn w-full">Link speichern</SubmitButton>
        </form>

        <form action={addReferenceNoteAction} className="card space-y-3 p-4">
          <h3 className="h2">Notiz</h3>
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="back" value={back} />
          <input name="title" required className="input" placeholder="z. B. Farben" />
          <CategorySelect defaultValue="branding" />
          <textarea name="note" rows={4} required className="input" placeholder="z. B. Primär #1F6FEB, Akzent #FFB020, Schrift Inter" />
          <SubmitButton className="btn w-full">Notiz speichern</SubmitButton>
        </form>
      </div>

      {refs.length === 0 ? (
        <p className="card p-6 text-center text-sm text-muted">
          Noch keine Referenzen. Lade z. B. Logo, Screenshots der App, eine Bildschirmaufnahme oder ein Beispiel-Video hoch, das dir gefällt.
        </p>
      ) : (
        byCat.map(([cat, list]) => (
          <section key={cat}>
            <h3 className="h2 mb-2">
              {CATEGORY_LABEL[cat]} <span className="font-normal text-muted">({list.length})</span>
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((r) => (
                <ReferenceCard key={r.id} project={project} ref_={r} back={back} />
              ))}
            </div>
          </section>
        ))
      )}
      <form action={openProjectFolderAction} className="text-xs text-muted">
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="sub" value="referenzen" />
        <input type="hidden" name="back" value={back} />
        Dateien liegen in <code className="break-all">{path.join(project.folder, "referenzen")}</code> ·{" "}
        <button className="underline hover:text-fg">im Finder öffnen</button>
      </form>
    </div>
  );
}

function ReferencePreview({ r }: { r: ProjectReference }) {
  const src = `/api/referenzen/${r.id}`;
  if (r.kind === "file" && r.mime?.startsWith("image/")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={r.title} className="h-36 w-full rounded-lg bg-surface-2 object-contain" />;
  }
  if (r.kind === "file" && r.mime?.startsWith("video/")) {
    return <video src={src} controls preload="metadata" playsInline className="h-36 w-full rounded-lg bg-black object-contain" />;
  }
  if (r.kind === "file" && r.mime?.startsWith("audio/")) {
    return <audio src={src} controls preload="metadata" className="w-full" />;
  }
  if (r.kind === "file") {
    return (
      <a href={`${src}?download=1`} className="flex h-20 items-center justify-center rounded-lg bg-surface-2 text-sm font-semibold uppercase text-muted hover:text-fg">
        {path.extname(r.filePath ?? "").slice(1) || "Datei"} · herunterladen
      </a>
    );
  }
  if (r.kind === "link") {
    return (
      <a href={r.url!} target="_blank" rel="noreferrer" className="block truncate rounded-lg bg-surface-2 px-3 py-2 text-sm text-accent underline">
        {r.url}
      </a>
    );
  }
  return null;
}

function ReferenceCard({ project, ref_: r, back }: { project: Project; ref_: ProjectReference; back: string }) {
  return (
    <article className="card flex flex-col gap-2 p-3">
      <ReferencePreview r={r} />
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{r.title}</h4>
        <Badge>{r.kind === "file" ? "Datei" : r.kind === "link" ? "Link" : "Notiz"}</Badge>
      </div>
      {r.note && <p className="whitespace-pre-line text-xs text-muted">{r.note}</p>}
      {r.kind === "file" && (
        <p className="truncate font-mono text-[11px] text-muted" title={r.filePath ?? ""}>
          {r.filePath}
          {r.size ? ` · ${formatSize(r.size)}` : ""}
        </p>
      )}
      <details className="mt-auto text-sm">
        <summary className="cursor-pointer text-xs text-muted hover:text-fg">Bearbeiten</summary>
        <form action={updateReferenceAction} className="mt-2 space-y-2">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="referenceId" value={r.id} />
          <input type="hidden" name="back" value={back} />
          <input name="title" defaultValue={r.title} className="input" />
          <CategorySelect defaultValue={r.category} />
          <textarea name="note" rows={2} defaultValue={r.note} className="input" />
          <div className="flex justify-between gap-2">
            <SubmitButton className="btn">Speichern</SubmitButton>
          </div>
        </form>
        <form action={deleteReferenceAction} className="mt-2">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="referenceId" value={r.id} />
          <input type="hidden" name="back" value={back} />
          <SubmitButton className="btn btn-danger w-full" confirm={`„${r.title}“ entfernen?`}>
            Entfernen
          </SubmitButton>
        </form>
      </details>
    </article>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/* ---------- Posting-Zeiten ---------- */

function SlotsTab({ project, slots, back }: { project: Project; slots: ReturnType<typeof listSlots>; back: string }) {
  return (
    <section className="card max-w-2xl p-4">
      <p className="mb-4 text-sm text-muted">„Nächster freier Slot“ plant Shorts dieses Projekts in diese Zeiten ein. Jedes Projekt hat eigene Zeiten.</p>
      <ul className="mb-4 divide-y divide-line">
        {slots.length === 0 && <li className="py-2 text-sm text-muted">Noch keine Zeiten angelegt.</li>}
        {slots.map((slot) => (
          <li key={slot.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className={`w-14 font-semibold tabular-nums ${slot.active ? "" : "text-muted line-through"}`}>{slot.time}</span>
            <span className="flex-1 text-sm text-muted">
              {slot.weekdays.length === 7 ? "täglich" : slot.weekdays.map((d) => WEEKDAY_SHORT[d - 1]).join(", ")}
            </span>
            <form action={toggleSlotAction}>
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="slotId" value={slot.id} />
              <input type="hidden" name="active" value={slot.active ? "0" : "1"} />
              <input type="hidden" name="back" value={back} />
              <SubmitButton className="btn py-1 text-xs">{slot.active ? "Pausieren" : "Aktivieren"}</SubmitButton>
            </form>
            <form action={removeSlotAction}>
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="slotId" value={slot.id} />
              <input type="hidden" name="back" value={back} />
              <SubmitButton className="btn btn-danger py-1 text-xs" confirm={`Posting-Zeit ${slot.time} löschen?`}>
                Löschen
              </SubmitButton>
            </form>
          </li>
        ))}
      </ul>
      <form action={addSlotAction} className="space-y-3 border-t border-line pt-4">
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="back" value={back} />
        <div className="flex items-end gap-2">
          <div>
            <label className="label" htmlFor="time">
              Uhrzeit
            </label>
            <input id="time" type="time" name="time" required defaultValue="09:00" className="input w-auto" />
          </div>
          <SubmitButton className="btn btn-primary">Hinzufügen</SubmitButton>
        </div>
        <fieldset className="flex flex-wrap gap-3 text-sm">
          <legend className="label">Wochentage</legend>
          {WEEKDAY_SHORT.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" name="weekdays" value={i + 1} defaultChecked /> {d}
            </label>
          ))}
        </fieldset>
      </form>
    </section>
  );
}

/* ---------- Einstellungen ---------- */

function SettingsTab({ project, back, hasData }: { project: Project; back: string; hasData: boolean }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <form action={updateProjectAction} className="card space-y-4 p-5">
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="back" value={back} />
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="label" htmlFor="name">
              Name
            </label>
            <input id="name" name="name" required defaultValue={project.name} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="color">
              Farbe
            </label>
            <input id="color" name="color" type="color" defaultValue={project.color} className="h-9 w-16 cursor-pointer rounded-lg border border-line bg-surface p-1" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="description">
            Beschreibung
          </label>
          <textarea id="description" name="description" rows={2} defaultValue={project.description} className="input" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="website">
              Website
            </label>
            <input id="website" name="website" defaultValue={project.website ?? ""} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="hashtags">
              Standard-Hashtags
            </label>
            <input id="hashtags" name="hashtags" defaultValue={project.defaultHashtags.join(" ")} className="input" placeholder="#KI #Marke" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="folder">
            Projektordner
          </label>
          <input id="folder" name="folder" required defaultValue={project.folder} className="input font-mono text-xs" />
          <p className="mt-1 text-xs text-muted">
            Ändern verschiebt keine Dateien – lege sie selbst um. Standard-Hashtags gelten für Shorts ohne eigene Hashtags (beim nächsten Einlesen).
          </p>
        </div>
        <div className="text-right">
          <SubmitButton className="btn btn-primary">Speichern</SubmitButton>
        </div>
      </form>

      <section className="card space-y-3 border-bad-bg p-4">
        <h3 className="h2">Archivieren oder löschen</h3>
        <p className="text-sm text-muted">
          Archivierte Projekte verschwinden aus der Auswahl; bereits geplante Posts werden trotzdem veröffentlicht.
        </p>
        <form action={archiveProjectAction}>
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="archived" value={project.archived ? "0" : "1"} />
          <input type="hidden" name="back" value={back} />
          <SubmitButton className="btn w-full" confirm={project.archived ? undefined : `„${project.name}“ archivieren?`}>
            {project.archived ? "Wieder aktivieren" : "Archivieren"}
          </SubmitButton>
        </form>
        {project.archived && (
          <form action={deleteProjectAction}>
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="back" value={back} />
            <SubmitButton
              className="btn btn-danger w-full"
              confirm={`„${project.name}“ endgültig aus der App löschen?${hasData ? " Konten, Shorts-Einträge und Posts dieses Projekts werden entfernt." : ""} Der Ordner auf der Festplatte bleibt erhalten.`}
            >
              Endgültig löschen
            </SubmitButton>
          </form>
        )}
      </section>
    </div>
  );
}
