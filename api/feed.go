package main

// feed.go — synthetic market generator: seeded GBM trades, derived book, one
// candle series per interval (live bucket + finished buckets), and the
// append-only trade log the tape and replay read.
//
// The same generator also carries the scenario injector (ArmScenario): an
// operator can script a spike, halt, gap, or burst onto the seeded market for
// the recording and for tests (SPEC bullet 4, story 20). Injection is state, not
// a second generator — every scenario is a named rewrite of one tick's shape,
// so with nothing armed the feed is exactly as deterministic as its seed says.
// TRACER NOTE: deltas carry the full 10x10 image (seq/prevSeq still hold, so
// gap detection is exercisable); wire-efficient diffs are a full-build step.

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"
)

// tickSigma is the per-tick GBM volatility (~0.02%), and so the unit the
// injector measures its "10-sigma" jump in.
const tickSigma = 0.0002

// Scenario is a scripted market event injected over REST (POST /api/scenario)
// for demos, the recording, and tests (SPEC bullet 4, story 20). It is a name,
// not a parameter bag: the point is that one curl command produces a known,
// assertable market shape.
type Scenario string

const (
	ScenarioSpike Scenario = "spike" // 10-sigma step up on the next tick, then normal diffusion
	ScenarioHalt  Scenario = "halt"  // 5s without trades: book still served, candles flat
	ScenarioGap   Scenario = "gap"   // next book frame skips seq numbers: a legitimate prevSeq break
	ScenarioBurst Scenario = "burst" // ~500 trades in the next second
	ScenarioClear Scenario = "clear" // disarm: back to the seeded market
)

// Scenario shape constants. These are the vocabulary of the demo, not
// deployment configuration: they are what "spike", "halt", "gap" and "burst"
// mean, and other numbers would be different scenarios. spikeSigmas and
// tickSigma are the same sigma the diffusion uses, so the jump is honestly a
// ten-sigma move — outside the range the seeded stream walks on its own.
const (
	spikeSigmas  = 10              // upward jump, fired once
	haltQuiet    = 5 * time.Second // how long a halt keeps the tape empty
	gapSkip      = 5               // seq numbers the injected frame jumps over
	burstWindow  = time.Second     // duration of the print storm
	burstPerTick = 50              // x 10 ticks (100ms heartbeat) ~= 500 trades/second
)

// scenarioNames is the accepted vocabulary, in the order the 400 body lists it.
var scenarioNames = []Scenario{ScenarioSpike, ScenarioHalt, ScenarioGap, ScenarioBurst, ScenarioClear}

// scenarioState is the injector's whole state. The zero value means "nothing
// injected", which is the only state the seed alone produces.
type scenarioState struct {
	name Scenario // armed or in effect; "" = plain seeded market

	spikeNext bool // fire the jump on the next tick
	gapNext   bool // skip book seq numbers on the next tick

	haltUntil  time.Time // trades are suppressed while now < haltUntil
	burstUntil time.Time // burst-sized ticks while now < burstUntil

	// Windows open on the first tick after the request (not on the request), so
	// the shape a scenario produces does not depend on where in the 100ms
	// heartbeat the operator happened to press the button.
	haltArmed  bool
	burstArmed bool
}

type Trade struct {
	Seq   uint64 `json:"seq"`
	TS    string `json:"ts"` // UTC ISO-8601
	Price string `json:"price"`
	Qty   string `json:"qty"`
	// float twins, wire-excluded, for aggregation
	px float64
	qy float64
}

// Level crosses the wire as a compact tuple `["price","qty"]` (PROTOCOL.md
// protocol v2): positions [0]=price, [1]=qty, both decimal strings. Only the
// key names are dropped, never the string encoding — no float precision risk.
type Level struct {
	Price string `json:"price"`
	Qty   string `json:"qty"`
}

// MarshalJSON writes the tuple form.
func (l Level) MarshalJSON() ([]byte, error) {
	return json.Marshal([2]string{l.Price, l.Qty})
}

// UnmarshalJSON reads the tuple form.
func (l *Level) UnmarshalJSON(data []byte) error {
	var t [2]string
	if err := json.Unmarshal(data, &t); err != nil {
		return err
	}
	l.Price, l.Qty = t[0], t[1]
	return nil
}

type Book struct {
	Seq  uint64  `json:"seq"`
	Bids []Level `json:"bids"`
	Asks []Level `json:"asks"`
}

