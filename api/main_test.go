package main

// main_test.go — handler-seam tests for the walking-skeleton HTTP surface.
// Behavior only: given a seed and scripted ticks, assert what a browser sees
// on the wire (status, JSON shape, decimal strings, ordering ids).

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

var (
	priceRE = regexp.MustCompile(`^[0-9]+\.[0-9]{2}$`)
	qtyRE   = regexp.MustCompile(`^[0-9]+\.[0-9]{6}$`)
)

func testConfig() Config {
	return Config{Port: defaultPort, Seed: 42, Symbol: defaultSymbol}
}

// do issues one request against the handler under test.
func do(t *testing.T, h http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, h, http.MethodGet, target, nil)
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not valid JSON for the declared shape: %v\nbody: %s", err, rec.Body.String())
	}
	return out
}

func mustFloat(t *testing.T, s string) float64 {
	t.Helper()
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("wire value %q is not a decimal number: %v", s, err)
	}
	return v
}

func closeEnough(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("%s = %.10f, want %.10f", label, got, want)
	}
}

func bucket(now time.Time, d time.Duration) string {
	return now.Truncate(d).UTC().Format(time.RFC3339Nano)
}

// scriptTicks advances the feed once per step and returns the trades the feed
// published for each step, preserving wire strings exactly as a client sees them.
func scriptTicks(f *Feed, start time.Time, steps int, step time.Duration) [][]Trade {
	perTick := make([][]Trade, 0, steps)
	for i := 0; i < steps; i++ {
		trades, _ := f.Tick(start.Add(time.Duration(i) * step))
		perTick = append(perTick, trades)
	}
	return perTick
}

func TestConfigEndpointAdvertisesSymbolIntervalsAndSeed(t *testing.T) {
	rec := get(t, newHandler(testConfig(), NewFeed(42)), "/api/config")

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("config is not valid JSON: %v\nbody: %s", err, rec.Body.String())
	}
	want := map[string]any{
		"symbol":    "BTC-USD",
		"intervals": []any{"1s", "1m"},
		"seed":      float64(42),
		"protocol":  float64(2),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("GET /api/config body = %v, want %v", got, want)
	}
}

func TestConfigEndpointReflectsEnvBasedConfig(t *testing.T) {
	cfg := Config{Port: "9999", Seed: 7, Symbol: "ETH-USD"}
	got := decode[map[string]any](t, get(t, newHandler(cfg, NewFeed(cfg.Seed)), "/api/config"))

	if got["symbol"] != "ETH-USD" || got["seed"] != float64(7) {
		t.Fatalf("config endpoint ignored supplied config: %v", got)
	}
}

func TestLoadConfigDefaultsAndEnvOverrides(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("SEED", "")
	t.Setenv("SYMBOL", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig with no env: unexpected error %v", err)
	}
	if cfg.Port != "8080" || cfg.Seed != 42 || cfg.Symbol != "BTC-USD" {
		t.Fatalf("defaults = %+v, want PORT 8080 / SEED 42 / SYMBOL BTC-USD", cfg)
	}

	t.Setenv("PORT", "9999")
	t.Setenv("SEED", "7")
	t.Setenv("SYMBOL", "ETH-USD")

	cfg, err = loadConfig()
	if err != nil {
		t.Fatalf("loadConfig with override env: unexpected error %v", err)
	}
	if cfg.Port != "9999" || cfg.Seed != 7 || cfg.Symbol != "ETH-USD" {
		t.Fatalf("overrides = %+v, want PORT 9999 / SEED 7 / SYMBOL ETH-USD", cfg)
	}

	t.Setenv("SEED", "not-a-number")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted a non-numeric SEED; want a config error")
	}
}

