package main

// tier_ws_test.go — behavior tests for per-connection adaptive delivery (SPEC
// Bullet 3, SEAMS Slice A's server half, issue #5).
//
// The seam is the socket a browser uses: scripted `report`/`force` frames in,
// `tier` frames out. tier.go owns the decision; these tests pin the contract
// around it — when a frame goes out, what it says, and that a debug override
// really overrides.

import (
	"net/http/httptest"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// The probes a client sends, by band: good sits comfortably inside full, bad
// sits in the degraded band (150–300ms), worst is past degraded, and the jitter
// spike is fast but twitchy — jitter is half of PROTOCOL.md's report.
const (
	reportGood        = `{"type":"report","latencyMs":20,"jitterMs":3}`
	reportBad         = `{"type":"report","latencyMs":200,"jitterMs":10}`
	reportWorst       = `{"type":"report","latencyMs":900,"jitterMs":80}`
	reportJitterSpike = `{"type":"report","latencyMs":40,"jitterMs":120}`
)

// assertTierFrame checks one tier frame: it names a decision and the rate the
// client renders beside it, so the badge on screen and the frames on the wire
// can never tell different stories.
func assertTierFrame(t *testing.T, frame wsFrame, want Tier) {
	t.Helper()
	if frame.kind() != "tier" {
		t.Fatalf("frame = %q, want tier (raw: %s)", frame.kind(), frame.raw)
	}
	if got := frame.str(t, "tier"); got != string(want) {
		t.Errorf("tier = %q, want %q", got, want)
	}
	if got := frame.num(t, "rate"); got != want.Rate() {
		t.Errorf("tier.rate = %v, want %v", got, want.Rate())
	}
}

// expectTier sends one report and asserts it produced the expected decision.
func expectTier(t *testing.T, c *websocket.Conn, report string, want Tier) {
	t.Helper()
	wsSend(t, c, report)
	assertTierFrame(t, wsRead(t, c), want)
}

// expectNoTierChange sends reports, then a ping, and asserts the next frame is
// the pong: the client's frames share one ordered queue, so a tier frame the
// reports should not have produced could not hide behind it. (Waiting out a
// timeout instead would end the session — a client read deadline closes the
// socket by design.)
func expectNoTierChange(t *testing.T, c *websocket.Conn, reports ...string) {
	t.Helper()
	for _, report := range reports {
		wsSend(t, c, report)
	}
	wsSend(t, c, `{"type":"ping","tSend":1}`)
	if frame := wsRead(t, c); frame.kind() != "pong" {
		t.Fatalf("%d report(s) produced a %q frame, want none before the pong (raw: %s)",
			len(reports), frame.kind(), frame.raw)
	}
}

// expectForce sends a force frame and asserts the decision it produced — and
// that it was decided at once rather than at the next window: a debug control
// the client just pressed has to move the badge now. (The probe window is 2s, so
// this bound sits four times tighter than the slowest probe-driven change.)
func expectForce(t *testing.T, c *websocket.Conn, frame string, want Tier) {
	t.Helper()
	started := time.Now()
	wsSend(t, c, frame)
	assertTierFrame(t, wsRead(t, c), want)
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Errorf("the forced tier took %v to be announced, want it as soon as the frame arrives", elapsed)
	}
}

func TestTierFollowsScriptedReportsBothWaysWithHysteresis(t *testing.T) {
	srv, _, _ := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=trades")
	assertTierFrame(t, wsRead(t, c), TierFull)

	// Two bad probes are a hiccup, not a decision: votes only count while they
	// agree, so it takes 3 consecutive ones to step down...
	expectNoTierChange(t, c, reportBad, reportBad)
	expectTier(t, c, reportBad, TierDegraded)

	// ...and a connection past the degraded band steps down again on the same
	// budget, one tier at a time.
	expectNoTierChange(t, c, reportWorst, reportWorst)
	expectTier(t, c, reportWorst, TierMinimal)

	// Up is deliberately harder than down (5 votes against 3): a recovering
	// connection must not flap back on four lucky probes.
	expectNoTierChange(t, c, reportGood, reportGood, reportGood, reportGood)
	expectTier(t, c, reportGood, TierDegraded)
	expectNoTierChange(t, c, reportGood, reportGood, reportGood, reportGood)
	expectTier(t, c, reportGood, TierFull)
}

func TestTierDoesNotFlapOnASingleSpike(t *testing.T) {
	srv, _, _ := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=trades")
	assertTierFrame(t, wsRead(t, c), TierFull)

	// Every spike here is followed by a good probe: no vote ever reaches three,
	// so the connection keeps the tier it is entitled to.
	expectNoTierChange(t, c,
		reportWorst, reportGood,
		reportJitterSpike, reportGood,
		reportBad, reportGood,
		reportWorst, reportGood,
	)

	// Jitter is not decoration: a fast but twitchy connection is not full-tier,
	// and a sustained twitch is enough to step down.
	expectNoTierChange(t, c, reportJitterSpike, reportJitterSpike)
	expectTier(t, c, reportJitterSpike, TierDegraded)
}

