import { Composition } from "remotion";
import { Demo, DEMO_FPS, DEMO_FRAMES } from "./Demo";

export const RemotionRoot = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={DEMO_FRAMES}
    fps={DEMO_FPS}
    width={2880}
    height={1800}
  />
);
