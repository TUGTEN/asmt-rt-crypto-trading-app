package main

// candle_test.go — behavior tests for live candle frames and tiered delivery
// (SPEC Bullet 2/3, SEAMS Slice A/C, issues #4 and #5).
//
// The graded property lives here: a slow tier may receive fewer, later frames,
// but every finished candle it receives must be byte-identical to the one a
// full-tier connection got from the same seeded stream. Throttling delays
// delivery; it never re-values a candle.

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// candle re-reads a frame through the same struct the server writes, so a test
// never hand-rolls a shape the wire might not have.
func (f wsFrame) candle(t *testing.T) candleFrame {
	t.Helper()
	var out candleFrame
	if err := json.Unmarshal(f.raw, &out); err != nil {
		t.Fatalf("candle frame does not match the documented shape: %v\n%s", err, f.raw)
	}
	return out
}

// assertCandle checks one candle frame's wire shape — the subscribed interval,
// a UTC bucket timestamp, decimal strings with the documented places — and
// returns it for the value assertions.
func assertCandle(t *testing.T, frame wsFrame, interval string) candleFrame {
	t.Helper()
	if frame.kind() != "candle" {
		t.Fatalf("frame = %q, want candle (raw: %s)", frame.kind(), frame.raw)
	}
	c := frame.candle(t)
	if c.Interval != interval {
		t.Errorf("candle.interval = %q, want the subscription's %q", c.Interval, interval)
	}
	// The tuple carries `complete` at [8]: it must be a real boolean on the wire,
	// not a string or a missing entry the struct defaulted.
	if complete, ok := frame.tupleAt(t, 8).(bool); !ok {
		t.Errorf("candle[8] (complete) = %#v, want a boolean (raw: %s)", complete, frame.raw)
	}
	if _, err := time.Parse(time.RFC3339Nano, c.T); err != nil {
		t.Errorf("candle.t = %q, want UTC ISO-8601: %v", c.T, err)
	}
	if !strings.HasSuffix(c.T, "Z") {
		t.Errorf("candle.t = %q, want UTC (trailing Z)", c.T)
	}
	for label, v := range map[string]string{"o": c.O, "h": c.H, "l": c.L, "c": c.C} {
		if !priceRE.MatchString(v) {
			t.Errorf("candle.%s = %q, want a decimal string with 2 places", label, v)
		}
	}
	if !qtyRE.MatchString(c.V) {
		t.Errorf("candle.v = %q, want a decimal string with 6 places", c.V)
	}
	return c
}

// collectFinishedCandles reads candle frames until it has n finished ones,
// skipping the live refreshes in between: throttling delays frames, it never
// drops a finished candle.
func collectFinishedCandles(t *testing.T, c *websocket.Conn, n int) []wsFrame {
	t.Helper()
	var out []wsFrame
	for len(out) < n {
		frame := wsRead(t, c)
		if frame.kind() != "candle" {
			continue
		}
		if complete, _ := frame.tupleAt(t, 8).(bool); complete {
			out = append(out, frame)
		}
	}
	return out
}

