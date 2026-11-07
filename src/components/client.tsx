"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

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
