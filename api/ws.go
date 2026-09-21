package main

// ws.go — the WebSocket market stream (SPEC Bullets 1 and 3, PROTOCOL
// "WebSocket").
//
// One connection is one session: it announces its delivery tier, then streams
// the trades the feed produces and every new book state as a full 10x10 image
// carrying `seq` and `prevSeq`. The ids are the point of the frame: the client
// chains an image onto the seq it last applied and refetches the REST snapshot
// when the parent does not match, which is how a book survives a missed update
// (docs/SEAMS.md Slice B).
//
// The chart is the adaptive half (docs/SEAMS.md Slice A). The client reports
// latency and jitter every 2s; the backend keeps a tier per connection and
// decides what that entitles it to. Delivery is throttled — full 4Hz, degraded
// 1Hz, minimal 0.25Hz — by holding frames back, never by dropping or
// recomputing them: candle values come from the feed's own aggregation, so two
// connections at different tiers are handed byte-identical finished candles,
// just at different moments. The tape and the book are not throttled at all:
// trades are the atomic truth (CONTEXT.md), and a client that derives its own
// state from them must not silently miss one.
//
// Connection hygiene lives here too, because a socket that stops being read is
// a goroutine that never dies:
//
//   - one goroutine writes (the pump) and one reads, so frames cannot
//     interleave and neither loop outlives the session;
//   - every write carries a deadline: a client that stops reading is dropped
//     instead of pinning the pump;
//   - every read carries an idle deadline: a half-open peer is reaped within a
//     minute instead of blocking until TCP keepalive notices, hours later;
//   - the reader→writer queue is bounded: a client whose replies cannot keep up
//     is evicted rather than buffered without limit;
//   - live sessions are registered, because http.Server cannot see a hijacked
//     connection and would otherwise leak it on shutdown.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// Topic names PROTOCOL.md defines for /ws?topics=.
const (
	topicBook   = "book"
	topicTrades = "trades"
	topicChart  = "chart"
)

// topicSet is one connection's subscription. Absent `topics` means every topic
// PROTOCOL.md names, so the zero value is "nothing subscribed" and "all" is
// written out where it is meant.
type topicSet struct {
	book   bool
	trades bool
	chart  bool
}

func (t topicSet) any() bool { return t.book || t.trades || t.chart }

// parseTopics reads `topics=book,trades`. An unknown name is an error rather
// than a silent ignore: a typo that streams nothing looks exactly like a dead
// backend, and /api/history already answers unusable input with a 400.
func parseTopics(raw string) (topicSet, error) {
	if raw == "" {
		return topicSet{book: true, trades: true, chart: true}, nil // PROTOCOL: default all
	}
	var set topicSet
	for _, entry := range strings.Split(raw, ",") {
		switch name := strings.TrimSpace(entry); name {
		case "":
			// `topics=book,,trades` is a typo, not a request for nothing.
		case topicBook:
			set.book = true
		case topicTrades:
			set.trades = true
		case topicChart:
			set.chart = true
		default:
			return topicSet{}, fmt.Errorf("unsupported topic %q, want a comma list of %s, %s, %s",
				name, topicBook, topicTrades, topicChart)
		}
	}
	if !set.any() {
		return topicSet{}, fmt.Errorf("no topics requested, want a comma list of %s, %s, %s",
			topicBook, topicTrades, topicChart)
	}
	return set, nil
}

// Server → client frames (docs/PROTOCOL.md). Declaration order is wire order,
// so the JSON reads the way the protocol documents it.

type tierFrame struct {
	Type string  `json:"type"` // "tier"
	Tier Tier    `json:"tier"`
	Rate float64 `json:"rate"`
}

// tradeFrame crosses the wire as `["trade",seq,ts,price,qty]` (PROTOCOL.md
// protocol v2). The Go shape keeps named fields; only the JSON is positional.
type tradeFrame struct {
	Type  string // "trade"
	Seq   uint64
	TS    string
	Price string
	Qty   string
}

