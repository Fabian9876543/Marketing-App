"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Übersicht" },
  { href: "/kalender", label: "Kalender" },
  { href: "/warteschlange", label: "Warteschlange", badgeKey: "review" as const },
  { href: "/backlog", label: "Backlog" },
  { href: "/konten", label: "Konten" },
  { href: "/einstellungen", label: "Einstellungen" },
];

export function Nav({ reviewCount, workerAlive }: { reviewCount: number; workerAlive: boolean }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="flex flex-col gap-4 md:h-full">
      <Link href="/" className="flex items-center gap-2 px-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-fg">F</span>
        <span className="text-sm font-semibold leading-tight">
          Fokuspilot
          <br />
          <span className="font-normal text-muted">Studio</span>
        </span>
      </Link>
      <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {ITEMS.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className={`flex shrink-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                isActive(item.href) ? "bg-surface font-medium text-fg shadow-sm ring-1 ring-line" : "text-muted hover:bg-surface hover:text-fg"
              }`}
            >
              {item.label}
              {item.badgeKey && reviewCount > 0 && (
                <span className="rounded-full bg-warn-bg px-1.5 text-xs font-medium text-warn">{reviewCount}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href="/einstellungen#worker"
        className="mt-auto hidden items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-surface md:flex"
        title="Der Worker veröffentlicht im Hintergrund"
      >
        <span className={`h-2 w-2 rounded-full ${workerAlive ? "bg-ok" : "bg-bad"}`} />
        {workerAlive ? "Worker läuft" : "Worker gestoppt"}
      </Link>
    </nav>
  );
}
