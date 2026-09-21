// capture.mjs — automated silent take v5.
//
// Recording: Chrome DevTools Protocol screencast, PNG frames, 2880x1800.
//
// Why this instead of Playwright's recordVideo: recordVideo encodes VP8 at a
// fixed low bitrate, which is what smeared the UI text. The screencast hands us
// LOSSLESS PNG frames at whatever the page paints, so the only encode in the
// pipeline is ours (ffmpeg, high bitrate).
//
// Resolution: headless Chromium caps the screencast at CSS pixels (it ignores
// deviceScaleFactor, and pads Playwright's video when the sizes disagree). So
// the retina frame comes from laying the page out in a 2880x1800 CSS viewport
// with `zoom: 2` on the root: the app still lays out as a 1440x900 screen, but
// every logical pixel rasterizes into 2 device pixels.
//
// Timing: events are keyed to the FRAME they happened on, never to wall clock.
// The screencast only emits frames when the page paints, so video time and wall
// time drift apart; frame keys keep the narration glued to what is on screen.
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const API = process.env.API_URL ?? "http://localhost:8080";
const REPO = new URL("..", import.meta.url).pathname;
const OUT = new URL("./footage/", import.meta.url).pathname;
const FRAMES = OUT + "frames/";
const SCALE = 2; // page zoom = raster scale
const W = 1440 * SCALE;
const H = 900 * SCALE;
const FPS = 30;

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const api = (path, opts) =>
  fetch(`${API}${path}`, opts).then((r) => {
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  });
const scenario = (name) =>
  api("/api/scenario", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: name }),
  });
const compose = (args) =>
  execSync(`docker compose ${args}`, { cwd: REPO, stdio: "pipe" }).toString();

console.log("preflight: waiting for >=60 finished 1s candles…");
for (let i = 0; i < 30; i++) {
  const h = await api("/api/history?interval=1s&limit=120").catch(() => null);
  const n = h?.candles?.length ?? 0;
  console.log(`  candles: ${n}`);
  if (n >= 60) break;
  await sleep(10_000);
}