// MarshalJSON writes the tuple form.
func (f tradeFrame) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{"trade", f.Seq, f.TS, f.Price, f.Qty})
}

// UnmarshalJSON reads the tuple form.
func (f *tradeFrame) UnmarshalJSON(data []byte) error {
	var t [5]json.RawMessage
	if err := json.Unmarshal(data, &t); err != nil {
		return err
	}
	var tag string
	if err := json.Unmarshal(t[0], &tag); err != nil {
		return err
	}
	if tag != "trade" {
		return fmt.Errorf("trade frame tag = %q, want trade", tag)
	}
	if err := json.Unmarshal(t[1], &f.Seq); err != nil {
		return err
	}
	if err := json.Unmarshal(t[2], &f.TS); err != nil {
		return err
	}
	if err := json.Unmarshal(t[3], &f.Price); err != nil {
		return err
	}
	if err := json.Unmarshal(t[4], &f.Qty); err != nil {
		return err
	}
	f.Type = "trade"
	return nil
}

// bookFrame is a full 10x10 image, not a diff — the tracer PROTOCOL.md
// describes. prevSeq is the feed-space parent (seq - 1), so a client holding
// that seq can replace its book with this image, and a client holding
// anything else has a gap (refetch the snapshot): missed frames, a pump that
// lagged a tick, or the gap injector's skipped ids.
// bookFrame crosses the wire as `["book",seq,prevSeq,bids,asks]`
// (PROTOCOL.md protocol v2), each side an array of `[price,qty]` tuples.
type bookFrame struct {
	Type    string // "book"
	Seq     uint64
	PrevSeq uint64
	Bids    []Level
	Asks    []Level
}

// MarshalJSON writes the tuple form.
func (f bookFrame) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{"book", f.Seq, f.PrevSeq, f.Bids, f.Asks})
}

// UnmarshalJSON reads the tuple form.
func (f *bookFrame) UnmarshalJSON(data []byte) error {
	var t [5]json.RawMessage
	if err := json.Unmarshal(data, &t); err != nil {
		return err
	}
	var tag string
	if err := json.Unmarshal(t[0], &tag); err != nil {
		return err
	}
	if tag != "book" {
		return fmt.Errorf("book frame tag = %q, want book", tag)
	}
	if err := json.Unmarshal(t[1], &f.Seq); err != nil {
		return err
	}
	if err := json.Unmarshal(t[2], &f.PrevSeq); err != nil {
		return err
	}
	if err := json.Unmarshal(t[3], &f.Bids); err != nil {
		return err
	}
	if err := json.Unmarshal(t[4], &f.Asks); err != nil {
		return err
	}
	f.Type = "book"
	return nil
}

// candleFrame is one OHLCV update for the connection's chart subscription
// (PROTOCOL.md). `complete` is the frame's only metadata: false while the bucket
// is still trading, true for the candle the next bucket finalised. A finished
// candle is sent once and never revised.
// candleFrame crosses the wire as `["candle",interval,t,o,h,l,c,v,complete]`
// (PROTOCOL.md protocol v2). `complete` stays the frame's only metadata.
type candleFrame struct {
	Type     string // "candle"
	Interval string
	T        string
	O        string
	H        string
	L        string
	C        string
	V        string
	Complete bool
}

// MarshalJSON writes the tuple form.
func (f candleFrame) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{"candle", f.Interval, f.T, f.O, f.H, f.L, f.C, f.V, f.Complete})
}