// Candle crosses the wire as a compact tuple `["t","o","h","l","c","v"]`
// (PROTOCOL.md protocol v2): positions [0]=t … [5]=v, OHLCV decimal strings.
type Candle struct {
	T string `json:"t"` // bucket start, UTC ISO-8601
	O string `json:"o"`
	H string `json:"h"`
	L string `json:"l"`
	C string `json:"c"`
	V string `json:"v"`
	// aggregation state, wire-excluded
	ot, hi, lo, ct, vt float64
	complete           bool
}

// MarshalJSON writes the tuple form.
func (c Candle) MarshalJSON() ([]byte, error) {
	return json.Marshal([6]string{c.T, c.O, c.H, c.L, c.C, c.V})
}

// UnmarshalJSON reads the tuple form.
func (c *Candle) UnmarshalJSON(data []byte) error {
	var t [6]string
	if err := json.Unmarshal(data, &t); err != nil {
		return err
	}
	c.T, c.O, c.H, c.L, c.C, c.V = t[0], t[1], t[2], t[3], t[4], t[5]
	return nil
}

type Feed struct {
	mu      sync.RWMutex
	rng     *rand.Rand
	price   float64
	tradeTx uint64
	bookTx  uint64
	book    Book
	trades  []Trade // append-only log; tracer keeps all (short runs)

	// Candles are kept as one series per interval: `live` is the bucket in
	// progress and `done` the finished ones, oldest first (append-only, like the
	// trade log). Both history and the live chart stream read this series, so a
	// throttled connection can never be told a different OHLCV than REST
	// history serves.
	live map[time.Duration]*Candle
	done map[time.Duration][]Candle

	// Scenario injection state (Bullet 4 hardening), guarded by mu like the rest
	// of the feed: an injected scenario is market state, not an out-of-band side
	// channel.
	sc scenarioState

	last Trade
}

func NewFeed(seed int64) *Feed {
	return &Feed{
		rng:   rand.New(rand.NewSource(seed)),
		price: 65000,
		live:  map[time.Duration]*Candle{},
		done:  map[time.Duration][]Candle{},
	}
}

// Tick advances the market ~100ms: 1-3 GBM trades, re-derived book, live candles.
//
// An armed scenario rewrites one step of that shape — no trades for a halt, a
// burst's worth for a burst, a price jump before the trades of a spike — and is
// then gone: the seeded stream it hands back is the one the seed describes.
func (f *Feed) Tick(now time.Time) (newTrades []Trade, delta Book) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.applyScenario(now)
	for i := 0; i < f.tradesThisTick(now); i++ {
		// GBM step: P *= exp(-sig^2/2 + sig*Z), sig ~= 0.02%/tick
		z := f.rng.NormFloat64()
		f.price *= math.Exp(-0.5*tickSigma*tickSigma + tickSigma*z)
		q := 0.001 + f.rng.ExpFloat64()*0.004
		f.tradeTx++
		t := Trade{Seq: f.tradeTx, px: f.price, qy: q,
			TS:    now.UTC().Format(time.RFC3339Nano),
			Price: p2s(f.price), Qty: q2s(q)}
		f.trades = append(f.trades, t)
		newTrades = append(newTrades, t)
		f.last = t
		f.live[time.Second] = f.accum(f.live[time.Second], t, now, time.Second)
		f.live[time.Minute] = f.accum(f.live[time.Minute], t, now, time.Minute)
	}
	f.deriveBook()
	return newTrades, f.book
}

// deriveBook re-derives the full 10x10 image around the current price and
// advances the book's ordering id. A halt leaves the market without trades, but
// never without a book: depth is still served from the last traded price, which
// is what lets the tape go quiet while the book keeps chaining.
func (f *Feed) deriveBook() {
	f.bookTx++
	f.book = Book{Seq: f.bookTx}
	mid := f.price
	for i := 0; i < 10; i++ {
		bp := mid * (1 - 0.0003 - float64(i)*0.0002 - f.rng.Float64()*0.0001)
		ap := mid * (1 + 0.0003 + float64(i)*0.0002 + f.rng.Float64()*0.0001)
		bq := 0.01 + f.rng.ExpFloat64()*0.05
		aq := 0.01 + f.rng.ExpFloat64()*0.05
		f.book.Bids = append(f.book.Bids, Level{Price: p2s(bp), Qty: q2s(bq)})
		f.book.Asks = append(f.book.Asks, Level{Price: p2s(ap), Qty: q2s(aq)})
	}
}

