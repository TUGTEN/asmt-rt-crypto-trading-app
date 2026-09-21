package main

// ws_test.go — behavior tests for the /ws market stream (SPEC Bullet 1, SEAMS
// Slice B's server half). Behavior only: a real server on a real socket over a
// feed the test ticks by hand, and assertions on the frames a browser receives.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// wsFixture starts the API on a real socket over a feed whose every id is
// scripted by the test: no clock, no goroutine, nothing sampled.
func wsFixture(t *testing.T, seed int64, tune func(*server)) (*httptest.Server, *Feed, *server) {
	t.Helper()
	f := NewFeed(seed)
	s := newServer(testConfig(), f)
	if tune != nil {
		tune(s)
	}
	srv := httptest.NewServer(s.routes())
	t.Cleanup(srv.Close)
	return srv, f, s
}

// wsDial opens the socket the way the page does: same host and port, ws scheme,
// the subscription as the query string.
func wsDial(t *testing.T, base, query string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	target := "ws" + strings.TrimPrefix(base, "http") + "/ws" + query
	c, _, err := websocket.Dial(ctx, target, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", target, err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

// wsFrame is one server frame: the decoded value for the assertions, and the
// raw bytes for the frames whose exact spelling is part of the contract.
// Control frames (tier, pong) are named-key objects; market data (trade, book,
// candle) are positional tuples with the tag at [0] (PROTOCOL.md protocol v2).
type wsFrame struct {
	raw    []byte
	fields map[string]any
	tuple  []any
}

func wsDecode(t *testing.T, data []byte) wsFrame {
	t.Helper()
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		t.Fatalf("frame is empty")
	}
	out := wsFrame{raw: data}
	switch trimmed[0] {
	case '{':
		fields := map[string]any{}
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatalf("frame is not a JSON object: %v\n%s", err, data)
		}
		out.fields = fields
	case '[':
		var tuple []any
		if err := json.Unmarshal(data, &tuple); err != nil {
			t.Fatalf("frame is not a JSON array: %v\n%s", err, data)
		}
		out.tuple = tuple
	default:
		t.Fatalf("frame is neither an object nor a tuple: %s", data)
	}
	return out
}

func (f wsFrame) kind() string {
	if f.fields != nil {
		kind, _ := f.fields["type"].(string)
		return kind
	}
	if len(f.tuple) > 0 {
		kind, _ := f.tuple[0].(string)
		return kind
	}
	return ""
}

// tupleAt reads tuple index i for the shape assertions below.
func (f wsFrame) tupleAt(t *testing.T, i int) any {
	t.Helper()
	if i < 0 || i >= len(f.tuple) {
		t.Fatalf("%s tuple has %d entries, no index %d (raw: %s)", f.kind(), len(f.tuple), i, f.raw)
	}
	return f.tuple[i]
}

func (f wsFrame) str(t *testing.T, key string) string {
	t.Helper()
	value, ok := f.fields[key].(string)
	if !ok {
		t.Fatalf("%s frame field %q = %#v, want a string (raw: %s)", f.kind(), key, f.fields[key], f.raw)
	}
	return value
}

func (f wsFrame) num(t *testing.T, key string) float64 {
	t.Helper()
	value, ok := f.fields[key].(float64)
	if !ok {
		t.Fatalf("%s frame field %q = %#v, want a number (raw: %s)", f.kind(), key, f.fields[key], f.raw)
	}
	return value
}

// book and trade re-read the frame through the same structs the server writes,
// so a test never hand-rolls a shape the wire might not have.
func (f wsFrame) book(t *testing.T) bookFrame {
	t.Helper()
	var out bookFrame
	if err := json.Unmarshal(f.raw, &out); err != nil {
		t.Fatalf("book frame does not match the documented shape: %v\n%s", err, f.raw)
	}
	return out
}

func (f wsFrame) trade(t *testing.T) tradeFrame {
	t.Helper()
	var out tradeFrame
	if err := json.Unmarshal(f.raw, &out); err != nil {
		t.Fatalf("trade frame does not match the documented shape: %v\n%s", err, f.raw)
	}
	return out
}

// wsRead reads exactly one frame, and fails the test rather than hanging: a
// stream that never answers has to say so.
func wsRead(t *testing.T, c *websocket.Conn) wsFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	typ, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("frame type = %v, want a text message", typ)
	}
	return wsDecode(t, data)
}