// UnmarshalJSON reads the tuple form.
func (f *candleFrame) UnmarshalJSON(data []byte) error {
	var t [9]json.RawMessage
	if err := json.Unmarshal(data, &t); err != nil {
		return err
	}
	var tag string
	if err := json.Unmarshal(t[0], &tag); err != nil {
		return err
	}
	if tag != "candle" {
		return fmt.Errorf("candle frame tag = %q, want candle", tag)
	}
	for i, dst := range []*string{&f.Interval, &f.T, &f.O, &f.H, &f.L, &f.C, &f.V} {
		if err := json.Unmarshal(t[1+i], dst); err != nil {
			return err
		}
	}
	if err := json.Unmarshal(t[8], &f.Complete); err != nil {
		return err
	}
	f.Type = "candle"
	return nil
}

// pongFrame answers a client ping. TSend is echoed as the exact JSON bytes the
// client sent: it is a client clock reading, and re-encoding it through a
// float64 is how 1710842000123 comes back as 1.710842000123e+12.
type pongFrame struct {
	Type  string          `json:"type"` // "pong"
	TSend json.RawMessage `json:"tSend"`
	TRecv string          `json:"tRecv"`
}

// clientFrame is every inbound frame this build understands. `report` and
// `force` drive the tier machine (tier.go); tSend is echoed back verbatim in a
// pong, and tier is kept raw because PROTOCOL.md spells the debug override as
// either a tier name or the literal null.
type clientFrame struct {
	Type      string          `json:"type"`
	TSend     json.RawMessage `json:"tSend"`
	LatencyMs *float64        `json:"latencyMs"`
	JitterMs  *float64        `json:"jitterMs"`
	Tier      json.RawMessage `json:"tier"`
}

// maxReportMs bounds one client-reported millisecond reading. Anything past a
// minute is not a latency measurement, and a Duration built from it would
// overflow into a fast connection — the one direction an untrusted reading must
// never be able to move the tier.
const maxReportMs = 60_000

// probe reads PROTOCOL.md's report frame. A frame without two sane,
// non-negative millisecond readings is not a probe: ignoring it leaves the
// window to the miss path, which is the honest outcome for a client that
// cannot say how it is doing.
func (f clientFrame) probe() (latency, jitter time.Duration, ok bool) {
	if f.LatencyMs == nil || f.JitterMs == nil {
		return 0, 0, false
	}
	ms, jitterMs := *f.LatencyMs, *f.JitterMs
	// NaN fails these comparisons, and infinities fail the upper bound.
	if !(ms >= 0 && ms <= maxReportMs) || !(jitterMs >= 0 && jitterMs <= maxReportMs) {
		return 0, 0, false
	}
	return time.Duration(ms * float64(time.Millisecond)),
		time.Duration(jitterMs * float64(time.Millisecond)), true
}

// tierNamed maps a wire tier name onto tier.go's tiers. An unknown name is not
// a tier, so callers ignore it rather than guessing at a correction.
func tierNamed(name string) (Tier, bool) {
	switch t := Tier(name); t {
	case TierFull, TierDegraded, TierMinimal:
		return t, true
	}
	return "", false
}

// wsPolicy is the connection hygiene budget, in one place so tests can shrink
// it and the README can quote it.
type wsPolicy struct {
	pushEvery    time.Duration // how often a session samples the feed for new frames
	writeTimeout time.Duration // deadline for one frame write
	idleTimeout  time.Duration // read deadline: no client traffic for this long = gone
	reportWindow time.Duration // how long a client has to send its next probe before it counts as missed
	queue        int           // replies that may wait for the wire before "too slow"
	backlog      int           // trades delivered per pass, so one pass cannot monopolise
	readLimit    int64         // largest client frame accepted
}

func defaultWSPolicy() wsPolicy {
	return wsPolicy{
		// The feed ticks every 100ms, so sampling faster keeps the added
		// latency under a tick while never inventing a frame: ids come from the
		// feed, and a quiet market produces nothing.
		pushEvery: 25 * time.Millisecond,
		// A write that has not landed in 5s is a consumer that stopped reading.
		// The deadline fails the write, which ends the session.
		writeTimeout: 5 * time.Second,
		// PROTOCOL.md has the client probe every 2s, so a healthy client is
		// never near this; a peer that has vanished is still reaped in a minute.
		idleTimeout: 60 * time.Second,
		// One window per probe the client owes (PROTOCOL.md: report every 2s).
		// A client that cannot report no longer gets to stay fast: 3 empty
		// windows degrade it, 6 minimize it (tier.go's miss budget).
		reportWindow: 2 * time.Second,
		queue:        32,
		backlog:      64,
		readLimit:    16 << 10,
	}
}

