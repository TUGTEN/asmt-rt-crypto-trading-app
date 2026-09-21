import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import eventsData from "../footage/events.json";

export const DEMO_FPS = 30;
// Frame canvas = the captured raster (2x retina). Overlays are authored in the
// app's own 1440x900 logical space and scaled up, so every size below matches
// what the UI itself uses.
const SCALE = 2;
const W = 1440 * SCALE;
const H = 900 * SCALE;

type ShotEvent = { frame: number; vt: number; card: string; sub: string };
type Action = { frame: number; vt: number; kind: "key" | "click"; text: string; x?: number; y?: number };

const data = eventsData as {
  duration: number;
  frames: number;
  fps: number;
  events: ShotEvent[];
  actions: Action[];
};
// vt = time in the FINAL video. Events are keyed to the frame they happened on,
// so the narration cannot drift from what is on screen.
const evts = [...data.events].sort((a, b) => a.vt - b.vt);
const acts = [...(data.actions ?? [])].sort((a, b) => a.vt - b.vt);

const TAKE_SECONDS = data.duration;
const ENDCARD_SECONDS = 5;
export const DEMO_FRAMES = Math.ceil((TAKE_SECONDS + ENDCARD_SECONDS) * DEMO_FPS);

// --- narration: shot cards plus a beat for every meaningful action ----------
function actionBeat(a: Action): ShotEvent | null {
  const base = { frame: a.frame, vt: a.vt };
  switch (a.text) {
    case "1m":
      return { ...base, card: "Interval → 1m", sub: "history re-seats on the new series, late 1s frames discarded" };
    case "1s":
      return { ...base, card: "Interval → 1s", sub: "back on microstructure, same live market" };
    case "minimal":
      return { ...base, card: "Tier forced: minimal", sub: "chart delivery at 0.25 Hz — candles aggregate unchanged" };
    case "degraded":
      return { ...base, card: "Tier forced: degraded", sub: "chart delivery at 1 Hz — tape and book keep full cadence" };
    case "automatic":
      return { ...base, card: "Override cleared: automatic", sub: "the backend resumes tiering from live latency reports" };
    case "curl gap":
      return { ...base, card: "Scenario armed: gap", sub: "the next book frame skips five ids — watch the seq readout" };
    case "curl spike":
      return { ...base, card: "Scenario armed: spike", sub: "a ten-sigma step lands on the next tick" };
    case "curl halt":
      return { ...base, card: "Scenario armed: halt", sub: "five seconds, no trades — candles flat, book seq advancing" };
    case "curl burst":
      return { ...base, card: "Scenario armed: burst", sub: "~500 trades in one second flood the tape, all sequenced" };
    default:
      return null; // backtick (debug gate) needs no narration of its own
  }
}

const barSegs: (ShotEvent & { from: number; to: number })[] = (() => {
  const all: ShotEvent[] = [...evts];
  for (const a of acts) {
    const beat = actionBeat(a);
    if (beat) all.push(beat);
  }
  all.sort((p, q) => p.vt - q.vt);
  // Same-timestamp collisions (proof card + next shot card) play in sequence:
  // the first holds 4s, then the second takes over.
  const deduped: ShotEvent[] = [];
  for (const e of all) {
    if (deduped.length > 0 && Math.abs(e.vt - deduped[deduped.length - 1].vt) < 0.05) {
      deduped.push({ ...e, vt: deduped[deduped.length - 1].vt + 4 });
    } else {
      deduped.push(e);
    }
  }
  return deduped.map((e, i) => ({
    ...e,
    from: e.vt,
    to: i + 1 < deduped.length ? deduped[i + 1].vt : TAKE_SECONDS,
  }));
})();

