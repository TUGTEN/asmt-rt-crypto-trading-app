package main

// scenario_test.go — behavior tests for the scenario injector (SPEC bullet 4
// "hardening", story 20; issue #6).
//
// Behavior only: a REST call arms a scenario, scripted ticks follow it, and the
// assertions are on what the rest of the app can observe — the trades the tape
// gets, the book seq numbers a socket chains on, the candles the chart draws,
// and whether the injector is disarmed again afterwards. Nothing here reads the
// injector's internals.
//
// The last test pins the other half of the contract: with nothing armed, the
// feed is byte-for-byte the seeded market it was before the injector existed.

import (
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// postScenario issues the injector request the way the debug control does: a
// JSON body, over the handler under test.
func postScenario(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/scenario", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// armedScenario reads the injector's answer off the wire. A disarmed injector
// answers `"scenario":null` — checked on the raw bytes, because "there is no
// scenario" and "the field is missing" have to be different things to a client.
func armedScenario(t *testing.T, rec *httptest.ResponseRecorder) *Scenario {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/scenario status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	out := decode[scenarioResponse](t, rec)
	return out.Scenario
}

func TestScenarioEndpointReportsWhatIsArmedAndRefusesUnknownNames(t *testing.T) {
	feed := NewFeed(11)
	h := newHandler(testConfig(), feed)

	// Nothing armed: the injector says so rather than inventing a scenario.
	disarmed := get(t, h, "/api/scenario")
	if !strings.Contains(disarmed.Body.String(), `"scenario":null`) {
		t.Fatalf("GET /api/scenario with nothing armed = %s, want \"scenario\":null", disarmed.Body.String())
	}
	if s := armedScenario(t, disarmed); s != nil {
		t.Fatalf("armed scenario = %q, want none", string(*s))
	}

	// Every documented name is accepted and echoed back, and GET agrees.
	for _, name := range []string{"spike", "halt", "gap", "burst"} {
		rec := postScenario(t, h, `{"scenario":"`+name+`"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST scenario %q status = %d, want %d (body: %s)", name, rec.Code, http.StatusOK, rec.Body.String())
		}
		got := armedScenario(t, rec)
		if got == nil || string(*got) != name {
			t.Fatalf("POST scenario %q answered %v, want %q", name, got, name)
		}
		current := armedScenario(t, get(t, h, "/api/scenario"))
		if current == nil || string(*current) != name {
			t.Fatalf("after arming %q, GET /api/scenario = %v, want %q", name, current, name)
		}
	}

	// clear disarms: the injector goes back to reporting no scenario at all.
	rec := postScenario(t, h, `{"scenario":"clear"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST scenario clear status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := armedScenario(t, rec); got != nil {
		t.Fatalf("after clear, scenario = %q, want null", string(*got))
	}
	if got := armedScenario(t, get(t, h, "/api/scenario")); got != nil {
		t.Fatalf("after clear, GET /api/scenario = %q, want null", string(*got))
	}

	// Unusable input is refused with the vocabulary, like a bad interval.
	for _, body := range []string{`{"scenario":"earthquake"}`, `{"scenario":""}`, `{}`, `not json`} {
		bad := postScenario(t, h, body)
		if bad.Code != http.StatusBadRequest {
			t.Fatalf("POST %s status = %d, want %d", body, bad.Code, http.StatusBadRequest)
		}
		if err := decode[errorResponse](t, bad); err.Error == "" {
			t.Fatalf("POST %s error body = %s, want {\"error\":\"...\"}", body, bad.Body.String())
		}
	}
	// A refused name leaves the injector exactly as it was.
	if got := feed.ArmedScenario(); got != "" {
		t.Fatalf("after refused names the feed is armed with %q, want nothing", got)
	}
	if got := feed.Snapshot().Seq; got != 0 {
		t.Fatalf("refused scenario advanced the book to seq %d; it must not touch the market", got)
	}
}

// TestScenarioSpikeJumpsTenSigmasUpThenResumesDiffusion pins the spike: one
// upward step of ten times the diffusion's per-tick sigma on the next tick,
// after which the market diffuses normally again.
func TestScenarioSpikeJumpsTenSigmasUpThenResumesDiffusion(t *testing.T) {
	start := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	feed, control := NewFeed(7), NewFeed(7)

	// Control: the same seed with nothing injected, so the only difference
	// between the two prices is the jump itself.
	controlTrades := scriptTicks(control, start, 1, time.Second)
	controlPrice := mustFloat(t, controlTrades[0][len(controlTrades[0])-1].Price)

	// The same first tick on the injected feed: the jump lands before the
	// trades of that tick, so the tape and the candle show it.
	if err := feed.ArmScenario("spike"); err != nil {
		t.Fatalf("arm spike: %v", err)
	}
	if feed.ArmedScenario() != ScenarioSpike {
		t.Fatal("spike is not armed before the tick")
	}
	spikeTrades := scriptTicks(feed, start, 1, time.Second)[0]
	if len(spikeTrades) == 0 {
		t.Fatal("the spike tick printed no trades; the jump must land in the tape")
	}

	want := math.Exp(spikeSigmas * tickSigma)
	got := mustFloat(t, spikeTrades[len(spikeTrades)-1].Price) / controlPrice
	// Money crosses the wire with 2 decimals, so the ratio carries that
	// rounding (a couple of parts in 10^7 at this price); 1e-6 still tells a
	// ten-sigma step from the nine- or eleven-sigma ones around it.
	if math.Abs(got-want)/want > 1e-6 {
		t.Fatalf("spike moved price by %.10f, want %.10f (10 sigma up)", got, want)
	}
	_, _, spikeLast := feed.Active()
	_, _, controlLast := control.Active()
	if mustFloat(t, spikeLast.Price) <= mustFloat(t, controlLast.Price) {
		t.Fatalf("spike last price %s is not above the untouched stream's %s", spikeLast.Price, controlLast.Price)
	}

	// The jump is a price event, not an extra draw: quantities still come from
	// the same seeded stream, so the market's diffusion is untouched by it.
	if got, want := spikeTrades[len(spikeTrades)-1].Qty, controlTrades[0][len(controlTrades[0])-1].Qty; got != want {
		t.Fatalf("spike tick qty = %q, want the seeded stream's %q", got, want)
	}

	// One-shot: the injector is disarmed, and the next tick diffuses normally.
	if got := feed.ArmedScenario(); got != "" {
		t.Fatalf("after the jump the feed reports %q, want disarmed", got)
	}
	next := scriptTicks(feed, start.Add(time.Second), 1, time.Second)[0]
	if len(next) < 1 || len(next) > 3 {
		t.Fatalf("the tick after the spike printed %d trades, want the seeded 1-3", len(next))
	}
	nextControl := scriptTicks(control, start.Add(time.Second), 1, time.Second)[0]
	ratio := mustFloat(t, next[len(next)-1].Price) / mustFloat(t, nextControl[len(nextControl)-1].Price)
	if math.Abs(ratio-want)/want > 1e-6 {
		t.Fatalf("post-spike diffusion ratio = %.10f, want the jump still carried and nothing more: %.10f", ratio, want)
	}
}

// TestScenarioHaltSilencesTheTapeForFiveSecondsThenResumes pins the halt: the
// book keeps being served, finished and live candles stop moving, no trade
// crosses the tape for 5s, and then the market comes back on its own.
func TestScenarioHaltSilencesTheTapeForFiveSecondsThenResumes(t *testing.T) {
	start := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	feed := NewFeed(21)
	h := newHandler(testConfig(), feed)

	scriptTicks(feed, start, 1, time.Second) // one normal tick before the halt
	frozen1s, frozen1m, lastBefore := feed.Active()
	bookBefore := feed.Snapshot()

	if rec := postScenario(t, h, `{"scenario":"halt"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST scenario halt status = %d, want %d", rec.Code, http.StatusOK)
	}

	const step = 100 * time.Millisecond
	quiet, bookSeq := 0, bookBefore.Seq
	halt := start.Add(time.Second)
	for i := 0; i < 50; i++ { // 0 .. 4.9s after the halt begins
		now := halt.Add(time.Duration(i) * step)
		trades, delta := feed.Tick(now)
		if len(trades) != 0 {
			t.Fatalf("halt tick %d at %v printed %d trades, want a quiet tape", i, now, len(trades))
		}
		if delta.Seq <= bookSeq {
			t.Fatalf("halt tick %d left the book at seq %d (was %d); depth must still be served", i, delta.Seq, bookSeq)
		}
		if len(delta.Bids) != 10 || len(delta.Asks) != 10 {
			t.Fatalf("halt tick %d served %d bids / %d asks, want 10x10", i, len(delta.Bids), len(delta.Asks))
		}
		bookSeq = delta.Seq
		if feed.TradesSince(lastBefore.Seq, 64) != nil {
			t.Fatalf("halt tick %d handed the tape trades, want none", i)
		}
		// Candles flat: no trade means no new value, live or finished.
		if got1s, got1m, gotLast := feed.Active(); got1s != frozen1s || got1m != frozen1m || gotLast != lastBefore {
			t.Fatalf("halt tick %d moved the candles or the last trade: %+v", i, got1s)
		}
		quiet++
	}
	if quiet != 50 {
		t.Fatalf("quiet ticks = %d, want 50", quiet)
	}
	if got := feed.CandleCount(time.Second); got != 0 {
		t.Fatalf("halt finished %d 1s candles, want none", got)
	}

	// The 5s window ends by itself: the injector disarms and trades resume.
	resumedAt := halt.Add(haltQuiet)
	resumed, _ := feed.Tick(resumedAt)
	if len(resumed) == 0 {
		t.Fatal("the tick at 5s printed no trades; the halt must end on its own")
	}
	if got := feed.ArmedScenario(); got != "" {
		t.Fatalf("after the 5s window the feed reports %q, want disarmed", got)
	}
	// The chart picks the market back up: the live candle is the resumed bucket
	// and closes on the resumed stream's last trade.
	live := activeCandle(t, feed, time.Second)
	if want := bucket(resumedAt, time.Second); live.T != want {
		t.Fatalf("after the halt the live 1s candle is bucket %q, want %q", live.T, want)
	}
	if want := resumed[len(resumed)-1].Price; live.C != want {
		t.Fatalf("after the halt the live 1s candle close = %q, want the resumed trade's %q", live.C, want)
	}
}

// activeCandle reads one interval's live candle the way the chart stream does.
func activeCandle(t *testing.T, f *Feed, d time.Duration) Candle {
	t.Helper()
	_, live, _ := f.CandlesSince(d, f.CandleCount(d))
	return live
}

// TestScenarioClearEndsARunningHaltImmediately pins the escape hatch: a halt is
// a window, not a trap — clear returns the market to the seed now.
func TestScenarioClearEndsARunningHaltImmediately(t *testing.T) {
	start := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	feed := NewFeed(31)
	h := newHandler(testConfig(), feed)

	if rec := postScenario(t, h, `{"scenario":"halt"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST scenario halt status = %d, want %d", rec.Code, http.StatusOK)
	}
	if trades, _ := feed.Tick(start); len(trades) != 0 {
		t.Fatalf("first halt tick printed %d trades, want none", len(trades))
	}
	if trades, _ := feed.Tick(start.Add(time.Second)); len(trades) != 0 {
		t.Fatalf("second halt tick printed %d trades, want none", len(trades))
	}

	if rec := postScenario(t, h, `{"scenario":"clear"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST scenario clear status = %d, want %d", rec.Code, http.StatusOK)
	}
	if trades, _ := feed.Tick(start.Add(2 * time.Second)); len(trades) == 0 {
		t.Fatal("clear did not end the halt; the next tick was still quiet")
	}
	if got := feed.ArmedScenario(); got != "" {
		t.Fatalf("after clear the feed reports %q, want disarmed", got)
	}
}

// TestScenarioGapBreaksTheBookChainForOneFrame pins the gap at the socket,
// because that is where the break matters: the client is handed a frame whose
// prevSeq is not the seq it last applied, which is the recovery path
// docs/SEAMS.md Slice B describes; web/lib/book-sync.test.ts pins the client half with the injector's exact ids.
func TestScenarioGapBreaksTheBookChainForOneFrame(t *testing.T) {
	srv, feed, _ := wsFixture(t, 5, nil)
	start := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	h := newHandler(testConfig(), feed)

	// The client seeds its book from the REST snapshot; the stream starts at the
	// next change. base is the seq that snapshot carries.
	_, _ = feed.Tick(start)
	base := feed.Snapshot().Seq
	c := wsDial(t, srv.URL, "?topics=book")
	wsReadKind(t, c, "tier")

	// Healthy frames chain one-to-one: each parent is what this connection was
	// last told, and the seq increases by exactly the book changes since.
	_, _ = feed.Tick(start.Add(time.Second))
	first := wsReadKind(t, c, "book").book(t)
	if first.PrevSeq != base || first.Seq != base+1 {
		t.Fatalf("first book frame = {%d <- %d}, want {%d <- %d}", first.Seq, first.PrevSeq, base+1, base)
	}
	_, _ = feed.Tick(start.Add(2 * time.Second))
	healthy := wsReadKind(t, c, "book").book(t)
	if healthy.PrevSeq != first.Seq || healthy.Seq != first.Seq+1 {
		t.Fatalf("healthy book frame = {%d <- %d}, want {%d <- %d}", healthy.Seq, healthy.PrevSeq, first.Seq+1, first.Seq)
	}

	// Inject the gap: one tick, but the frame that follows skips seq numbers.
	if rec := postScenario(t, h, `{"scenario":"gap"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST scenario gap status = %d, want %d", rec.Code, http.StatusOK)
	}
	_, _ = feed.Tick(start.Add(3 * time.Second))
	gapped := wsReadKind(t, c, "book").book(t)
	if gapped.PrevSeq == healthy.Seq {
		t.Fatalf("gapped frame {seq %d <- prevSeq %d} chains onto the applied seq: the injector must break the chain, not skip it", gapped.Seq, gapped.PrevSeq)
	}
	if got, want := gapped.PrevSeq, gapped.Seq-1; got != want {
		t.Fatalf("gapped frame claims parent %d, want the feed-space parent %d (an id never sent, so the client refetches)", got, want)
	}
	if got, want := gapped.Seq, healthy.Seq+1+gapSkip; got != want {
		t.Fatalf("gapped frame seq = %d, want %d: the frame must skip %d seq numbers", got, want, gapSkip)
	}

	// It is a one-frame break, not a shift: the next frame chains again.
	_, _ = feed.Tick(start.Add(4 * time.Second))
	after := wsReadKind(t, c, "book").book(t)
	if after.PrevSeq != gapped.Seq || after.Seq != gapped.Seq+1 {
		t.Fatalf("post-gap frame = {%d <- %d}, want {%d <- %d}", after.Seq, after.PrevSeq, gapped.Seq+1, gapped.Seq)
	}
	if got := feed.ArmedScenario(); got != "" {
		t.Fatalf("after the gap the feed reports %q, want disarmed", got)
	}
}

// TestScenarioBurstPrintsFiveHundredTradesInOneSecond pins the burst: a second
// of saturated tape, then the seeded rate again — and all of it arrives through
// the same read seam the WebSocket tape uses.
func TestScenarioBurstPrintsFiveHundredTradesInOneSecond(t *testing.T) {
	start := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	feed := NewFeed(41)
	h := newHandler(testConfig(), feed)

	if rec := postScenario(t, h, `{"scenario":"burst"}`); rec.Code != http.StatusOK {
		t.Fatalf("POST scenario burst status = %d, want %d", rec.Code, http.StatusOK)
	}

	const step = 100 * time.Millisecond
	total := 0
	for i := 0; i < 10; i++ {
		trades, _ := feed.Tick(start.Add(time.Duration(i) * step))
		if len(trades) != burstPerTick {
			t.Fatalf("burst tick %d printed %d trades, want %d", i, len(trades), burstPerTick)
		}
		if got := feed.ArmedScenario(); got != ScenarioBurst {
			t.Fatalf("burst tick %d reports %q, want the burst still in effect", i, got)
		}
		// Seq stays dense and ordered through the storm: a burst is more
		// trades, never renumbered ones.
		for j := 1; j < len(trades); j++ {
			if trades[j].Seq != trades[j-1].Seq+1 {
				t.Fatalf("burst tick %d seq jumped %d -> %d", i, trades[j-1].Seq, trades[j].Seq)
			}
		}
		total += len(trades)
	}
	if total != 500 {
		t.Fatalf("burst printed %d trades in one second, want ~500", total)
	}
	if got := len(feed.TradesSince(0, 1<<16)); got != 500 {
		t.Fatalf("TradesSince handed the tape %d of the burst's trades, want 500", got)
	}

	// The window closes on its own: seeded rate, injector disarmed.
	after, _ := feed.Tick(start.Add(time.Second))
	if len(after) < 1 || len(after) > 3 {
		t.Fatalf("the tick after the burst printed %d trades, want the seeded 1-3", len(after))
	}
	if got := feed.ArmedScenario(); got != "" {
		t.Fatalf("after the burst window the feed reports %q, want disarmed", got)
	}
}

// TestScenarioArmAndClearLeaveTheSeededStreamUntouched is the determinism
// guard: arming and clearing (and an armed scenario that never fires) must not
// perturb the seeded market at all, or every pinned determinism test in this
// package would depend on whether someone had touched the injector.
func TestScenarioArmAndClearLeaveTheSeededStreamUntouched(t *testing.T) {
	start := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	feed, control := NewFeed(99), NewFeed(99)

	first := 5
	gotFirst := scriptTicks(feed, start, first, time.Second)
	wantFirst := scriptTicks(control, start, first, time.Second)

	// Arm and clear every scenario without letting a tick happen: no window
	// opened, so nothing may have been consumed.
	for _, name := range []string{"spike", "halt", "gap", "burst"} {
		if err := feed.ArmScenario(name); err != nil {
			t.Fatalf("arm %q: %v", name, err)
		}
	}
	if err := feed.ArmScenario("clear"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if err := feed.ArmScenario("nonsense"); err == nil {
		t.Fatal("arming an unknown scenario was accepted")
	}
	if got := feed.ArmedScenario(); got != "" {
		t.Fatalf("injector reports %q after clear, want disarmed", got)
	}

	rest := 30
	gotRest := scriptTicks(feed, start.Add(time.Duration(first)*time.Second), rest, time.Second)
	wantRest := scriptTicks(control, start.Add(time.Duration(first)*time.Second), rest, time.Second)

	for _, pair := range []struct {
		label string
		got   [][]Trade
		want  [][]Trade
	}{{"before arming", gotFirst, wantFirst}, {"after clearing", gotRest, wantRest}} {
		if len(pair.got) != len(pair.want) {
			t.Fatalf("%s: %d ticks, want %d", pair.label, len(pair.got), len(pair.want))
		}
		for i := range pair.got {
			if len(pair.got[i]) != len(pair.want[i]) {
				t.Fatalf("%s: tick %d printed %d trades, want %d", pair.label, i, len(pair.got[i]), len(pair.want[i]))
			}
			for j, trade := range pair.got[i] {
				if trade.Seq != pair.want[i][j].Seq || trade.TS != pair.want[i][j].TS ||
					trade.Price != pair.want[i][j].Price || trade.Qty != pair.want[i][j].Qty {
					t.Fatalf("%s: tick %d trade %d = %+v, want the seeded %+v", pair.label, i, j, trade, pair.want[i][j])
				}
			}
		}
	}

	// Same book, too: the injector never touched the depth either.
	if got, want := feed.Snapshot(), control.Snapshot(); got.Seq != want.Seq || len(got.Bids) != 10 {
		t.Fatalf("book after injecting and clearing = seq %d, want the seeded seq %d", got.Seq, want.Seq)
	}
}