// wsSession is one connection's state: what it subscribed to, how far it has
// been told about each stream, the tier machine that decides its delivery rate
// (tier.go owns the decision, this owns the plumbing around it), and where it
// is in the feed's candle series.
type wsSession struct {
	conn        *websocket.Conn
	feed        *Feed
	policy      wsPolicy
	topics      topicSet
	interval    string // the chart subscription this connection asked for
	intervalDur time.Duration

	replies chan []byte
	cancel  context.CancelFunc

	// Ids this connection has been told about, owned by the pump: the change
	// detector for the next sample. The parent a book frame claims is feed-space
	// (seq - 1 in sample), which coincides with lastBook whenever this pump
	// kept up with the feed.
	lastBook  uint64
	lastTrade uint64

	// Tier state. One connection is one state machine (CONTEXT.md), driven by
	// the client's probes and by the reports that never arrive. The reader and
	// the pump both touch it, so it travels with its own lock; announced is what
	// the client has been told, so a tier frame goes out on connect and on every
	// change and at no other time.
	//
	// forced mirrors the machine's own override (tier.go's Force) because a
	// forced tier has to take effect *now*: Force only records the override, and
	// the machine folds it into its decision on the next probe or window, which
	// would leave a debug control visibly two seconds slow.
	tierMu    sync.Mutex
	machine   *TierMachine
	forced    *Tier
	announced Tier
	probes    int

	// Chart state: the delivery bookkeeping for the live candle stream.
	candles candleStream

	once   sync.Once
	reason string // why the session ended, when the server ended it
}

// candleStream is where one connection stands with the feed's candle series.
// The feed owns the values — this holds only what to send and when, which is
// the whole of tiered delivery: finished candles wait for a slot rather than
// being recomputed or dropped, and the live candle is re-sent only when it has
// actually moved.
type candleStream struct {
	cursor  int      // finished candles already taken from the feed
	pending []Candle // finished candles waiting for the next delivery slot
	live    Candle   // the live candle the client was last told about
	lastAt  time.Time
}

// handleWS serves GET /ws. Query validation happens before the upgrade so an
// unusable subscription is the same plain JSON 400 the REST routes produce,
// not a failed handshake with a text/plain body from the websocket library.
func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	topics, err := parseTopics(q.Get("topics"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	interval := q.Get("interval")
	if interval == "" {
		interval = intervals[0].Label // PROTOCOL: the chart subscription defaults to 1s
	}
	if _, ok := intervalFor(interval); !ok {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("unsupported interval %q, want one of %s", interval, strings.Join(intervalLabels(), ", ")))
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The page is served from a different origin — another port locally,
		// another host when deployed — so Accept's origin check would reject
		// every real client. The stream is read-only and credential-free, which
		// is the same trade withCORS makes for REST.
		InsecureSkipVerify: true,
		// Compression stays at its default (off): these frames are small, and
		// permessage-deflate costs a goroutine and a dictionary per connection.
	})
	if err != nil {
		return // Accept has already written a response
	}

	s.serveWS(r.Context(), c, topics, interval)
}