func TestTierFallsBackWhenReportsStopArriving(t *testing.T) {
	// The window is PROTOCOL.md's 2s probe cadence, shrunk so the fallback is
	// observable. A client that has gone quiet — stalled tab, hung proxy — can
	// never report that it is slow, so the backend has to act on the silence.
	srv, _, _ := wsFixture(t, 42, func(s *server) { s.ws.reportWindow = 25 * time.Millisecond })
	c := wsDial(t, srv.URL, "?topics=trades")
	assertTierFrame(t, wsRead(t, c), TierFull)

	// One probe lands in the first window; then the client says nothing at all.
	expectNoTierChange(t, c, reportGood)

	// 3 missed windows degrade, 6 minimize — the same budget as bad probes, and
	// no reports needed to get there.
	assertTierFrame(t, wsRead(t, c), TierDegraded)
	assertTierFrame(t, wsRead(t, c), TierMinimal)

	// A reconnect is a fresh session (CONTEXT.md): a new socket starts at full
	// and has to earn anything else.
	fresh := wsDial(t, srv.URL, "?topics=trades")
	assertTierFrame(t, wsRead(t, fresh), TierFull)
}

func TestForcedTierWinsUntilCleared(t *testing.T) {
	srv, _, _ := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=trades")
	assertTierFrame(t, wsRead(t, c), TierFull)

	// A forced tier is the decision from the moment it arrives: no probes, no
	// votes, no waiting for a window.
	expectForce(t, c, `{"type":"force","tier":"minimal"}`, TierMinimal)

	// Five good probes cannot lift a forced connection — the override, not the
	// probes, decides.
	expectNoTierChange(t, c, reportGood, reportGood, reportGood, reportGood, reportGood)

	// Clearing hands the decision back to the machine, which resumes from the
	// tier the override was holding and with a clean vote count, so climbing
	// back takes the same five good probes it always does.
	wsSend(t, c, `{"type":"force","tier":null}`)
	expectNoTierChange(t, c, reportGood, reportGood, reportGood, reportGood)
	expectTier(t, c, reportGood, TierDegraded)

	// Automatic is properly in charge again: bad probes drive it down.
	expectNoTierChange(t, c, reportWorst, reportWorst)
	expectTier(t, c, reportWorst, TierMinimal)

	// And an override is not a floor either: forced full ignores bad probes...
	expectForce(t, c, `{"type":"force","tier":"full"}`, TierFull)
	expectNoTierChange(t, c, reportWorst, reportWorst, reportWorst)

	// ...until it is cleared, after which the same 3 bad probes step it down.
	wsSend(t, c, `{"type":"force","tier":null}`)
	expectNoTierChange(t, c, reportWorst, reportWorst)
	expectTier(t, c, reportWorst, TierDegraded)
}

func TestForceIgnoresUnusableValues(t *testing.T) {
	srv, _, _ := wsFixture(t, 42, nil)
	c := wsDial(t, srv.URL, "?topics=trades")
	assertTierFrame(t, wsRead(t, c), TierFull)

	expectForce(t, c, `{"type":"force","tier":"minimal"}`, TierMinimal)

	// The shapes a debug control can actually be handed: a typo'd name, a
	// typo'd field, a bare frame, a number, an object. None of them may clear or
	// move the override — a control that half-acts on a typo is worse than one
	// that does nothing — and none of them may kill the stream either.
	for _, frame := range []string{
		`{"type":"force","tier":"fastest"}`,
		`{"type":"force","tiers":"full"}`,
		`{"type":"force"}`,
		`{"type":"force","tier":3}`,
		`{"type":"force","tier":{}}`,
	} {
		wsSend(t, c, frame)
	}
	// Still forced at minimal: bad probes would otherwise have degraded it.
	expectNoTierChange(t, c, reportWorst, reportWorst, reportWorst)

	// And the override is still the thing a valid frame clears.
	wsSend(t, c, `{"type":"force","tier":null}`)
	expectNoTierChange(t, c, reportGood, reportGood, reportGood, reportGood)
	expectTier(t, c, reportGood, TierDegraded)
}

// TestTierBandsComeFromConfig drives the same scripted probes against a server
// started with different bands: the numbers a session decides on are deployment
// config (main.go's TIER_* env, README "Tiers"), so the same reports must
// decide differently. If the bands were baked into the session, this test could
// not move them — and "local and deployed differ by config, not code" would be
// decoration rather than a property.
func TestTierBandsComeFromConfig(t *testing.T) {
	cfg := testConfig()
	cfg.Tier = DefaultTierConfig()
	cfg.Tier.FullMaxLatency = 5 * time.Millisecond // reportGood's 20ms no longer fits full
	cfg.Tier.UpVotes = 2                           // and climbing back is cheap here

	s := newServer(cfg, NewFeed(42))
	srv := httptest.NewServer(s.routes())
	t.Cleanup(srv.Close)

	c := wsDial(t, srv.URL, "?topics=trades")
	assertTierFrame(t, wsRead(t, c), TierFull) // every session opens at full

	// Under the shipped 150ms edge these probes are a full-tier client; under
	// this config's 5ms edge the same probes are a degraded one after 3 votes.
	expectNoTierChange(t, c, reportGood, reportGood)
	expectTier(t, c, reportGood, TierDegraded)

	// Two probes inside *this* config's 5ms full edge are enough to climb back
	// (UpVotes 2, not the shipped 5): the vote budgets are config as much as the
	// latency edges. reportGood cannot do it here — at 20ms it is a degraded-band
	// probe under these bands, which is the point of moving the edges.
	const fast = `{"type":"report","latencyMs":1,"jitterMs":0}`
	expectNoTierChange(t, c, fast)
	expectTier(t, c, fast, TierFull)
}