// wsReadKind reads past frames of other types, so a test that cares about the
// book does not depend on where trades happen to interleave.
func wsReadKind(t *testing.T, c *websocket.Conn, kind string) wsFrame {
	t.Helper()
	for i := 0; i < 100; i++ {
		if frame := wsRead(t, c); frame.kind() == kind {
			return frame
		}
	}
	t.Fatalf("no %q frame in the first 100 frames", kind)
	return wsFrame{}
}

// wsQuiet collects frames until the socket has been silent for d. The stream is
// feed-driven, so silence means the pump has nothing left to send. It leaves the
// connection closed (a client read timeout ends the session by design), so it
// belongs at the end of a test.
func wsQuiet(t *testing.T, c *websocket.Conn, d time.Duration) []wsFrame {
	t.Helper()
	var seen []wsFrame
	for {
		ctx, cancel := context.WithTimeout(context.Background(), d)
		typ, data, err := c.Read(ctx)
		cancel()
		if err != nil {
			return seen
		}
		if typ != websocket.MessageText {
			t.Fatalf("frame type = %v, want a text message", typ)
		}
		seen = append(seen, wsDecode(t, data))
	}
}

func wsSend(t *testing.T, c *websocket.Conn, text string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte(text)); err != nil {
		t.Fatalf("send %s: %v", text, err)
	}
}

func wsOfKind(frames []wsFrame, kind string) []wsFrame {
	var out []wsFrame
	for _, f := range frames {
		if f.kind() == kind {
			out = append(out, f)
		}
	}
	return out
}

func waitFor(t *testing.T, d time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(msg)
}

func TestWebSocketAnnouncesTierBeforeAnyData(t *testing.T) {
	srv, _, _ := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=book,trades&interval=1s")

	tier := wsRead(t, c)
	if tier.kind() != "tier" {
		t.Fatalf("first frame on a connection = %q, want the tier handshake (raw: %s)", tier.kind(), tier.raw)
	}
	if got := tier.str(t, "tier"); got != string(TierFull) {
		t.Errorf("tier = %q, want %q", got, TierFull)
	}
	if got := tier.num(t, "rate"); got != TierFull.Rate() {
		t.Errorf("rate = %v, want %v", got, TierFull.Rate())
	}
	// The handshake is the literal frame PROTOCOL.md documents, field order and
	// all: the client renders it before any data, and the recording shows it.
	if want := `{"type":"tier","tier":"full","rate":4}`; string(tier.raw) != want {
		t.Errorf("tier frame = %s, want %s", tier.raw, want)
	}
}

func TestWebSocketStreamsTradesAndBookPerSubscription(t *testing.T) {
	srv, f, _ := wsFixture(t, 7, nil)

	both := wsDial(t, srv.URL, "?topics=book,trades")
	wsReadKind(t, both, "tier")
	tradesOnly := wsDial(t, srv.URL, "?topics=trades")
	wsReadKind(t, tradesOnly, "tier")
	chartOnly := wsDial(t, srv.URL, "?topics=chart&interval=1m")
	wsReadKind(t, chartOnly, "tier")

	// One scripted tick: the feed has never run, so every id below is known.
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	published, _ := f.Tick(start)
	book := f.Snapshot()

	frames := wsQuiet(t, both, 200*time.Millisecond)

	bookFrames := wsOfKind(frames, "book")
	if len(bookFrames) != 1 {
		t.Fatalf("book frames = %d, want exactly one per book change", len(bookFrames))
	}
	got := bookFrames[0].book(t)
	if got.Seq != book.Seq {
		t.Errorf("book frame seq = %d, want the feed's %d", got.Seq, book.Seq)
	}
	if got.PrevSeq != 0 {
		t.Errorf("first book frame claims parent %d, want 0 (the book this connection was told about at connect)", got.PrevSeq)
	}
	if len(got.Bids) != 10 || len(got.Asks) != 10 {
		t.Errorf("book frame has %d bids and %d asks, want 10x10", len(got.Bids), len(got.Asks))
	}
	for name, levels := range map[string][]Level{"bids": got.Bids, "asks": got.Asks} {
		for i, lvl := range levels {
			if !priceRE.MatchString(lvl.Price) {
				t.Errorf("%s[%d].price = %q, want a decimal string with 2 places", name, i, lvl.Price)
			}
			if !qtyRE.MatchString(lvl.Qty) {
				t.Errorf("%s[%d].qty = %q, want a decimal string with 6 places", name, i, lvl.Qty)
			}
		}
	}

	tradeFrames := wsOfKind(frames, "trade")
	if len(tradeFrames) != len(published) {
		t.Fatalf("trade frames = %d, want the %d trades the tick published", len(tradeFrames), len(published))
	}
	for i, frame := range tradeFrames {
		want := published[i]
		got := frame.trade(t)
		if got.Seq != want.Seq || got.TS != want.TS || got.Price != want.Price || got.Qty != want.Qty {
			t.Errorf("trade frame %d = %+v, want the feed's %+v", i, got, want)
		}
	}

	// The trades-only connection sees the same trades and never a book image.
	onlyFrames := wsQuiet(t, tradesOnly, 200*time.Millisecond)
	if extra := wsOfKind(onlyFrames, "book"); len(extra) != 0 {
		t.Errorf("topics=trades received %d book frame(s)", len(extra))
	}
	if got := len(wsOfKind(onlyFrames, "trade")); got != len(published) {
		t.Errorf("topics=trades received %d trade frames, want %d", got, len(published))
	}

	// The chart topic carries candles now (T4) and nothing else: no book image
	// and no trades, because this connection did not ask for them.
	chartFrames := wsQuiet(t, chartOnly, 200*time.Millisecond)
	candles := wsOfKind(chartFrames, "candle")
	if len(candles) != 1 {
		t.Fatalf("topics=chart produced %d candle frame(s) for one tick, want exactly one", len(candles))
	}
	candle := assertCandle(t, candles[0], "1m")
	if want := bucket(start, time.Minute); candle.T != want {
		t.Errorf("chart frame bucket = %q, want the live 1m bucket %q", candle.T, want)
	}
	if candle.Complete {
		t.Errorf("the only 1m bucket so far is still live, so its frame must not claim complete")
	}
	if extra := append(wsOfKind(chartFrames, "book"), wsOfKind(chartFrames, "trade")...); len(extra) != 0 {
		t.Errorf("topics=chart received %d book/trade frame(s)", len(extra))
	}
}