func TestChartStreamsTheSubscribedIntervalAndFinishesEachBucket(t *testing.T) {
	srv, f, _ := wsFixture(t, 7, nil)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	// The feed is already trading before the socket opens: a chart subscriber
	// is told the live candle at once, rather than waiting for the next bucket
	// (SPEC story 5: there is never a dead chart).
	opened, _ := f.Tick(start)

	c := wsDial(t, srv.URL, "?topics=chart&interval=1s")
	wsReadKind(t, c, "tier")

	first := assertCandle(t, wsReadKind(t, c, "candle"), "1s")
	if first.Complete {
		t.Errorf("the live candle's first frame claims complete = true")
	}
	if want := bucket(start, time.Second); first.T != want {
		t.Fatalf("live candle bucket = %q, want %q", first.T, want)
	}

	// The next tick opens a new bucket, which finishes the previous one: the
	// connection is told the finished candle (complete = true) and then the new
	// live one. The finished frame is the settled candle the chart paints, and
	// its values are the aggregation of everything that traded in the bucket.
	f.Tick(start.Add(time.Second))
	finished := assertCandle(t, wsReadKind(t, c, "candle"), "1s")
	if !finished.Complete {
		t.Fatalf("the frame after the bucket rolled over has complete = false, want the finished bucket")
	}
	if want := bucket(start, time.Second); finished.T != want {
		t.Errorf("finished bucket = %q, want %q", finished.T, want)
	}
	if finished.O != opened[0].Price {
		t.Errorf("finished candle open = %q, want the bucket's first trade %q", finished.O, opened[0].Price)
	}
	if finished.C != opened[len(opened)-1].Price {
		t.Errorf("finished candle close = %q, want the bucket's last trade %q",
			finished.C, opened[len(opened)-1].Price)
	}
	hi, lo, vol := mustFloat(t, opened[0].Price), mustFloat(t, opened[0].Price), 0.0
	for _, tr := range opened {
		px := mustFloat(t, tr.Price)
		hi, lo, vol = max(hi, px), min(lo, px), vol+mustFloat(t, tr.Qty)
	}
	closeEnough(t, "finished candle high", mustFloat(t, finished.H), hi)
	closeEnough(t, "finished candle low", mustFloat(t, finished.L), lo)
	closeEnough(t, "finished candle volume", mustFloat(t, finished.V), vol)

	live := assertCandle(t, wsReadKind(t, c, "candle"), "1s")
	if live.Complete {
		t.Errorf("the live candle after a rollover claims complete = true")
	}
	if want := bucket(start.Add(time.Second), time.Second); live.T != want {
		t.Errorf("live bucket = %q, want %q", live.T, want)
	}

	// And it keeps happening: each tick finishes the previous bucket once.
	f.Tick(start.Add(2 * time.Second))
	next := assertCandle(t, wsReadKind(t, c, "candle"), "1s")
	if !next.Complete || next.T != bucket(start.Add(time.Second), time.Second) {
		t.Errorf("third bucket frame = %+v, want the finished %q",
			next, bucket(start.Add(time.Second), time.Second))
	}

	// The same live series serves 1m: the frame carries the subscription's
	// interval and the bucket the interval actually names.
	m := wsDial(t, srv.URL, "?topics=chart&interval=1m")
	wsReadKind(t, m, "tier")
	liveM := assertCandle(t, wsReadKind(t, m, "candle"), "1m")
	if liveM.Complete {
		t.Errorf("the live 1m candle claims complete = true")
	}
	if want := bucket(start, time.Minute); liveM.T != want {
		t.Errorf("live 1m bucket = %q, want %q", liveM.T, want)
	}

	f.Tick(start.Add(time.Minute))
	doneM := assertCandle(t, wsReadKind(t, m, "candle"), "1m")
	if !doneM.Complete || doneM.T != bucket(start, time.Minute) {
		t.Errorf("finished 1m candle = %+v, want the finished bucket %q", doneM, bucket(start, time.Minute))
	}
}

func TestEveryTierDeliversByteIdenticalFinishedCandles(t *testing.T) {
	// The headline claim of Bullet 3: a throttled connection is slower, never
	// wrong. Each tier runs the same seeded stream through its own connection
	// and the same scripted ticks, and the finished candles it is given have to
	// come out byte for byte identical.
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	const buckets = 5

	// The full tier's frames are the reference every other tier is held to.
	// Subtests run in order, so it is collected before they are compared.
	var reference []string

	for _, tier := range []Tier{TierFull, TierDegraded, TierMinimal} {
		t.Run(string(tier), func(t *testing.T) {
			srv, f, _ := wsFixture(t, 11, nil)
			c := wsDial(t, srv.URL, "?topics=chart&interval=1s")
			assertTierFrame(t, wsRead(t, c), TierFull)
			if tier != TierFull {
				// Full is where every connection starts, so only the slower
				// tiers need the debug control to pin them for the run.
				wsSend(t, c, `{"type":"force","tier":"`+string(tier)+`"}`)
				assertTierFrame(t, wsRead(t, c), tier)
			}

			// Six buckets of trades, ticked straight through: a slow tier has to
			// catch up on everything it held back, not just the newest frame.
			for i := 0; i <= buckets; i++ {
				f.Tick(start.Add(time.Duration(i) * time.Second))
			}

			frames := collectFinishedCandles(t, c, buckets)
			if len(frames) != buckets {
				t.Fatalf("finished candles = %d, want %d", len(frames), buckets)
			}

			got := make([]string, 0, len(frames))
			for i, frame := range frames {
				candle := assertCandle(t, frame, "1s")
				if !candle.Complete {
					t.Errorf("frame %d is not a finished candle", i)
				}
				if wantT := bucket(start.Add(time.Duration(i)*time.Second), time.Second); candle.T != wantT {
					t.Errorf("candle %d bucket = %q, want %q (oldest first, none skipped)",
						i, candle.T, wantT)
				}
				got = append(got, string(frame.raw))
			}

			if reference == nil {
				reference = got
				return
			}
			if !reflect.DeepEqual(got, reference) {
				for i := range reference {
					if got[i] != reference[i] {
						t.Errorf("candle %d =\n  %s\nwant the full tier's\n  %s", i, got[i], reference[i])
					}
				}
			}
		})
	}
}