// tradesThisTick is how many trades this step prints: the seeded 1-3, none
// while a halt is quiet, or a burst's worth while one is running.
func (f *Feed) tradesThisTick(now time.Time) int {
	switch {
	case f.halted(now):
		return 0
	case f.bursting(now):
		return burstPerTick
	default:
		return 1 + f.rng.Intn(3)
	}
}

// halted reports whether the tape is inside a halt's quiet window.
func (f *Feed) halted(now time.Time) bool {
	return !f.sc.haltUntil.IsZero() && now.Before(f.sc.haltUntil)
}

// bursting reports whether the tape is inside a burst's print storm.
func (f *Feed) bursting(now time.Time) bool {
	return !f.sc.burstUntil.IsZero() && now.Before(f.sc.burstUntil)
}

// applyScenario opens any armed window, fires any one-shot event for this tick,
// and retires a window that has just closed. It runs before the market steps, so
// the tick it lands on is the tick the operator sees.
func (f *Feed) applyScenario(now time.Time) {
	if f.sc.spikeNext {
		f.sc.spikeNext = false
		f.sc.name = "" // one-shot: from here the jump is in the tape
		f.price *= math.Exp(spikeSigmas * tickSigma)
	}
	if f.sc.gapNext {
		f.sc.gapNext = false
		f.sc.name = ""
		// The next frame cannot be chained onto the last one the client applied,
		// which is exactly the break docs/SEAMS.md Slice B wants on demand.
		f.bookTx += gapSkip
	}
	if f.sc.haltArmed {
		f.sc.haltArmed = false
		f.sc.haltUntil = now.Add(haltQuiet)
	}
	if f.sc.burstArmed {
		f.sc.burstArmed = false
		f.sc.burstUntil = now.Add(burstWindow)
	}
	// A window that has run out is disarmed here rather than in the reader, so
	// GET /api/scenario never claims a spike that has printed or a halt that has
	// already ended.
	if !f.sc.haltUntil.IsZero() && !now.Before(f.sc.haltUntil) {
		f.sc.haltUntil = time.Time{}
		f.retire(ScenarioHalt)
	}
	if !f.sc.burstUntil.IsZero() && !now.Before(f.sc.burstUntil) {
		f.sc.burstUntil = time.Time{}
		f.retire(ScenarioBurst)
	}
}

// retire drops the injector's name once the named scenario has finished.
func (f *Feed) retire(s Scenario) {
	if f.sc.name == s {
		f.sc.name = ""
	}
}

// ArmScenario injects a scripted market event by name. "clear" disarms, and it
// also cuts short a halt or burst that is already running: the operator asked
// for the seeded market back, and there is no other way to end a 5s quiet
// window early. An unknown name is an error, never a no-op — a demo control
// that silently does nothing is indistinguishable from a broken feed.
func (f *Feed) ArmScenario(name string) error {
	s, ok := parseScenario(name)
	if !ok {
		return fmt.Errorf("unknown scenario %q, want one of %s", name, scenarioList())
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	f.sc = scenarioState{} // every arm starts from a clean injector
	switch s {
	case ScenarioSpike:
		f.sc.spikeNext = true
	case ScenarioHalt:
		f.sc.haltArmed = true
	case ScenarioGap:
		f.sc.gapNext = true
	case ScenarioBurst:
		f.sc.burstArmed = true
	case ScenarioClear:
		return nil // disarmed: the name stays ""
	}
	f.sc.name = s
	return nil
}

// ArmedScenario reports the scenario that is armed or in effect, or "" when the
// feed is running from the seed alone.
func (f *Feed) ArmedScenario() Scenario {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.sc.name
}

func parseScenario(name string) (Scenario, bool) {
	for _, s := range scenarioNames {
		if name == string(s) {
			return s, true
		}
	}
	return "", false
}

// scenarioList renders the accepted names for an error body.
func scenarioList() string {
	names := make([]string, len(scenarioNames))
	for i, s := range scenarioNames {
		names[i] = string(s)
	}
	return strings.Join(names, ", ")
}

// accum folds one trade into its interval's live bucket, finishing the
// previous bucket when the trade opens a new one. A finished bucket is frozen
// and appended to the interval's series: from here on it is data, not state,
// which is what lets a throttled stream hold it back without changing it.
func (f *Feed) accum(c *Candle, t Trade, now time.Time, d time.Duration) *Candle {
	b := now.Truncate(d)
	if c == nil || c.T != b.UTC().Format(time.RFC3339Nano) {
		if c != nil {
			c.complete = true
			c.finalize()
			f.done[d] = append(f.done[d], *c)
		}
		c = &Candle{T: b.UTC().Format(time.RFC3339Nano), ot: t.px, hi: t.px, lo: t.px}
	}
	c.ct, c.vt = t.px, c.vt+t.qy
	if t.px > c.hi {
		c.hi = t.px
	}
	if t.px < c.lo || c.lo == 0 {
		c.lo = t.px
	}
	c.finalize()
	return c
}

// finalize writes a bucket's wire strings from its aggregation state.
func (c *Candle) finalize() {
	c.O, c.H, c.L, c.C, c.V = p2s(c.ot), p2s(c.hi), p2s(c.lo), p2s(c.ct), q2s(c.vt)
}

// Snapshot returns a copy of the current book.
func (f *Feed) Snapshot() Book {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.book
}

// Active returns the live 1s/1m candles plus last trade. A bucket the market has
// not traded in yet comes back as the zero Candle (empty `t`).
func (f *Feed) Active() (c1s, c1m Candle, last Trade) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if c := f.live[time.Second]; c != nil {
		c1s = *c
	}
	if c := f.live[time.Minute]; c != nil {
		c1m = *c
	}
	return c1s, c1m, f.last
}

