"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

/** Lädt die Server-Daten der Seite regelmäßig neu (z. B. solange eine Prüfung im Hintergrund läuft). */
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}

/** Absende-Button, der während der Server-Aktion deaktiviert ist. */
export function SubmitButton({
  children,
  className = "btn",
  pendingText = "Einen Moment …",
  confirm,
  name,
  value,
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  pendingText?: string;
  /** Rückfrage vor dem Absenden */
  confirm?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={className}
      disabled={pending || disabled}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? pendingText : children}
    </button>
  );
}