const browser = await chromium.launch({
  channel: "chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

let frames = 0;
let recording = false;
const stamps = [];
const pendingWrites = [];

const events = [];
const actions = [];
const now = () => +((Date.now() - startedAt) / 1000).toFixed(2);
let startedAt = 0;
const mark = (card, sub = "") => {
  const e = { frame: frames, t: now(), card, sub };
  events.push(e);
  console.log(`[f${frames}] ${card}${sub ? " — " + sub : ""}`);
};
const act = (kind, text, x, y) => {
  actions.push({ frame: frames, t: now(), kind, text, ...(x === undefined ? {} : { x, y }) });
  console.log(`[f${frames}] ${kind} ${text}${x === undefined ? "" : ` @${x},${y}`}`);
};

const stageClick = async (locator, label) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${label}`);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(Math.max(0, x - 260), Math.max(0, y + 92), { steps: 22 });
  await sleep(600); // beat: cursor staged beside its target
  await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.click(x, y);
  act("click", label, x, y);
};
const restNear = (x, y, dx = 300, dy = 120) =>
  page.mouse.move(Math.min(W - 16, Math.max(16, x + dx)), Math.min(H - 16, Math.max(16, y + dy)), {
    steps: 18,
  });
const key = async (label, press) => {
  await page.keyboard.press(press);
  act("key", label);
};
const frameTop = () => page.evaluate(() => window.scrollTo(0, 0));

// --- screencast recorder ---------------------------------------------------
cdp.on("Page.screencastFrame", async (f) => {
  const idx = frames;
  const ack = () => cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  if (recording) {
    frames++;
    stamps.push({ ts: f.metadata.timestamp, at: Date.now() });
    // Async: a blocking write here delays the ack and makes Chrome drop frames.
    pendingWrites.push(
      writeFile(`${FRAMES}f${String(idx).padStart(6, "0")}.png`, Buffer.from(f.data, "base64")).catch(
        (err) => console.error("frame write failed:", err.message)
      )
    );
  }
  await ack();
});

await page.goto(WEB, { waitUntil: "networkidle" });
// 2x rasterization without changing the app's layout size.
await page.addStyleTag({ content: `html { zoom: ${SCALE}; }` });
// Repaint pump: the screencast only emits a frame when the compositor produces
// one, so a screen that stops changing (backend down, a forced slow tier) would
// otherwise be compressed on the timeline instead of holding. A 1x1 px, nearly
// invisible transform animation keeps frames coming at a steady cadence.
await page.addStyleTag({
  content: `
    @keyframes pfKeepAlive { from { transform: translateX(0) } to { transform: translateX(2px) } }
    #pf-keepalive {
      position: fixed; left: 0; bottom: 0; width: 1px; height: 1px;
      background: #000; opacity: 0.01; pointer-events: none; z-index: 2147483647;
      animation: pfKeepAlive 0.4s linear infinite alternate;
    }`
});
await page.evaluate(() => {
  const el = document.createElement("div");
  el.id = "pf-keepalive";
  document.body.appendChild(el);
});
await page.getByText("live", { exact: false }).first().waitFor({ timeout: 30_000 });
await frameTop();
await sleep(1000);

await cdp.send("Page.startScreencast", {
  format: "png",
  maxWidth: W,
  maxHeight: H,
  everyNthFrame: 1,
});
await page.mouse.move(1400, 1640, { steps: 12 });
await sleep(2000);
recording = true;
startedAt = Date.now();

// Shot 1 — live chart, hover a finished candle mid-shot
mark("1/6 — Live BTC-USD · seed 42", "history loads first, the live candle never stops");
await sleep(7000);
{
  const box = await page.getByRole("application", { name: /candle chart/i }).boundingBox();
  const hx = box.x + box.width * 0.62, hy = box.y + box.height * 0.45;
  await page.mouse.move(hx - 220, hy + 80, { steps: 18 });
  await sleep(500);
  await page.mouse.move(hx, hy, { steps: 12 });
  await sleep(5000); // hold: crosshair + OHLCV readout open
  await restNear(hx, hy);
}
await sleep(6000);

// Shot 2 — interval change
mark("2/6 — Interval switch", "1s ⇄ 1m: one series at a time, no ghost candles");
{
  const group = page.getByRole("group", { name: "Candle interval" });
  await stageClick(group.getByRole("button", { name: "1m" }), "1m");
  await sleep(9000);
  await stageClick(group.getByRole("button", { name: "1s" }), "1s");
  await sleep(8000);
}

// Shot 3 — book gap (debug stays closed: the book owns the right column)
await frameTop();
mark("3/6 — Book gap → snapshot refetch", "five ids skipped: the seq jumps, the book refetches");
await scenario("gap");
act("key", "curl gap");
await sleep(12000);
mark("seq +6 · refetch + resume", "a corrupt book is never rendered");

// Shot 4 — DEBUG open only now, force tiers, close again
mark("4/6 — Forced tier · backend owns tier", "the chart slows to 0.25 Hz, candles stay identical");
await key("`", "`");
await sleep(1600);
{
  const group = page.getByRole("group", { name: "Force delivery tier" });
  await group.scrollIntoViewIfNeeded();
  await stageClick(group.getByRole("button", { name: "minimal", exact: true }), "minimal");
  await sleep(11000);
  await stageClick(group.getByRole("button", { name: "degraded", exact: true }), "degraded");
  await sleep(6000);
  await stageClick(group.getByRole("button", { name: "automatic", exact: true }), "automatic");
  await sleep(6000);
}
await key("`", "`");
await frameTop();
await sleep(2000);

// Shot 5 — disconnect recovery
mark("5/6 — Backend down · stale-while-dark", "cached values stay up, labelled stale — never live");
compose("stop api");
await sleep(8000);
mark("reconnecting…", "backoff, resubscribe, fresh snapshot, history re-read");
compose("start api");
await page.getByText("live", { exact: false }).first().waitFor({ timeout: 90_000 });
await frameTop();
await sleep(10000);
mark("recovered", "same seed, fresh market, history refills");

// Shot 6 — bonus injector trio
await frameTop();
mark("6/6 — Injector · deterministic edges", "spike, halt, burst — one command each");
for (const [name, hold] of [["spike", 8000], ["halt", 9000], ["burst", 8000]]) {
  await scenario(name);
  act("key", `curl ${name}`);
  await sleep(hold);
}
await scenario("clear");
await sleep(4000);

recording = false;
await cdp.send("Page.stopScreencast");
await Promise.all(pendingWrites);
console.log(`take done: ${frames} frames, wall clock ${now()}s`);
await context.close();
await browser.close();

// --- video timeline --------------------------------------------------------
// Video time of frame i = sum of the durations of the frames before it.
// A frame lasts until the next one arrived, measured on the WALL CLOCK: the
// demo's pacing is real time (a nine-second outage is nine seconds of video),
// and a quiet screen holds its last frame instead of being compressed away.
// The screencast's own timestamps are unusable here — they run ~10% ahead of
// its wall clock and stall when nothing repaints.
const CLAMP_MIN = 1 / 60;
const CLAMP_MAX = 3; // a hung paint must not swallow the take
const videoAt = (() => {
  const t = new Array(stamps.length).fill(0);
  for (let i = 1; i < stamps.length; i++) {
    const wallDelta = (stamps[i].at - stamps[i - 1].at) / 1000;
    const d = Math.min(Math.max(wallDelta, CLAMP_MIN), CLAMP_MAX);
    t[i] = t[i - 1] + d;
  }
  return t;
})();
const duration = (videoAt[videoAt.length - 1] + CLAMP_MIN).toFixed(2);

// write the frame list for the encoder
const list = videoAt
  .map((_, i) => {
    const next = i + 1 < videoAt.length ? videoAt[i + 1] : videoAt[i] + CLAMP_MIN;
    const dur = Math.max(next - videoAt[i], CLAMP_MIN);
    return `file '${FRAMES}f${String(i).padStart(6, "0")}.png'\nduration ${dur.toFixed(5)}`;
  })
  .join("\n");
writeFileSync(
  FRAMES + "frames.txt",
  list + `\nfile '${FRAMES}f${String(videoAt.length - 1).padStart(6, "0")}.png'\n`
);

const vt = (frame) => +(videoAt[Math.min(frame, videoAt.length - 1)] ?? 0).toFixed(2);
const outEvents = events.map((e) => ({ ...e, vt: vt(e.frame) }));
const outActions = actions.map((a) => ({ ...a, vt: vt(a.frame) }));

// Video-time positions drive the narration; wall time is kept for reference.
const ordered = [...outEvents, ...outActions].sort((a, b) => a.vt - b.vt);
writeFileSync(
  new URL("./footage/events.json", import.meta.url),
  JSON.stringify(
    {
      duration: +duration,
      frames: videoAt.length,
      fps: +(videoAt.length / +duration).toFixed(1),
      events: outEvents,
      actions: outActions,
      timeline: ordered.map((e) => ({ vt: e.vt, frame: e.frame, card: e.card ?? e.text })),
    },
    null,
    2
  )
);

// --- encode: PNG frames -> high-bitrate H.264 ------------------------------
console.log(`encoding ${videoAt.length} frames (${duration}s)…`);
execSync(
  `ffmpeg -y -v error -f concat -safe 0 -i ${FRAMES}frames.txt -fps_mode cfr -r ${FPS} ` +
    `-c:v libx264 -crf 12 -preset medium -pix_fmt yuv420p ${OUT}take.mp4`,
  { stdio: "inherit" }
);
rmSync(FRAMES, { recursive: true, force: true });
console.log("footage:", readdirSync(OUT));