func TestSlowerTiersHoldCandleFramesBack(t *testing.T) {
	// The visible half of the same feature: the tier's rate is what the badge
	// says it is. Four updates a second at full, one every four seconds at
	// minimal, from one feed at the same time.
	srv, f, _ := wsFixture(t, 5, nil)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	full := wsDial(t, srv.URL, "?topics=chart&interval=1s")
	wsReadKind(t, full, "tier")
	slow := wsDial(t, srv.URL, "?topics=chart&interval=1s")
	wsReadKind(t, slow, "tier")
	wsSend(t, slow, `{"type":"force","tier":"minimal"}`)
	wsReadKind(t, slow, "tier")

	// Both connections are told the live candle as soon as there is one...
	f.Tick(start)
	wsReadKind(t, full, "candle")
	wsReadKind(t, slow, "candle")

	// ...and then the market moves for three buckets. Before a second has
	// passed the minimal tier's next slot is still three seconds away, so it
	// must stay silent while the full tier keeps refreshing.
	for i := 1; i <= 3; i++ {
		f.Tick(start.Add(time.Duration(i) * time.Second))
		time.Sleep(60 * time.Millisecond)
	}

	if frames := wsOfKind(wsQuiet(t, full, 400*time.Millisecond), "candle"); len(frames) == 0 {
		t.Error("the full tier sent no candle frame while the market moved: 4Hz is the tier it announced")
	}
	if frames := wsOfKind(wsQuiet(t, slow, 400*time.Millisecond), "candle"); len(frames) != 0 {
		t.Errorf("the minimal tier sent %d candle frame(s) within a second of its last one, want none: 0.25Hz is one every four seconds",
			len(frames))
	}
}

func TestHeldBackCandlesArriveInOrderAndUnaltered(t *testing.T) {
	// The half of tiered delivery a rate limit could plausibly get wrong: a
	// frame that was held back must still be delivered, and delivered exactly
	// once. The slowest tier waits four seconds for its slot, so this test
	// spends about that long proving the wait costs neither a candle nor a
	// digit (SPEC story 14).
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	const buckets = 5

	// The reference run: same seed, same script, the fastest tier. Six buckets of
	// trades finish the first five.
	refSrv, refFeed, _ := wsFixture(t, 5, nil)
	ref := wsDial(t, refSrv.URL, "?topics=chart&interval=1s")
	assertTierFrame(t, wsRead(t, ref), TierFull)
	for i := 0; i <= buckets; i++ {
		refFeed.Tick(start.Add(time.Duration(i) * time.Second))
	}
	want := rawFrames(collectFinishedCandles(t, ref, buckets))

	// The same stream at the minimal tier.
	srv, f, _ := wsFixture(t, 5, nil)
	c := wsDial(t, srv.URL, "?topics=chart&interval=1s")
	assertTierFrame(t, wsRead(t, c), TierFull)
	wsSend(t, c, `{"type":"force","tier":"minimal"}`)
	assertTierFrame(t, wsRead(t, c), TierMinimal)

	// One tick first, so the connection has already spent its delivery slot on
	// a live candle — everything after this has to wait for the next one.
	f.Tick(start)
	assertCandle(t, wsReadKind(t, c, "candle"), "1s")
	for i := 1; i <= buckets; i++ {
		f.Tick(start.Add(time.Duration(i) * time.Second))
		time.Sleep(20 * time.Millisecond)
	}

	// Five finished candles are now waiting, and the slot is four seconds away.
	// The pong cannot jump the queue, so a candle frame that had been sent for
	// those ticks would already be in front of it.
	time.Sleep(150 * time.Millisecond)
	wsSend(t, c, `{"type":"ping","tSend":1}`)
	if frame := wsRead(t, c); frame.kind() != "pong" {
		t.Fatalf("the minimal tier sent a %q frame inside its hold window, want nothing before the pong (raw: %s)",
			frame.kind(), frame.raw)
	}

	// Then they arrive — every finished candle, in order, byte for byte what the
	// full tier was given (the last read waits out the slot, so this is the
	// timed assertion as well as the value one).
	got := rawFrames(collectFinishedCandles(t, c, buckets))
	if len(got) != len(want) {
		t.Fatalf("held-back candles = %d, want the full tier's %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("held-back candle %d =\n  %s\nwant the full tier's\n  %s", i, got[i], want[i])
		}
	}
}