// serveWS runs one session to completion and closes the socket on the way out,
// so every path out of here frees both goroutines.
func (s *server) serveWS(reqCtx context.Context, c *websocket.Conn, topics topicSet, interval string) {
	ctx, cancel := context.WithCancel(reqCtx)
	defer cancel()

	// What this connection has been told about so far: the book the client is
	// about to snapshot has this seq (so the first frame we send may claim it as
	// parent), and the newest trade is behind the first trade we should send.
	book := s.feed.Snapshot()
	_, _, last := s.feed.Active()
	intervalDur, _ := intervalFor(interval) // handleWS validated the label
	// One connection, one tier state machine, on the bands this deployment was
	// configured with (README "Tiers": TIER_* env, defaults otherwise).
	machine := NewTierMachine(s.cfg.tierConfig())

	sess := &wsSession{
		conn:        c,
		feed:        s.feed,
		policy:      s.ws,
		topics:      topics,
		interval:    interval,
		intervalDur: intervalDur,
		replies:     make(chan []byte, s.ws.queue),
		cancel:      cancel,
		lastBook:    book.Seq,
		lastTrade:   last.Seq,
		machine:     machine,
		announced:   machine.Tier(),
		// Chart streams start at the end of the series: the candles a client
		// missed before connecting are what /api/history is for. Only candles
		// the feed finishes from now on belong to this connection.
		candles: candleStream{cursor: s.feed.CandleCount(intervalDur)},
	}
	c.SetReadLimit(s.ws.readLimit)

	s.sessions.add(sess)
	defer s.sessions.remove(sess)

	// The tier handshake is the first frame on every connection, so the client
	// can render "full @4Hz" before any data arrives. tier.go owns the numbers.
	if err := sess.write(ctx, mustJSON(tierFrame{Type: "tier", Tier: sess.machine.Tier(), Rate: sess.machine.Tier().Rate()})); err != nil {
		sess.end("failed to announce tier: " + err.Error())
	} else {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			sess.read(ctx)
		}()
		go func() {
			defer wg.Done()
			sess.pump(ctx)
		}()
		wg.Wait()
	}

	if reason := sess.outcome(); reason != "" {
		// One line per connection that did not end normally, so a demo (or a
		// anyone tailing the log) can see evictions and idle reaps happen.
		log.Printf("ws: session ended: %s", reason)
	}
	_ = c.CloseNow()
}

// read owns the client → server half, and ends the session when it returns so a
// client that disappears takes its goroutines with it.
func (s *wsSession) read(ctx context.Context) {
	defer s.cancel()

	for {
		// The idle deadline is armed per read, and the library closes the whole
		// connection when it fires — which is exactly the eviction we want for a
		// peer that has gone silent. Cancelling it after a successful read is
		// safe: the library re-arms its own read context between frames.
		rctx, cancelRead := context.WithTimeout(ctx, s.policy.idleTimeout)
		typ, data, err := s.conn.Read(rctx)
		idle := rctx.Err() != nil
		cancelRead()

		if err != nil {
			if idle {
				s.end("no client traffic within the idle window")
			}
			return
		}
		if typ != websocket.MessageText {
			continue // binary frames are not part of this protocol
		}
		s.handle(data)
	}
}

// handle answers one client frame. Malformed JSON, unknown types, and frames
// this build does not act on are ignored rather than fatal: a devtools typo
// should not kill a live stream, and the client's own guard already drops what
// it cannot parse.
func (s *wsSession) handle(data []byte) {
	var f clientFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return
	}
	switch f.Type {
	case "ping":
		stamp, ok := jsonNumber(f.TSend)
		if !ok {
			return // a ping with no readable stamp cannot be answered honestly
		}
		s.enqueue(mustJSON(pongFrame{
			Type:  "pong",
			TSend: stamp,
			TRecv: time.Now().UTC().Format(time.RFC3339Nano),
		}))
	case "report":
		latency, jitter, ok := f.probe()
		if !ok {
			return // not a probe; the window counts it as a missed report
		}
		s.tierMu.Lock()
		s.machine.Report(latency, jitter)
		s.probes++
		frame := s.announceLocked(s.effectiveTierLocked())
		s.tierMu.Unlock()
		if frame != nil {
			s.enqueue(frame)
		}
	case "force":
		// PROTOCOL.md: {"type":"force","tier":"degraded"|null}. A frame that
		// names no tier — absent, misnamed, or not a string — leaves the
		// override exactly as it was: a debug control that half-acts on a typo
		// is worse than one that does nothing at all.
		switch {
		case len(f.Tier) == 0:
			return
		case string(f.Tier) == "null":
			s.force(nil)
		default:
			var name string
			if err := json.Unmarshal(f.Tier, &name); err != nil {
				return
			}
			tier, ok := tierNamed(name)
			if !ok {
				return
			}
			s.force(&tier)
		}
	default:
		// Unknown types are what the additive-fields rule is for (PROTOCOL
		// "Versioning"): ignore, never close.
	}
}