func TestWebSocketBookFramesChainOnFeedSpaceParents(t *testing.T) {
	srv, f, _ := wsFixture(t, 3, nil)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	// The feed ticked twice before this connection existed: the first frame the
	// client sees must claim the *current* book as its parent, not the feed's
	// first one, or every client would start life with a spurious gap.
	_, _ = f.Tick(start)
	_, _ = f.Tick(start.Add(time.Second))
	base := f.Snapshot().Seq

	c := wsDial(t, srv.URL, "?topics=book")
	wsReadKind(t, c, "tier")

	parent := base
	for i := 0; i < 4; i++ {
		_, _ = f.Tick(start.Add(time.Duration(i+2) * time.Second))

		frame := wsReadKind(t, c, "book").book(t)
		if frame.PrevSeq != parent {
			t.Fatalf("book frame %d claims parent %d, want the feed-space parent %d (single-step ticks, so it is also the seq last told)", i, frame.PrevSeq, parent)
		}
		if frame.Seq <= parent {
			t.Fatalf("book frame %d seq = %d, want an increase on %d", i, frame.Seq, parent)
		}
		parent = frame.Seq
	}
	if want := base + 4; parent != want {
		t.Fatalf("after four book changes the connection is at seq %d, want %d", parent, want)
	}

	// A burst of ticks the pump coalesces surfaces as a gap, not a silent
	// chain: the frame claims its feed-space parent (seq - 1), an id this
	// connection never saw, so the client refetches instead of building on a
	// state it missed. That is the same seam the gap injector pulls on purpose
	// (scenario_test.go); the pump just found it by lagging.
	sawGap := false
	for i := 0; i < 3; i++ {
		_, _ = f.Tick(start.Add(time.Duration(i+6) * time.Second))
	}
	for i := 0; parent < base+7 && i < 10; i++ {
		frame := wsReadKind(t, c, "book").book(t)
		if frame.PrevSeq != frame.Seq-1 {
			t.Fatalf("book frame {%d <- %d}: prevSeq must be the feed-space parent", frame.Seq, frame.PrevSeq)
		}
		if frame.Seq > parent+1 {
			sawGap = true
		} else if frame.PrevSeq != parent {
			t.Fatalf("chained book frame claims parent %d, want %d", frame.PrevSeq, parent)
		}
		if frame.Seq <= parent {
			t.Fatalf("book frame seq = %d, want an increase on %d", frame.Seq, parent)
		}
		parent = frame.Seq
	}
	if !sawGap {
		t.Fatalf("three coalesced ticks chained without a gap: skipped states must surface as a refetch trigger")
	}
	if want := base + 7; parent != want {
		t.Errorf("after a burst of three ticks the connection is at seq %d, want %d", parent, want)
	}
}

