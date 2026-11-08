import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import defaultBrand from "../brand.json";

export const FPS = 30;

/* ---------- Datenformat (siehe README.md) ---------- */

export type Brand = {
  name: string;
  primary: string;
  accent: string;
  background: string;
  text: string;
  font: string;
  /** Schriftdatei in public/, z. B. "schrift.woff2" (optional) */
  fontFile: string;
  /** Logo in public/, z. B. "logo.png" (optional) */
  logo: string;
  url: string;
};

/** Sprecher-Spur: MP3 in public/ (z. B. „stimme/hook.mp3“ vom Werkzeug stimme_erzeugen) */
export type Voice = string | { src: string; volume?: number; delay?: number };

/** Felder, die jede Szene haben kann */
type Common = {
  seconds?: number;
  /** Sprechertext zur Szene, startet mit der Szene (plus „delay“ in Sekunden) */
  voice?: Voice;
};

export type DialogLine = {
  who: string;
  text: string;
  side?: "links" | "rechts";
  /** Sprecher-Spur dieser Zeile (startet, wenn die Sprechblase erscheint) */
  voice?: string;
  /** Erscheint nach so vielen Sekunden ab Szenenbeginn (Standard: gleichmäßig verteilt) */
  at?: number;
};

export type Scene = Common &
  (
    | { type: "hook"; text: string; sub?: string }
    | { type: "text"; title?: string; lines: string[] }
    | { type: "bild"; src: string; caption?: string; zoom?: boolean }
    | { type: "video"; src: string; caption?: string; startAt?: number; muted?: boolean }
    | { type: "dialog"; title?: string; lines: DialogLine[] }
    | { type: "cta"; text: string; sub?: string; url?: string }
  );

export type ShortProps = {
  brand?: Partial<Brand>;
  scenes: Scene[];
  /** Hintergrundmusik in public/, z. B. { "src": "musik.mp3", "volume": 0.3 } – mit Sprecher automatisch leiser (0,12) */
  music?: { src: string; volume?: number };
  /** Logo oben links einblenden (Standard: an, wenn ein Logo gesetzt ist) */
  logoCorner?: boolean;
  /** Fortschrittsbalken oben (Standard: an) */
  progressBar?: boolean;
};

const DEFAULT_SECONDS: Record<Scene["type"], number> = { hook: 2.5, text: 4, bild: 3.5, video: 5, dialog: 6, cta: 3 };
export const sceneSeconds = (s: Scene) => s.seconds ?? DEFAULT_SECONDS[s.type];
export const totalSeconds = (p: ShortProps) => (p.scenes ?? []).reduce((t, s) => t + sceneSeconds(s), 0);