// force sets or clears the debug override and tells the client at once when the
// decision changed: a forced tier applies now, not at the next probe. Clearing
// hands the decision back to the machine — a forced tier buys no upgrade and
// hides nothing, so the connection resumes wherever the probes it has seen put
// it, and climbs from there on fresh ones.
func (s *wsSession) force(t *Tier) {
	s.tierMu.Lock()
	s.forced = t
	s.machine.Force(t)
	frame := s.announceLocked(s.effectiveTierLocked())
	s.tierMu.Unlock()
	if frame != nil {
		s.enqueue(frame)
	}
}

// effectiveTierLocked is the tier this connection must behave at and be told
// about: the override while one is set, otherwise the machine's decision.
// Callers hold tierMu.
func (s *wsSession) effectiveTierLocked() Tier {
	if s.forced != nil {
		return *s.forced
	}
	return s.machine.Tier()
}

// announceLocked records the tier the client has now been told about and
// returns the frame that says so, or nil when the decision did not change
// (PROTOCOL.md: a tier frame goes out on connect and on every change). Callers
// hold tierMu.
func (s *wsSession) announceLocked(tier Tier) []byte {
	if tier == s.announced {
		return nil
	}
	s.announced = tier
	return mustJSON(tierFrame{Type: "tier", Tier: tier, Rate: tier.Rate()})
}

// tierWindow is PROTOCOL.md's 2s probe cadence. The client measures its own
// latency; a client that stops measuring — stalled tab, hung proxy, a socket
// kept open by a router — can never report that it is slow, so silence is what
// the tier machine counts as a missed report (tier.go: 3 misses degrade, 6
// minimize).
func (s *wsSession) tierWindow(ctx context.Context) bool {
	s.tierMu.Lock()
	if s.probes == 0 {
		s.machine.Miss()
	} else {
		s.probes = 0
	}
	frame := s.announceLocked(s.effectiveTierLocked())
	s.tierMu.Unlock()

	if frame == nil {
		return true
	}
	if err := s.write(ctx, frame); err != nil {
		s.end("write failed: " + err.Error())
		return false
	}
	return true
}

// enqueue hands the writer a reply, or evicts the connection when the queue is
// full: a consumer slower than the market reconnects and resyncs, which beats
// giving it unbounded memory on the server.
func (s *wsSession) enqueue(data []byte) {
	select {
	case s.replies <- data:
	default:
		s.end("send buffer full: consumer too slow")
	}
}

// pump is the session's only writer. It samples the feed for new frames, keeps
// the tier's report window, and relays the reader's replies, so two frames can
// never interleave on the wire.
func (s *wsSession) pump(ctx context.Context) {
	defer s.cancel()

	sample := time.NewTicker(s.policy.pushEvery)
	defer sample.Stop()
	window := time.NewTicker(s.policy.reportWindow)
	defer window.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case data := <-s.replies:
			if err := s.write(ctx, data); err != nil {
				s.end("write failed: " + err.Error())
				return
			}
		case <-window.C:
			if !s.tierWindow(ctx) {
				return
			}
		case <-sample.C:
			if !s.sample(ctx) {
				return
			}
		}
	}
}