func TestWebSocketEchoesPingStampVerbatimWithServerTime(t *testing.T) {
	srv, _, _ := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=trades")
	wsReadKind(t, c, "tier")

	before := time.Now()
	wsSend(t, c, `{"type":"ping","tSend":1710842000123}`)
	pong := wsRead(t, c)

	if pong.kind() != "pong" {
		t.Fatalf("frame after a ping = %q, want pong (raw: %s)", pong.kind(), pong.raw)
	}
	// Verbatim: the stamp is a client clock reading, and re-encoding it through
	// float64 is how it would come back as 1.710842000123e+12.
	if want := `"tSend":1710842000123`; !strings.Contains(string(pong.raw), want) {
		t.Errorf("pong = %s, want it to echo %s", pong.raw, want)
	}
	if got := pong.num(t, "tSend"); got != 1710842000123 {
		t.Errorf("pong.tSend = %v, want 1710842000123", got)
	}

	recv := pong.str(t, "tRecv")
	at, err := time.Parse(time.RFC3339Nano, recv)
	if err != nil {
		t.Fatalf("pong.tRecv = %q, want UTC ISO-8601 (RFC3339Nano): %v", recv, err)
	}
	if at.Before(before.Add(-time.Second)) || at.After(time.Now().Add(time.Second)) {
		t.Errorf("pong.tRecv = %s, want the server's clock reading around %s", recv, before.UTC())
	}
	if !strings.HasSuffix(recv, "Z") {
		t.Errorf("pong.tRecv = %q, want UTC (trailing Z)", recv)
	}
}

func TestWebSocketAcceptsTierFramesAndSurvivesMalformedOnes(t *testing.T) {
	srv, _, _ := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=book,trades")
	wsReadKind(t, c, "tier")

	// report and force are the tier machine's to act on now, so this test uses
	// the shapes it must ignore: a bare report is consumed without a frame, and
	// a force that names no usable tier leaves the override and the stream
	// alone. The rest is what a devtools typo or a hostile client looks like,
	// and none of it may kill a live stream.
	for _, text := range []string{
		`{"type":"report","latencyMs":12.3,"jitterMs":4.1}`,
		`{"type":"force","tier":"fastest"}`,
		`{"type":"force"}`,
		`{"type":"something-additive","field":1}`,
		`{"type":"ping","tSend":"not-a-number"}`,
		`{"type":"ping"}`,
		`not json at all`,
		`[1,2,3]`,
	} {
		wsSend(t, c, text)
	}
	wsSend(t, c, `{"type":"ping","tSend":1}`)

	pong := wsRead(t, c)
	if pong.kind() != "pong" {
		t.Fatalf("frame after the malformed traffic = %q, want pong (raw: %s)", pong.kind(), pong.raw)
	}
	if got := pong.num(t, "tSend"); got != 1 {
		t.Errorf("pong.tSend = %v, want the stamp of the ping that followed the noise", got)
	}
	// Nothing was echoed for any of them, and the feed has not ticked.
	if extra := wsQuiet(t, c, 150*time.Millisecond); len(extra) != 0 {
		t.Errorf("server sent %d unexpected frame(s) after ignored traffic: %+v", len(extra), extra)
	}
}

func TestWebSocketSessionsAreReapedWhenTheClientLeaves(t *testing.T) {
	srv, _, s := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=book,trades")
	wsReadKind(t, c, "tier")

	if got := s.sessions.count(); got != 1 {
		t.Fatalf("live sessions = %d, want 1 while the socket is open", got)
	}

	if err := c.Close(websocket.StatusNormalClosure, "bye"); err != nil {
		t.Fatalf("client close: %v", err)
	}
	waitFor(t, 5*time.Second, func() bool { return s.sessions.count() == 0 },
		"session was never reaped: the reader or the pump outlived the client")
}

func TestWebSocketEvictsAConsumerWhoseReplyQueueIsFull(t *testing.T) {
	// The bounded queue is the second slow-consumer backstop (the write deadline
	// is the first): a client whose replies cannot drain must be disconnected,
	// never buffered without limit.
	stopped := make(chan struct{})
	sess := &wsSession{
		replies: make(chan []byte, 1),
		cancel:  func() { close(stopped) },
	}

	sess.enqueue([]byte("first")) // fits
	sess.enqueue([]byte("second"))

	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("a full reply queue did not end the session")
	}
	if reason := sess.outcome(); !strings.Contains(reason, "slow") {
		t.Errorf("eviction reason = %q, want one that names the slow consumer", reason)
	}
}

