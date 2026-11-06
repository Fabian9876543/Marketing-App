import type { Content, Platform } from "../db/schema";
import type { AppSettings } from "../settings";

/** Zeichen-Obergrenzen der Plattformen für den Begleittext. */
export const CAPTION_LIMIT: Record<Exclude<Platform, "youtube" | "simulator">, number> = {
  instagram: 2200,
  tiktok: 2200,
  linkedin: 3000,
};

const join = (...parts: (string | undefined | null)[]) =>
  parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join("\n\n");

/** Kürzt auf `max` Zeichen (Unicode-sicher) mit „…“. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Instagram erlaubt höchstens 30 Hashtags pro Beitrag. */
function limitHashtags(tags: string[], max: number): string {
  return tags.slice(0, max).join(" ");
}

/**
 * Begleittext für eine Plattform. Reihenfolge:
 * 1. eigener Text aus meta.json (platforms.<plattform>)
 * 2. sonst Beschreibung + Hashtags
 * Bei KI-Inhalten wird der KI-Hinweis angehängt, wo die Plattform keine eigene Kennzeichnung per API anbietet.
 */
export function captionFor(platform: "instagram" | "tiktok" | "linkedin", content: Content, settings: AppSettings): string {
  const pt = content.platformTexts;
  const own = platform === "linkedin" ? pt.linkedin?.text : pt[platform]?.caption;
  const ai = content.aiGenerated && platform !== "tiktok" ? settings.aiDisclosure : "";
  // TikTok-Direktposts kennzeichnen KI per Feld is_aigc; im Entwurfsmodus setzt du das Label in der App.
  const tiktokAi = content.aiGenerated && platform === "tiktok" && settings.tiktok.mode === "draft" ? settings.aiDisclosure : "";

  let text: string;
  if (own) text = join(own, ai || tiktokAi);
  else if (platform === "instagram") text = join(content.description || content.title, ai, limitHashtags(content.hashtags, 30));
  else if (platform === "tiktok") text = join(content.description || content.title, tiktokAi, content.hashtags.join(" "));
  else text = join(content.description || content.title, ai, content.hashtags.join(" "));

  return truncate(text, CAPTION_LIMIT[platform]);
}
