import Link from "next/link";
import type { ReactNode } from "react";
import { PLATFORM_LABEL } from "@/lib/accounts";
import type { Platform, PostTarget } from "@/lib/db/schema";
import { DISPLAY_LABEL, TARGET_LABEL, type DisplayState } from "@/lib/posts";

type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "accent";

const TONE: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
  info: "bg-info-bg text-info",
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent text-accent-fg",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>{children}</span>;
}

const DISPLAY_TONE: Record<DisplayState, Tone> = {
  review: "warn",
  planned: "info",
  platform: "info",
  uploading: "info",
  published: "ok",
  partial: "warn",
  failed: "bad",
  cancelled: "neutral",
};

export function StateBadge({ state }: { state: DisplayState }) {
  return <Badge tone={DISPLAY_TONE[state]}>{DISPLAY_LABEL[state]}</Badge>;
}

const TARGET_TONE: Record<PostTarget["state"], Tone> = {
  pending: "neutral",
  uploading: "info",
  scheduled: "info",
  published: "ok",
  failed: "bad",
  missed: "bad",
  cancelled: "neutral",
};

export function TargetBadge({ state }: { state: PostTarget["state"] }) {
  return <Badge tone={TARGET_TONE[state]}>{TARGET_LABEL[state]}</Badge>;
}

const PLATFORM_STYLE: Record<Platform, { short: string; cls: string }> = {
  youtube: { short: "YT", cls: "bg-[#c4302b] text-white" },
  instagram: { short: "IG", cls: "bg-[#b1367d] text-white" },
  tiktok: { short: "TT", cls: "bg-[#111] text-white dark:bg-white dark:text-black" },
  linkedin: { short: "IN", cls: "bg-[#0a66c2] text-white" },
  simulator: { short: "T", cls: "bg-surface-2 text-muted border border-line" },
};

export function PlatformChip({ platform, title }: { platform: Platform; title?: string }) {
  const s = PLATFORM_STYLE[platform];
  return (
    <span
      title={title ?? PLATFORM_LABEL[platform]}
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[10px] font-bold leading-none ${s.cls}`}
    >
      {s.short}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div role="status" className={`mb-5 rounded-lg px-4 py-2.5 text-sm ${error ? "bg-bad-bg text-bad" : "bg-ok-bg text-ok"}`}>
      {error ?? ok}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted">
      <div>{children}</div>
      {action}
    </div>
  );
}

export function Tabs({ tabs, active }: { tabs: { key: string; label: string; href: string; count?: number }[]; active: string }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
            t.key === active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
          }`}
        >
          {t.label}
          {t.count ? <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">{t.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}

export function VideoPreview({ contentId, className = "" }: { contentId: number; className?: string }) {
  return (
    <video
      src={`/api/media/${contentId}`}
      controls
      preload="metadata"
      playsInline
      className={`aspect-[9/16] w-full rounded-lg bg-black object-contain ${className}`}
    />
  );
}

/** Wandelt ?ok=…&fehler=… in Props für <Flash>. */
export async function flashFrom(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return { ok: one(sp.ok), error: one(sp.fehler) };
}
