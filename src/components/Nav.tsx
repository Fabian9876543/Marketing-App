"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef } from "react";

type NavProject = { id: number; name: string; color: string };

export function Nav({
  projects,
  activeId,
  all,
  reviewCount,
  workerAlive,
  switchAction,
}: {
  projects: NavProject[];
  activeId: number | null;
  all: boolean;
  reviewCount: number;
  workerAlive: boolean;
  switchAction: (form: FormData) => Promise<void>;
}) {
  const path = usePathname();
  const tab = useSearchParams().get("tab");
  const formRef = useRef<HTMLFormElement>(null);
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href.split("?")[0]));
  const projectHref = activeId ? `/projekte/${activeId}` : "/projekte";

  const items = [
    { href: "/", label: "Übersicht" },
    { href: "/kalender", label: "Kalender" },
    { href: "/warteschlange", label: "Warteschlange", badge: reviewCount },
    { href: "/backlog", label: "Backlog" },
    { href: "/studio", label: "Studio" },
    { href: "/zahlen", label: "Zahlen" },
    { href: "/recherche", label: "Recherche" },
    { href: activeId ? `/projekte/${activeId}?tab=referenzen` : "/projekte", label: "Referenzen", match: "referenzen" },
    { href: "/konten", label: "Konten" },
    { href: projectHref, label: "Projekt", match: "projekt" },
  ];
  const highlight = (item: (typeof items)[number]) => {
    if (item.match === "referenzen") return path.startsWith("/projekte/") && tab === "referenzen";
    if (item.match === "projekt") return path.startsWith("/projekte/") && tab !== "referenzen" && path !== "/projekte/neu";
    return isActive(item.href);
  };

  return (
    <nav className="flex flex-col gap-4 md:h-full">
      <Link href="/" className="flex items-center gap-2 px-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-fg">M</span>
        <span className="text-sm font-semibold leading-tight">
          Marketing
          <br />
          <span className="font-normal text-muted">Studio</span>
        </span>
      </Link>

      {projects.length > 0 ? (
        <form ref={formRef} action={switchAction} className="px-1">
          <input type="hidden" name="back" value={path} />
          <label className="label px-1" htmlFor="projekt-wahl">
            Projekt
          </label>
          <select
            id="projekt-wahl"
            name="projekt"
            defaultValue={all ? "alle" : String(activeId ?? "")}
            onChange={() => formRef.current?.requestSubmit()}
            className="input py-1.5 font-medium"
          >
            {projects.length > 1 && <option value="alle">Alle Projekte</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <noscript>
            <button className="btn mt-1 w-full">Wechseln</button>
          </noscript>
        </form>
      ) : (
        <Link href="/projekte/neu" className="btn btn-primary mx-1">
          Erstes Projekt anlegen
        </Link>
      )}

      <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {items.map((item) => (
          <li key={item.label}>
            <Link
              href={item.href}
              className={`flex shrink-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                highlight(item) ? "bg-surface font-medium text-fg shadow-sm ring-1 ring-line" : "text-muted hover:bg-surface hover:text-fg"
              }`}
            >
              {item.label}
              {item.badge ? <span className="rounded-full bg-warn-bg px-1.5 text-xs font-medium text-warn">{item.badge}</span> : null}
            </Link>
          </li>
        ))}
      </ul>

      <ul className="flex gap-1 overflow-x-auto border-line md:mt-auto md:flex-col md:border-t md:pt-3">
        {[
          { href: "/projekte", label: "Alle Projekte", exact: true },
          { href: "/einstellungen", label: "Einstellungen" },
        ].map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className={`flex shrink-0 rounded-lg px-2.5 py-1.5 text-sm ${
                (item.exact ? path === item.href || path === "/projekte/neu" : isActive(item.href))
                  ? "bg-surface font-medium text-fg shadow-sm ring-1 ring-line"
                  : "text-muted hover:bg-surface hover:text-fg"
              }`}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href="/einstellungen#worker"
        className="hidden items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-surface md:flex"
        title="Der Worker veröffentlicht im Hintergrund"
      >
        <span className={`h-2 w-2 rounded-full ${workerAlive ? "bg-ok" : "bg-bad"}`} />
        {workerAlive ? "Worker läuft" : "Worker gestoppt"}
      </Link>
    </nav>
  );
}