// sample sends whatever the feed produced since the last pass: one full book
// image per book change, one frame per trade, and the chart frames this
// connection's tier entitles it to. Ids come from the feed, so a quiet market
// produces nothing at all.
func (s *wsSession) sample(ctx context.Context) bool {
	if s.topics.book {
		if book := s.feed.Snapshot(); book.Seq != s.lastBook {
		// Feed-space parent (seq - 1), not the connection's last-told seq: the
		// two coincide whenever this pump kept up with the feed, and diverge
		// exactly when ids were skipped — the gap injector's jump or a pump that
		// lagged a tick — which the client must see as a gap and refetch, never
		// silently chain onto.
		if !s.send(ctx, bookFrame{Type: "book", Seq: book.Seq, PrevSeq: book.Seq - 1, Bids: book.Bids, Asks: book.Asks}) {
				return false
			}
			s.lastBook = book.Seq
		}
	}
	if s.topics.trades {
		// Bounded per pass: a connection that fell behind catches up over the
		// next passes instead of monopolising the writer. Delivering the newest
		// trades rather than the oldest backlog is deliberate — the tape is a
		// window on the market, not an archive.
		for _, t := range s.feed.TradesSince(s.lastTrade, s.policy.backlog) {
			if !s.send(ctx, tradeFrame{Type: "trade", Seq: t.Seq, TS: t.TS, Price: t.Price, Qty: t.Qty}) {
				return false
			}
			s.lastTrade = t.Seq
		}
	}
	if s.topics.chart {
		return s.sampleChart(ctx, time.Now())
	}
	return true
}

// sampleChart sends the chart frames this connection is entitled to: every
// finished candle it has not been told about yet, oldest first, then the live
// candle — never faster than the tier's rate.
//
// Throttling lives in the single test below, and it is what makes a tier
// visible: 4Hz, 1Hz or 0.25Hz is the rate at which the chart on screen moves,
// which is why the in-progress candle is refreshed on that cadence instead of on
// every tick. The values are always the feed's own aggregation, so the frames
// carry the same candles a fast tier is given (docs/SEAMS.md Slice A: combining
// updates is allowed, inventing values is not).
//
// A slot carries whatever is waiting: the finished candles that piled up since
// the last one, and at most one live refresh. That split matters — a finished
// candle is a correction, and the one thing a slow tier must never do is leave
// one behind to keep its frame count down. It queues for the next slot instead,
// so both halves hold: fewer updates, and no candle lost.
func (s *wsSession) sampleChart(ctx context.Context, now time.Time) bool {
	finished, live, cursor := s.feed.CandlesSince(s.intervalDur, s.candles.cursor)
	s.candles.pending = append(s.candles.pending, finished...)
	s.candles.cursor = cursor

	if !s.chartDue(now) {
		return true // the rate holds frames back; nothing is dropped
	}

	for _, c := range s.candles.pending {
		if !s.send(ctx, s.candleFrame(c, true)) {
			return false
		}
	}
	s.candles.pending = nil

	if live.T != "" && live != s.candles.live {
		if !s.send(ctx, s.candleFrame(live, false)) {
			return false
		}
		s.candles.live = live
	}
	s.candles.lastAt = now
	return true
}

// candleFrame spells one candle as PROTOCOL.md documents it: the frame's
// interval is the subscription's, and `complete` is the only thing the throttled
// stream adds.
func (s *wsSession) candleFrame(c Candle, complete bool) candleFrame {
	return candleFrame{
		Type:     "candle",
		Interval: s.interval,
		T:        c.T,
		O:        c.O,
		H:        c.H,
		L:        c.L,
		C:        c.C,
		V:        c.V,
		Complete: complete,
	}
}

