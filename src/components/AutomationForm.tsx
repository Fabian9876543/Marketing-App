import { saveAutomationAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import type { Automation } from "@/lib/db/schema";
import { WEEKDAY_SHORT } from "@/lib/slots";

/** Formular zum Anlegen und Bearbeiten einer Automation. */
export function AutomationForm({
  projectId,
  automation,
  draft,
  back,
}: {
  projectId: number;
  automation?: Automation;
  draft?: { name: string; recipe: string; sourceSessionId?: number };
  back: string;
}) {
  const a = automation;
  const weekdays = a?.weekdays ?? [1, 2, 3, 4, 5];
  return (
    <form action={saveAutomationAction} className="card max-w-3xl space-y-5 p-5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="back" value={back} />
      {a && <input type="hidden" name="automationId" value={a.id} />}
      {draft?.sourceSessionId && <input type="hidden" name="sourceSessionId" value={draft.sourceSessionId} />}

      <div>
        <label className="label" htmlFor="name">
          Name
        </label>
        <input id="name" name="name" required maxLength={80} defaultValue={a?.name ?? draft?.name ?? ""} className="input" placeholder="z. B. Täglicher Praxis-Tipp" />
      </div>

      <div>
        <label className="label" htmlFor="recipe">
          Rezept – so sollen die Shorts aussehen
        </label>
        <textarea id="recipe" name="recipe" required rows={12} defaultValue={a?.recipe ?? draft?.recipe ?? ""} className="input font-mono text-xs leading-relaxed" />
        <p className="mt-1 text-xs text-muted">
          Jeder Lauf startet frisch mit diesem Rezept. Claude prüft das Backlog und wählt jedes Mal ein neues Thema. Briefing und Referenzen aus PROJEKT.md
          gelten zusätzlich.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="time">
            Uhrzeit
          </label>
          <input id="time" type="time" name="time" required defaultValue={a?.time ?? "06:00"} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="shortsPerRun">
            Shorts pro Lauf
          </label>
          <select id="shortsPerRun" name="shortsPerRun" defaultValue={String(a?.shortsPerRun ?? 1)} className="input">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="sm:col-span-3">
          <legend className="label">Wochentage</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {WEEKDAY_SHORT.map((d, i) => (
              <label key={d} className="flex items-center gap-1">
                <input type="checkbox" name="weekdays" value={i + 1} defaultChecked={weekdays.includes(i + 1)} /> {d}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <input type="checkbox" name="autoSchedule" defaultChecked={a?.autoSchedule ?? true} className="mt-1" />
          <span>
            Neue Shorts danach in freie Posting-Zeiten einplanen
            <span className="block text-xs text-muted">Sie landen unter „Warteschlange → Zur Freigabe“ – online gehen sie erst, wenn du freigibst.</span>
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="enabled" defaultChecked={a?.enabled ?? true} /> Aktiv
        </label>
      </div>

      <div className="text-right">
        <SubmitButton className="btn btn-primary">{a ? "Speichern" : "Automation anlegen"}</SubmitButton>
      </div>
    </form>
  );
}