// TestTierBandsComeFromEnv pins the deployment half of deliverable "local and
// deployed differ by config, not code": the band edges and vote budgets are
// env-derived, the shipped values are the defaults, and a value the process
// cannot honour is an error rather than a silent fallback (the badge renders
// these numbers, so pretending to run others would make it lie).
func TestTierBandsComeFromEnv(t *testing.T) {
	keys := []string{
		envTierFullMaxMS, envTierDegradedMaxMS, envTierMaxJitterMS,
		envTierDownVotes, envTierUpVotes, envTierMissDegraded, envTierMissMinimal,
	}
	for _, key := range keys {
		t.Setenv(key, "")
	}

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig with no tier env: unexpected error %v", err)
	}
	if cfg.Tier != DefaultTierConfig() {
		t.Fatalf("tier = %+v, want the shipped bands %+v", cfg.Tier, DefaultTierConfig())
	}

	for key, value := range map[string]string{
		envTierFullMaxMS:     "80",
		envTierDegradedMaxMS: "250",
		envTierMaxJitterMS:   "0",
		envTierDownVotes:     "2",
		envTierUpVotes:       "4",
		envTierMissDegraded:  "5",
		envTierMissMinimal:   "7",
	} {
		t.Setenv(key, value)
	}

	cfg, err = loadConfig()
	if err != nil {
		t.Fatalf("loadConfig with tier overrides: unexpected error %v", err)
	}
	want := TierConfig{
		FullMaxLatency: 80 * time.Millisecond,
		DegMaxLatency:  250 * time.Millisecond,
		MaxJitter:      0,
		DownVotes:      2,
		UpVotes:        4,
		MissToDegraded: 5,
		MissToMinimal:  7,
	}
	if cfg.Tier != want {
		t.Fatalf("tier = %+v, want %+v", cfg.Tier, want)
	}

	t.Setenv(envTierFullMaxMS, "soon")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted a non-numeric TIER_FULL_MAX_MS; want a config error")
	}
	t.Setenv(envTierFullMaxMS, "80")
	t.Setenv(envTierMissDegraded, "0")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted TIER_MISS_DEGRADED=0; want a config error")
	}
}

func TestSnapshotEndpointServesTenByTenDecimalBookWithOrderingID(t *testing.T) {
	f := NewFeed(42)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	scriptTicks(f, start, 3, time.Second)

	rec := get(t, newHandler(testConfig(), f), "/api/snapshot")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/snapshot status = %d, want %d", rec.Code, http.StatusOK)
	}
	book := decode[Book](t, rec)

	if book.Seq == 0 {
		t.Error("snapshot carries no ordering id (seq = 0)")
	}
	if len(book.Bids) != 10 {
		t.Errorf("snapshot bids = %d levels, want 10", len(book.Bids))
	}
	if len(book.Asks) != 10 {
		t.Errorf("snapshot asks = %d levels, want 10", len(book.Asks))
	}

	var prevBid, prevAsk float64
	for i, side := range []struct {
		name   string
		levels []Level
	}{{"bids", book.Bids}, {"asks", book.Asks}} {
		for j, lvl := range side.levels {
			if !priceRE.MatchString(lvl.Price) {
				t.Errorf("%s[%d] price = %q, want a decimal string with 2 places", side.name, j, lvl.Price)
			}
			if !qtyRE.MatchString(lvl.Qty) {
				t.Errorf("%s[%d] qty = %q, want a decimal string with 6 places", side.name, j, lvl.Qty)
			}
			px := mustFloat(t, lvl.Price)
			if i == 0 { // bids descend away from the mid
				if j > 0 && px >= prevBid {
					t.Errorf("bids not descending at level %d: %v then %v", j, prevBid, px)
				}
				prevBid = px
			} else { // asks ascend
				if j > 0 && px <= prevAsk {
					t.Errorf("asks not ascending at level %d: %v then %v", j, prevAsk, px)
				}
				prevAsk = px
			}
		}
	}
	if len(book.Bids) == 10 && len(book.Asks) == 10 {
		if bestBid, bestAsk := mustFloat(t, book.Bids[0].Price), mustFloat(t, book.Asks[0].Price); bestBid >= bestAsk {
			t.Errorf("book is crossed: best bid %v >= best ask %v", bestBid, bestAsk)
		}
	}
}