// chartDue reports whether this connection's delivery slot has opened. The gap
// is the tier's announced rate — 4Hz, 1Hz, 0.25Hz — so the badge the client
// renders and the frames it receives agree, override included.
func (s *wsSession) chartDue(now time.Time) bool {
	s.tierMu.Lock()
	gap := time.Duration(float64(time.Second) / s.effectiveTierLocked().Rate())
	s.tierMu.Unlock()
	return now.Sub(s.candles.lastAt) >= gap
}

// send writes one frame this package defines. A failed write ends the session:
// the pump is the only writer, so there is nothing left to say to this peer.
func (s *wsSession) send(ctx context.Context, v any) bool {
	if err := s.write(ctx, mustJSON(v)); err != nil {
		s.end("write failed: " + err.Error())
		return false
	}
	return true
}

// write puts one frame on the wire under a deadline. Cancelling the deadline
// after the write is safe for the same reason the library does it itself for
// control frames: a completed write re-arms the connection's own write context.
func (s *wsSession) write(ctx context.Context, data []byte) error {
	wctx, cancel := context.WithTimeout(ctx, s.policy.writeTimeout)
	defer cancel()
	return s.conn.Write(wctx, websocket.MessageText, data)
}

// end records why the session must stop — first reason wins, because the cause
// of death is more useful than whatever the cleanup noticed afterwards — and
// cancels it, which stops both the reader and the pump.
//
// Every ending this server decides on is abrupt, deliberately. This library
// tears the underlying connection down the moment the context handed to a read
// is cancelled, so a "graceful" close frame written after the cancel could never
// reach the peer; and the endings here (eviction, idle reap, shutdown) are
// exactly the ones where waiting on a handshake with a peer that is not reading
// would stall the session for seconds. A client that closes the socket itself
// still gets the library's proper close reply.
func (s *wsSession) end(reason string) {
	s.once.Do(func() {
		s.reason = reason
		s.cancel()
	})
}

// outcome reports why the session ended. Safe to call after both goroutines
// have returned: the WaitGroup in serveWS orders the read.
func (s *wsSession) outcome() string { return s.reason }

// wsRegistry tracks live sessions. Hijacked connections are invisible to
// http.Server, so nothing else can close them on shutdown or show that a
// finished connection was really reaped.
type wsRegistry struct {
	mu       sync.Mutex
	sessions map[*wsSession]struct{}
}

func newWSRegistry() *wsRegistry {
	return &wsRegistry{sessions: map[*wsSession]struct{}{}}
}

func (r *wsRegistry) add(s *wsSession) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[s] = struct{}{}
}

func (r *wsRegistry) remove(s *wsSession) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, s)
}

func (r *wsRegistry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions)
}

// closeAll ends every live session, and is safe to call with none.
func (r *wsRegistry) closeAll(reason string) {
	r.mu.Lock()
	live := make([]*wsSession, 0, len(r.sessions))
	for s := range r.sessions {
		live = append(live, s)
	}
	r.mu.Unlock()

	for _, s := range live {
		s.end(reason)
	}
}

// shutdownWS ends every live socket. Hijacked connections are invisible to
// http.Server.Shutdown, so without this the process would exit with sockets
// still open and every client would wait out a TCP timeout before reconnecting.
func (s *server) shutdownWS() {
	if live := s.sessions.count(); live > 0 {
		log.Printf("ws: closing %d live connection(s)", live)
	}
	s.sessions.closeAll("server shutting down")
}

// jsonNumber accepts a client-sent stamp and returns the exact bytes to echo.
// Anything that is not a JSON number (missing, null, a string, an object) is
// rejected: a pong with a made-up tSend would poison the client's latency math.
func jsonNumber(raw json.RawMessage) (json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, false
	}
	if _, err := n.Float64(); err != nil {
		return nil, false
	}
	return raw, true
}

// mustJSON marshals a frame this package defines. It cannot fail for those
// types, and a failure would be a bug in our own struct rather than anything a
// client can cause.
func mustJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("ws: frame does not marshal: %v", err))
	}
	return data
}
