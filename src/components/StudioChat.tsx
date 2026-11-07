"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SubmitButton } from "./client";

type Message = { id: number; kind: "user" | "assistant" | "tool" | "tool_result" | "result" | "error" | "info"; text: string; toolName: string | null; isError: boolean };
type RunInfo = { id: number; state: "queued" | "running" | "done" | "error" | "cancelled"; error: string | null; newShorts: string[]; cancelRequested: boolean } | null;

const ACTIVE = (r: RunInfo) => r?.state === "queued" || r?.state === "running";

/** Live-Verlauf eines Studio-Chats: holt neue Nachrichten, solange Claude arbeitet. */
export function StudioChat({
  sessionId,
  initialMessages,
  initialRun,
  sendAction,
  cancelAction,
}: {
  sessionId: number;
  initialMessages: Message[];
  initialRun: RunInfo;
  sendAction: (form: FormData) => Promise<void>;
  cancelAction: (form: FormData) => Promise<void>;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [run, setRun] = useState(initialRun);
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = messages.at(-1)?.id ?? 0;
  const active = ACTIVE(run);

  // Beim Wechsel des Chats bzw. nach dem Absenden neu übernehmen
  useEffect(() => {
    setMessages(initialMessages);
    setRun(initialRun);
  }, [sessionId, initialMessages, initialRun]);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/studio/${sessionId}?after=${lastId}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const data = (await res.json()) as { messages: Message[]; run: RunInfo };
        if (data.messages.length) setMessages((m) => [...m, ...data.messages.filter((n) => !m.some((x) => x.id === n.id))]);
        setRun(data.run);
        if (!ACTIVE(data.run)) router.refresh(); // Seitenleiste und Backlog-Hinweise aktualisieren
      } catch {
        // nächster Versuch beim nächsten Intervall
      }
    }, 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [active, sessionId, lastId, router]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="flex min-h-[60vh] flex-col">
      <ol className="flex-1 space-y-3">
        {messages.map((m) => (
          <MessageItem key={m.id} m={m} />
        ))}
        {active && (
          <li className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            {run?.state === "queued" ? "Wartet auf den Worker …" : run?.cancelRequested ? "Wird abgebrochen …" : "Claude arbeitet …"}
          </li>
        )}
        {!active && run?.state === "done" && run.newShorts.length > 0 && (
          <li className="card flex flex-wrap items-center justify-between gap-2 border-ok-bg bg-ok-bg/40 p-3 text-sm">
            <span>
              {run.newShorts.length === 1 ? "1 neuer Short" : `${run.newShorts.length} neue Shorts`} im Backlog: {run.newShorts.join(", ")}
            </span>
            <Link href="/backlog" className="btn">
              Zum Backlog
            </Link>
          </li>
        )}
        <div ref={bottom} />
      </ol>

      <div className="sticky bottom-0 mt-4 border-t border-line bg-bg pt-3">
        <form action={sendAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="back" value={`/studio?chat=${sessionId}`} />
          <textarea
            name="prompt"
            rows={2}
            required
            disabled={active}
            placeholder={active ? "Claude arbeitet gerade …" : "Rückmeldung oder nächster Auftrag, z. B. „Mach den Hook kürzer“"}
            className="input flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
          />
          <SubmitButton className="btn btn-primary" pendingText="Sende …">
            Senden
          </SubmitButton>
        </form>
        {active && (
          <form action={cancelAction} className="mt-2">
            <input type="hidden" name="sessionId" value={sessionId} />
            <input type="hidden" name="back" value={`/studio?chat=${sessionId}`} />
            <SubmitButton className="btn btn-danger" confirm="Auftrag abbrechen?">
              Abbrechen
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}

function MessageItem({ m }: { m: Message }) {
  switch (m.kind) {
    case "user":
      return (
        <li className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent px-4 py-2.5 text-sm text-accent-fg">{m.text}</div>
        </li>
      );
    case "assistant":
      return (
        <li className="flex">
          <div className="card max-w-[92%] whitespace-pre-wrap px-4 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]">{m.text}</div>
        </li>
      );
    case "tool":
      return (
        <li className="flex items-start gap-2 pl-2 text-xs text-muted">
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono">{m.toolName}</span>
          <span className="min-w-0 whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">{m.text}</span>
        </li>
      );
    case "tool_result":
      return m.isError ? (
        <li className="pl-2 text-xs">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bad-bg p-2 font-mono text-bad">{m.text || "Fehler"}</pre>
        </li>
      ) : m.text ? (
        <li className="pl-2 text-xs text-muted">
          <details>
            <summary className="cursor-pointer select-none">Ergebnis</summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono">{m.text}</pre>
          </details>
        </li>
      ) : null;
    case "result":
      return <li className="text-center text-xs text-ok">{m.text}</li>;
    case "info":
      return <li className="text-center text-xs text-muted">{m.text}</li>;
    case "error":
      return (
        <li>
          <div className="rounded-lg bg-bad-bg px-4 py-2.5 text-sm text-bad">{m.text}</div>
        </li>
      );
  }
}
