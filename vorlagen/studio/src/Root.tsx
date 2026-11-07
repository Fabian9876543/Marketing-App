import { Composition } from "remotion";
import beispiel from "../beispiele/beispiel.json";
import { FPS, Short, totalSeconds, type ShortProps } from "./Short";

/**
 * Eine Komposition „Short“: 1080 × 1920 (9:16), 30 Bilder/s.
 * Die Länge ergibt sich aus den Szenen. Rendern:
 *   npx remotion render src/index.ts Short ../backlog/<ordner>/video.mp4 --props=<datei.json>
 */
export const RemotionRoot = () => (
  <Composition
    id="Short"
    component={Short}
    width={1080}
    height={1920}
    fps={FPS}
    durationInFrames={FPS * 10}
    defaultProps={beispiel as ShortProps}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(FPS, Math.round(totalSeconds(props) * FPS)) })}
  />
);