func TestHistoryEndpointAggregatesCompletedCandlesOldestFirst(t *testing.T) {
	f := NewFeed(7)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	perTick := scriptTicks(f, start, 3, time.Second)

	rec := get(t, newHandler(testConfig(), f), "/api/history?interval=1s&limit=120")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/history status = %d, want %d", rec.Code, http.StatusOK)
	}
	body := decode[historyResponse](t, rec)

	if body.Interval != "1s" {
		t.Errorf("history interval echo = %q, want %q", body.Interval, "1s")
	}
	// Three 1s ticks: the third bucket is still live, so only two are complete.
	if len(body.Candles) != 2 {
		t.Fatalf("history candles = %d, want 2 completed buckets (live bucket withheld)", len(body.Candles))
	}

	for i, c := range body.Candles {
		wantT := bucket(start.Add(time.Duration(i)*time.Second), time.Second)
		if c.T != wantT {
			t.Errorf("candles[%d].t = %q, want %q", i, c.T, wantT)
		}
		if _, err := time.Parse(time.RFC3339Nano, c.T); err != nil {
			t.Errorf("candles[%d].t = %q, want UTC ISO-8601: %v", i, c.T, err)
		}
		if i > 0 && body.Candles[i-1].T >= c.T {
			t.Errorf("candles not oldest-first: %q then %q", body.Candles[i-1].T, c.T)
		}
		for label, v := range map[string]string{"o": c.O, "h": c.H, "l": c.L, "c": c.C} {
			if !priceRE.MatchString(v) {
				t.Errorf("candles[%d].%s = %q, want a decimal string with 2 places", i, label, v)
			}
		}
		if !qtyRE.MatchString(c.V) {
			t.Errorf("candles[%d].v = %q, want a decimal string with 6 places", i, c.V)
		}

		trades := perTick[i]
		hi, lo, vol := mustFloat(t, trades[0].Price), mustFloat(t, trades[0].Price), 0.0
		for _, tr := range trades {
			px := mustFloat(t, tr.Price)
			hi, lo = math.Max(hi, px), math.Min(lo, px)
			vol += mustFloat(t, tr.Qty)
		}
		if c.O != trades[0].Price {
			t.Errorf("candles[%d].o = %q, want the bucket's first trade price %q", i, c.O, trades[0].Price)
		}
		if c.C != trades[len(trades)-1].Price {
			t.Errorf("candles[%d].c = %q, want the bucket's last trade price %q", i, c.C, trades[len(trades)-1].Price)
		}
		closeEnough(t, "candle high", mustFloat(t, c.H), hi)
		closeEnough(t, "candle low", mustFloat(t, c.L), lo)
		closeEnough(t, "candle volume", mustFloat(t, c.V), vol)
	}
}