// History returns the newest `limit` finished candles for an interval, oldest
// first. The live bucket is withheld: it is not a candle yet. It reads the same
// series the live chart stream reads, so the two doors onto the market cannot
// disagree (SPEC story 21).
// TRACER NOTE: same-run determinism only; cross-run replay from seed is a
// full-build step (virtual clock, boot-time backfill).
func (f *Feed) History(d time.Duration, limit int) []Candle {
	f.mu.RLock()
	defer f.mu.RUnlock()

	done := f.done[d]
	if limit < 0 {
		limit = 0
	}
	if len(done) > limit {
		done = done[len(done)-limit:]
	}
	// Copied, and never nil: a caller cannot alias the feed's series, and an
	// empty series has to cross the wire as [] rather than null.
	out := make([]Candle, 0, len(done))
	return append(out, done...)
}

// CandleCount is how many finished candles the feed holds for an interval: the
// position a new chart stream starts from, so a connection is never handed
// candles the client's REST history request already covered.
func (f *Feed) CandleCount(d time.Duration) int {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return len(f.done[d])
}

// CandlesSince returns the finished candles for an interval that a stream has
// not consumed yet (cursor is the count it was handed last time), the live
// candle for the interval, and the count to hand back next time. The series is
// append-only, so positions stay valid; the returned candles are copies.
//
// This is the seam tiered delivery is built on: the values are the feed's own
// aggregation, so a stream may hold frames back — merging several trades into
// one later update — without ever recomputing an OHLCV that could drift.
func (f *Feed) CandlesSince(d time.Duration, cursor int) (finished []Candle, live Candle, next int) {
	f.mu.RLock()
	defer f.mu.RUnlock()

	done := f.done[d]
	if cursor < 0 {
		cursor = 0
	}
	if cursor > len(done) {
		cursor = len(done)
	}
	finished = make([]Candle, len(done)-cursor)
	copy(finished, done[cursor:])
	if c := f.live[d]; c != nil {
		live = *c
	}
	return finished, live, len(done)
}

// TradesSince returns up to limit of the newest trades newer than after, oldest
// first — the read seam the WebSocket stream uses to advance a per-connection
// watermark without touching the feed's internals. It returns nil when the
// watermark is already current, so a quiet market produces no frames.
func (f *Feed) TradesSince(after uint64, limit int) []Trade {
	f.mu.RLock()
	defer f.mu.RUnlock()

	if limit <= 0 {
		return nil
	}
	start := len(f.trades)
	for start > 0 && len(f.trades)-start < limit && f.trades[start-1].Seq > after {
		start--
	}
	if start == len(f.trades) {
		return nil // nothing newer than the watermark
	}
	trades := make([]Trade, len(f.trades)-start)
	copy(trades, f.trades[start:])
	return trades
}

// p2s formats a price with 2 decimals; q2s a quantity/volume with 6.
func p2s(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }
func q2s(v float64) string { return strconv.FormatFloat(v, 'f', 6, 64) }