const fontMono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function NarrationBar({ card, sub }: { card: string; sub: string }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 104,
        backgroundColor: "#000",
        borderTop: "4px solid #4ade80",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 32px",
        opacity,
        fontFamily: fontMono,
      }}
    >
      <div style={{ color: "#fff", fontSize: 27, fontWeight: 700 }}>{card}</div>
      {sub ? <div style={{ color: "#a1a1aa", fontSize: 20, marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

function KeyCap({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const dur = 2.4 * DEMO_FPS;
  const opacity = interpolate(frame, [0, 6, dur - 10, dur], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        right: 24,
        bottom: 128,
        backgroundColor: "rgba(8, 18, 34, 0.92)",
        border: "2px solid #fbbf24",
        borderBottomWidth: 4,
        borderRadius: 10,
        padding: "14px 22px",
        fontFamily: fontMono,
        fontSize: 30,
        fontWeight: 700,
        color: "#fbbf24",
        opacity,
      }}
    >
      key: {text}
    </div>
  );
}

function ClickRipple({ x, y, text }: { x: number; y: number; text: string }) {
  const frame = useCurrentFrame();
  const dur = 0.8 * DEMO_FPS;
  const u = Math.min(frame / dur, 1);
  // x/y arrive in captured raster coordinates; the overlay layer is logical.
  const cx = x / SCALE;
  const cy = y / SCALE;
  return (
    <div
      style={{
        position: "absolute",
        left: cx - 26 * u - 8,
        top: cy - 26 * u - 8,
        width: 16 + 52 * u,
        height: 16 + 52 * u,
        borderRadius: "50%",
        border: "3px solid #4ade80",
        opacity: 1 - u,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -30,
          left: "50%",
          transform: "translateX(-50%)",
          fontFamily: fontMono,
          fontSize: 15,
          color: "#4ade80",
          whiteSpace: "nowrap",
          opacity: 1 - u,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function EndCard({ startFrame }: { startFrame: number }) {
  const frame = useCurrentFrame();
  const local = frame - startFrame;
  const opacity = interpolate(local, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "rgba(4, 10, 22, 0.88)",
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: fontMono,
      }}
    >
      <div style={{ color: "#f1f5f9", fontSize: 52, fontWeight: 800 }}>
        Pitchfork — live BTC-USD demo
      </div>
      <div style={{ color: "#4ade80", fontSize: 24, marginTop: 18 }}>
        seeded market · adaptive delivery · self-healing book
      </div>
      <div style={{ color: "#94a3b8", fontSize: 19, marginTop: 30 }}>
        silent take · captured with Playwright · composed with Remotion
      </div>
    </div>
  );
}

export const Demo = () => {
  const endStart = Math.floor(TAKE_SECONDS * DEMO_FPS);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <OffthreadVideo src={staticFile("take.mp4")} style={{ width: W, height: H }} muted />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1440,
          height: 900,
          transform: `scale(${SCALE})`,
          transformOrigin: "top left",
        }}
      >
        {barSegs.map((s, i) => (
          <Sequence
            key={i}
            from={Math.round(s.from * DEMO_FPS)}
            durationInFrames={Math.max(1, Math.round((s.to - s.from) * DEMO_FPS))}
          >
            <NarrationBar card={s.card} sub={s.sub} />
          </Sequence>
        ))}
        {acts.map((a, i) =>
          a.kind === "key" && a.text.startsWith("curl") ? null : a.kind === "key" ? (
            <Sequence
              key={`a${i}`}
              from={Math.round(a.vt * DEMO_FPS)}
              durationInFrames={Math.round(2.4 * DEMO_FPS)}
            >
              <KeyCap text={a.text} />
            </Sequence>
          ) : (
            <Sequence
              key={`a${i}`}
              from={Math.round(a.vt * DEMO_FPS)}
              durationInFrames={Math.round(0.8 * DEMO_FPS)}
            >
              <ClickRipple x={a.x ?? 720} y={a.y ?? 450} text={a.text} />
            </Sequence>
          )
        )}
        <Sequence from={endStart} durationInFrames={DEMO_FRAMES - endStart}>
          <EndCard startFrame={endStart} />
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};