/** Dateien aus public/ (oder vollständige URLs) */
const asset = (p: string) => (/^https?:\/\//.test(p) ? p : staticFile(p.replace(/^\/+/, "")));

/** Kommt irgendwo ein Sprecher vor? (Dann läuft die Musik leiser.) */
export const hasVoice = (p: ShortProps) => (p.scenes ?? []).some((s) => s.voice || (s.type === "dialog" && s.lines.some((l) => l.voice)));

function VoiceTrack({ voice }: { voice: Voice }) {
  const { fps } = useVideoConfig();
  const v = typeof voice === "string" ? { src: voice } : voice;
  return (
    <Sequence from={Math.round((v.delay ?? 0) * fps)} layout="none" name="Stimme">
      <Audio src={asset(v.src)} volume={v.volume ?? 1} />
    </Sequence>
  );
}

/* ---------- Bausteine ---------- */

/** Sichtbarer Bereich ohne die Bedienelemente der Apps (oben ~8 %, unten ~20 %, rechts ~10 %). */
const SAFE: CSSProperties = { position: "absolute", top: 170, bottom: 400, left: 80, right: 140, display: "flex", flexDirection: "column", justifyContent: "center" };

function useAppear(delay = 0) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px)` };
}

function Appear({ delay = 0, children, style }: { delay?: number; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...useAppear(delay), ...style }}>{children}</div>;
}

function Caption({ text, brand }: { text: string; brand: Brand }) {
  return (
    <div style={{ position: "absolute", left: 80, right: 140, bottom: 440, display: "flex", justifyContent: "center" }}>
      <Appear delay={6}>
        <div style={{ background: brand.background, color: brand.text, padding: "22px 34px", borderRadius: 28, fontSize: 56, fontWeight: 700, lineHeight: 1.2, textAlign: "center" }}>
          {text}
        </div>
      </Appear>
    </div>
  );
}

/* ---------- Szenen ---------- */

function HookScene({ s, brand }: { s: Extract<Scene, { type: "hook" }>; brand: Brand }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, mass: 0.6 } });
  return (
    <AbsoluteFill style={{ background: brand.primary }}>
      <div style={SAFE}>
        <div style={{ transform: `scale(${interpolate(pop, [0, 1], [0.8, 1])})`, opacity: pop, color: brand.text, fontSize: 112, fontWeight: 900, lineHeight: 1.05, letterSpacing: -2 }}>
          {s.text}
        </div>
        {s.sub && (
          <Appear delay={10} style={{ marginTop: 40 }}>
            <div style={{ color: brand.accent, fontSize: 60, fontWeight: 700 }}>{s.sub}</div>
          </Appear>
        )}
      </div>
    </AbsoluteFill>
  );
}

function TextScene({ s, brand }: { s: Extract<Scene, { type: "text" }>; brand: Brand }) {
  const { fps } = useVideoConfig();
  const step = Math.max(8, Math.floor(((sceneSeconds(s) - 1) * fps) / Math.max(1, s.lines.length)));
  return (
    <AbsoluteFill style={{ background: brand.background }}>
      <div style={SAFE}>
        {s.title && (
          <Appear>
            <div style={{ color: brand.accent, fontSize: 64, fontWeight: 800, marginBottom: 48 }}>{s.title}</div>
          </Appear>
        )}
        {s.lines.map((line, i) => (
          <Appear key={i} delay={6 + i * step} style={{ marginBottom: 36 }}>
            <div style={{ color: brand.text, fontSize: 68, fontWeight: 700, lineHeight: 1.15 }}>{line}</div>
          </Appear>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function ImageScene({ s, brand }: { s: Extract<Scene, { type: "bild" }>; brand: Brand }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = s.zoom === false ? 1 : interpolate(frame, [0, sceneSeconds(s) * fps], [1, 1.08]);
  return (
    <AbsoluteFill style={{ background: brand.background, alignItems: "center", justifyContent: "center" }}>
      <Img src={asset(s.src)} style={{ width: "100%", height: "100%", objectFit: "contain", transform: `scale(${scale})` }} />
      {s.caption && <Caption text={s.caption} brand={brand} />}
    </AbsoluteFill>
  );
}

function VideoScene({ s, brand }: { s: Extract<Scene, { type: "video" }>; brand: Brand }) {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <OffthreadVideo
        src={asset(s.src)}
        startFrom={Math.round((s.startAt ?? 0) * fps)}
        muted={s.muted ?? false}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
      {s.caption && <Caption text={s.caption} brand={brand} />}
    </AbsoluteFill>
  );
}

function DialogScene({ s, brand }: { s: Extract<Scene, { type: "dialog" }>; brand: Brand }) {
  const { fps } = useVideoConfig();
  const step = Math.max(10, Math.floor(((sceneSeconds(s) - 1) * fps) / Math.max(1, s.lines.length)));
  const sides = [...new Set(s.lines.map((l) => l.who))];
  // Zeitpunkt jeder Zeile: „at“ (Sekunden) oder gleichmäßig verteilt
  const startOf = (line: DialogLine, i: number) => (line.at != null ? Math.round(line.at * fps) : 6 + i * step);
  return (
    <AbsoluteFill style={{ background: brand.background }}>
      <div style={SAFE}>
        {s.title && (
          <Appear>
            <div style={{ color: brand.accent, fontSize: 56, fontWeight: 800, marginBottom: 40 }}>{s.title}</div>
          </Appear>
        )}
        {s.lines.map((line, i) => {
          const right = line.side ? line.side === "rechts" : sides.indexOf(line.who) % 2 === 1;
          return (
            <Appear key={i} delay={startOf(line, i)} style={{ display: "flex", justifyContent: right ? "flex-end" : "flex-start", marginBottom: 28 }}>
              <div style={{ maxWidth: "82%" }}>
                <div style={{ color: brand.text, opacity: 0.7, fontSize: 34, fontWeight: 600, marginBottom: 8, textAlign: right ? "right" : "left" }}>{line.who}</div>
                <div
                  style={{
                    background: right ? brand.primary : "rgba(255,255,255,0.12)",
                    color: brand.text,
                    fontSize: 50,
                    fontWeight: 600,
                    lineHeight: 1.25,
                    padding: "24px 32px",
                    borderRadius: 34,
                    borderTopLeftRadius: right ? 34 : 8,
                    borderTopRightRadius: right ? 8 : 34,
                  }}
                >
                  {line.text}
                </div>
              </div>
            </Appear>
          );
        })}
      </div>
      {s.lines.map((line, i) =>
        line.voice ? (
          <Sequence key={`v${i}`} from={startOf(line, i)} layout="none" name={`Stimme ${line.who}`}>
            <Audio src={asset(line.voice)} />
          </Sequence>
        ) : null,
      )}
    </AbsoluteFill>
  );
}

function CtaScene({ s, brand }: { s: Extract<Scene, { type: "cta" }>; brand: Brand }) {
  const url = s.url ?? brand.url;
  return (
    <AbsoluteFill style={{ background: brand.primary }}>
      <div style={{ ...SAFE, alignItems: "center", textAlign: "center" }}>
        {brand.logo && (
          <Appear>
            <Img src={asset(brand.logo)} style={{ width: 260, height: 260, objectFit: "contain", marginBottom: 56 }} />
          </Appear>
        )}
        <Appear delay={6}>
          <div style={{ color: brand.text, fontSize: s.text.length > 28 ? 76 : 88, fontWeight: 900, lineHeight: 1.08, maxWidth: "100%" }}>{s.text}</div>
        </Appear>
        {s.sub && (
          <Appear delay={12} style={{ marginTop: 32 }}>
            <div style={{ color: brand.text, opacity: 0.85, fontSize: 52, fontWeight: 600 }}>{s.sub}</div>
          </Appear>
        )}
        {url && (
          <Appear delay={18} style={{ marginTop: 56 }}>
            <div style={{ background: brand.accent, color: brand.background, fontSize: 54, fontWeight: 800, padding: "20px 44px", borderRadius: 999 }}>{url}</div>
          </Appear>
        )}
      </div>
    </AbsoluteFill>
  );
}

function SceneView({ s, brand }: { s: Scene; brand: Brand }) {
  switch (s.type) {
    case "hook":
      return <HookScene s={s} brand={brand} />;
    case "text":
      return <TextScene s={s} brand={brand} />;
    case "bild":
      return <ImageScene s={s} brand={brand} />;
    case "video":
      return <VideoScene s={s} brand={brand} />;
    case "dialog":
      return <DialogScene s={s} brand={brand} />;
    case "cta":
      return <CtaScene s={s} brand={brand} />;
  }
}

/* ---------- Komposition ---------- */

export const Short = (props: ShortProps) => {
  const brand: Brand = { ...(defaultBrand as Brand), ...(props.brand ?? {}) };
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const [fontHandle] = useState(() => (brand.fontFile ? delayRender("Schrift laden") : null));

  useEffect(() => {
    if (fontHandle === null) return;
    const face = new FontFace("BrandFont", `url(${asset(brand.fontFile)})`);
    face
      .load()
      .then((f) => document.fonts.add(f))
      .catch(() => undefined)
      .finally(() => continueRender(fontHandle));
  }, [fontHandle, brand.fontFile]);

  let from = 0;
  const sequences = (props.scenes ?? []).map((s, i) => {
    const len = Math.max(1, Math.round(sceneSeconds(s) * fps));
    const seq = (
      <Sequence key={i} from={from} durationInFrames={len} name={`${i + 1}: ${s.type}`}>
        <SceneView s={s} brand={brand} />
        {s.voice && <VoiceTrack voice={s.voice} />}
      </Sequence>
    );
    from += len;
    return seq;
  });

  return (
    <AbsoluteFill
      lang="de"
      style={{
        background: brand.background,
        fontFamily: brand.fontFile ? `BrandFont, ${brand.font}` : brand.font,
        // Nur lange Wörter (ab 10 Zeichen) trennen, statt sie über den Rand laufen zu lassen
        hyphens: "auto",
        overflowWrap: "break-word",
        ...({ hyphenateLimitChars: "10 4 4" } as CSSProperties),
      }}
    >
      {sequences}
      {props.music && <Audio src={asset(props.music.src)} volume={props.music.volume ?? (hasVoice(props) ? 0.12 : 0.3)} />}
      {brand.logo && props.logoCorner !== false && (
        <Img src={asset(brand.logo)} style={{ position: "absolute", top: 70, left: 70, width: 120, height: 120, objectFit: "contain" }} />
      )}
      {props.progressBar !== false && (
        <div style={{ position: "absolute", top: 0, left: 0, height: 10, width: `${(frame / Math.max(1, durationInFrames - 1)) * 100}%`, background: brand.accent }} />
      )}
    </AbsoluteFill>
  );
};