func TestWebSocketDropsAConsumerThatStopsReading(t *testing.T) {
	// A one-frame reply queue makes "this client stopped reading" land in well
	// under a second instead of after megabytes.
	srv, _, s := wsFixture(t, 42, func(s *server) {
		s.ws.queue = 1
		s.ws.writeTimeout = 250 * time.Millisecond
	})

	c := wsDial(t, srv.URL, "?topics=book,trades")
	wsReadKind(t, c, "tier")

	// Stop reading and keep the socket busy: every ping earns a reply the client
	// is not draining, so the queue has to give.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() {
		defer cancel()
		for i := 0; i < 200000; i++ {
			if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"ping","tSend":1}`)); err != nil {
				return
			}
		}
	}()

	// The behavior under test is the server's: it stops serving this consumer
	// and lets the session go, rather than buffering for a client that is not
	// listening. (Whether the client's own writes then fail depends on how much
	// the kernel buffered, so that is not the assertion.)
	waitFor(t, 15*time.Second, func() bool { return s.sessions.count() == 0 },
		"the server never dropped a client that stopped reading")

	// And the socket is dead rather than a live stream: draining whatever the
	// server managed to buffer ends in an error, never in more data.
	drained := 0
	for {
		rctx, cancelRead := context.WithTimeout(context.Background(), 5*time.Second)
		_, _, err := c.Read(rctx)
		cancelRead()
		if err != nil {
			break
		}
		drained++
		if drained > 100000 {
			t.Fatal("the evicted socket is still delivering frames")
		}
	}
}

func TestWebSocketClosesLiveSocketsOnShutdown(t *testing.T) {
	srv, _, s := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=book,trades")
	wsReadKind(t, c, "tier")

	s.shutdownWS()

	// The client's socket ends instead of hanging half-open while the process
	// exits: http.Server.Shutdown does not wait for hijacked connections, so
	// this is the only teardown a live socket ever gets. The page reconnects
	// from here (T5).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			break
		}
	}
	waitFor(t, 5*time.Second, func() bool { return s.sessions.count() == 0 },
		"a live session outlived the shutdown")
}

func TestWebSocketReapsAClientThatGoesSilent(t *testing.T) {
	// The idle window is PROTOCOL.md's probe cadence with room to spare, shrunk
	// here to make the reap observable in a test.
	srv, _, s := wsFixture(t, 42, func(s *server) { s.ws.idleTimeout = 150 * time.Millisecond })
	c := wsDial(t, srv.URL, "?topics=book,trades")
	wsReadKind(t, c, "tier")

	// Nothing else can be responsible for the teardown: the feed never ticks (so
	// there is nothing to write) and the client never closes. A half-open peer
	// looks exactly like this, and it must not hold a goroutine until TCP
	// keepalive notices hours later.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			break
		}
	}
	waitFor(t, 5*time.Second, func() bool { return s.sessions.count() == 0 },
		"a client that went silent was never reaped")
}

func TestWebSocketKeepsAClientThatKeepsProbing(t *testing.T) {
	// The other half of the deadline: a client doing what PROTOCOL.md says
	// (ping every 2s) must survive the window with room to spare, so the reaper
	// cannot be trigger-happy.
	srv, f, s := wsFixture(t, 42, func(s *server) { s.ws.idleTimeout = time.Second })
	c := wsDial(t, srv.URL, "?topics=book,trades")
	wsReadKind(t, c, "tier")

	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for i := 0; i < 4; i++ {
		_, _ = f.Tick(start.Add(time.Duration(i) * time.Second))
		wsSend(t, c, `{"type":"ping","tSend":1}`)
		// Each probe resets the window; the gap here is a tenth of it.
		time.Sleep(100 * time.Millisecond)
	}

	if got := s.sessions.count(); got != 1 {
		t.Fatalf("live sessions = %d, want the probing client still connected", got)
	}
}

func TestWebSocketRejectsUnusableSubscriptions(t *testing.T) {
	h := newHandler(testConfig(), NewFeed(1))

	for name, target := range map[string]string{
		"unknown topic":    "/ws?topics=banana",
		"empty topic list": "/ws?topics=,",
		"unsupported 5s":   "/ws?topics=book&interval=5s",
		"wrong case 1S":    "/ws?topics=book&interval=1S",
	} {
		t.Run(name, func(t *testing.T) {
			rec := get(t, h, target)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("GET %s status = %d, want %d", target, rec.Code, http.StatusBadRequest)
			}
			body := decode[map[string]any](t, rec)
			msg, ok := body["error"].(string)
			if !ok || msg == "" {
				t.Fatalf("GET %s body = %s, want a non-empty {\"error\": ...}", target, rec.Body.String())
			}
		})
	}
}