// rawFrames reduces frames to the exact bytes the client received, which is what
// "identical" has to mean when two tiers are compared.
func rawFrames(frames []wsFrame) []string {
	out := make([]string, 0, len(frames))
	for _, frame := range frames {
		out = append(out, string(frame.raw))
	}
	return out
}

func TestLiveCandleFramesAgreeWithRESTHistory(t *testing.T) {
	// One series, two doors (SPEC story 21): the candles the chart is streamed
	// and the candles /api/history serves have to be the same numbers, or the
	// client's "history then extend live" story breaks at the seam.
	srv, f, _ := wsFixture(t, 13, nil)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	c := wsDial(t, srv.URL, "?topics=chart&interval=1s")
	wsReadKind(t, c, "tier")
	for i := 0; i < 5; i++ {
		f.Tick(start.Add(time.Duration(i) * time.Second))
	}

	streamed := collectFinishedCandles(t, c, 4)
	history := decode[historyResponse](t, get(t, newHandler(testConfig(), f), "/api/history?interval=1s&limit=4"))
	if len(history.Candles) != 4 {
		t.Fatalf("history candles = %d, want the 4 finished buckets the stream sent", len(history.Candles))
	}

	for i, frame := range streamed {
		live, want := assertCandle(t, frame, "1s"), history.Candles[i]
		if live.T != want.T || live.O != want.O || live.H != want.H ||
			live.L != want.L || live.C != want.C || live.V != want.V {
			t.Errorf("streamed candle %d = %+v, want the history endpoint's %+v", i, live, want)
		}
	}
}

func TestTradesAndBookAreNotThrottled(t *testing.T) {
	// The tape and the book are the tracer's own streams: a slowed connection
	// loses candle refresh rate, never market events. Trades are the atomic
	// truth (CONTEXT.md) — a client deriving its own state from them would
	// silently diverge if a tier could drop one.
	srv, f, _ := wsFixture(t, 3, nil)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	c := wsDial(t, srv.URL, "?topics=trades,book")
	wsReadKind(t, c, "tier")
	wsSend(t, c, `{"type":"force","tier":"minimal"}`)
	wsReadKind(t, c, "tier")

	published := 0
	for i := 0; i < 3; i++ {
		trades, _ := f.Tick(start.Add(time.Duration(i) * time.Second))
		published += len(trades)
	}

	frames := wsQuiet(t, c, 300*time.Millisecond)
	if got := len(wsOfKind(frames, "trade")); got != published {
		t.Errorf("the minimal tier received %d of the %d trades the feed published", got, published)
	}
	if got := len(wsOfKind(frames, "book")); got == 0 {
		t.Error("the minimal tier received no book frame at all")
	}
	if got := len(wsOfKind(frames, "candle")); got != 0 {
		t.Errorf("a connection without the chart topic received %d candle frame(s)", got)
	}
}