func TestHistoryEndpointHonoursIntervalAndLimit(t *testing.T) {
	f := NewFeed(7)
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	scriptTicks(f, start, 5, time.Second)
	// Five 1s buckets, four complete; one 1m bucket, still live.
	h := newHandler(testConfig(), f)

	t.Run("1m over a single minute withholds the live bucket as an explicit empty list", func(t *testing.T) {
		rec := get(t, h, "/api/history?interval=1m")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		var raw struct {
			Interval string          `json:"interval"`
			Candles  json.RawMessage `json:"candles"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("history is not valid JSON: %v", err)
		}
		if raw.Interval != "1m" {
			t.Errorf("interval echo = %q, want %q", raw.Interval, "1m")
		}
		if got := strings.TrimSpace(string(raw.Candles)); got != "[]" {
			t.Errorf("candles = %s, want [] (empty, never null)", got)
		}
	})

	t.Run("limit keeps the newest complete candles", func(t *testing.T) {
		body := decode[historyResponse](t, get(t, h, "/api/history?interval=1s&limit=2"))
		if len(body.Candles) != 2 {
			t.Fatalf("candles = %d, want 2", len(body.Candles))
		}
		wantLast := bucket(start.Add(3*time.Second), time.Second)
		wantFirst := bucket(start.Add(2*time.Second), time.Second)
		if body.Candles[1].T != wantLast || body.Candles[0].T != wantFirst {
			t.Errorf("limit=2 returned %q..%q, want %q..%q",
				body.Candles[0].T, body.Candles[1].T, wantFirst, wantLast)
		}
	})

	t.Run("default limit is 120", func(t *testing.T) {
		body := decode[historyResponse](t, get(t, h, "/api/history?interval=1s"))
		if len(body.Candles) != 4 {
			t.Fatalf("candles = %d, want all 4 complete buckets", len(body.Candles))
		}
	})
}

func TestHistoryEndpointRejectsUnusableRequests(t *testing.T) {
	h := newHandler(testConfig(), NewFeed(1))
	cases := map[string]string{
		"missing interval":  "/api/history",
		"unsupported 5s":    "/api/history?interval=5s",
		"wrong case 1S":     "/api/history?interval=1S",
		"garbage interval":  "/api/history?interval=banana",
		"zero limit":        "/api/history?interval=1s&limit=0",
		"negative limit":    "/api/history?interval=1s&limit=-5",
		"non-numeric limit": "/api/history?interval=1s&limit=abc",
	}
	for name, target := range cases {
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

func TestCORSOpenForLocalDevOrigins(t *testing.T) {
	h := newHandler(testConfig(), NewFeed(1))

	t.Run("preflight is answered without reaching the route", func(t *testing.T) {
		rec := do(t, h, http.MethodOptions, "/api/snapshot", map[string]string{
			"Origin":                         "http://localhost:5173",
			"Access-Control-Request-Method":  "GET",
			"Access-Control-Request-Headers": "content-type",
		})
		if rec.Code != http.StatusNoContent {
			t.Fatalf("preflight status = %d, want %d", rec.Code, http.StatusNoContent)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "GET") {
			t.Errorf("Access-Control-Allow-Methods = %q, want it to include GET", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(strings.ToLower(got), "content-type") {
			t.Errorf("Access-Control-Allow-Headers = %q, want it to include content-type", got)
		}
	})

	t.Run("actual requests carry the allow-origin header from any origin", func(t *testing.T) {
		for _, origin := range []string{"http://localhost:5173", "https://preview.example.dev"} {
			rec := do(t, h, http.MethodGet, "/api/config", map[string]string{"Origin": origin})
			if rec.Code != http.StatusOK {
				t.Fatalf("GET /api/config from %s status = %d, want %d", origin, rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("access-control-allow-origin for %s = %q, want *", origin, got)
			}
		}
	})
}

func TestReadOnlyEndpointsRejectOtherMethods(t *testing.T) {
	h := newHandler(testConfig(), NewFeed(1))
	for _, path := range []string{"/api/config", "/api/snapshot", "/api/history?interval=1s"} {
		rec := do(t, h, http.MethodPost, path, nil)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s status = %d, want %d", path, rec.Code, http.StatusMethodNotAllowed)
		}
	}
}

func TestTickLoopKeepsTickingUntilCancelled(t *testing.T) {
	if tickInterval != 100*time.Millisecond {
		t.Fatalf("tick interval = %v, want 100ms", tickInterval)
	}
	f := NewFeed(1)
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		runTicks(ctx, f, 2*time.Millisecond)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for f.Snapshot().Seq == 0 {
		if time.Now().After(deadline) {
			cancel()
			<-stopped
			t.Fatal("feed never advanced: tick loop is not running")
		}
		time.Sleep(2 * time.Millisecond)
	}

	cancel()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("tick loop did not return after cancel")
	}
	seq := f.Snapshot().Seq
	time.Sleep(30 * time.Millisecond)
	if got := f.Snapshot().Seq; got != seq {
		t.Fatalf("snapshot seq moved from %d to %d after cancel; ticker kept ticking", seq, got)
	}
}
