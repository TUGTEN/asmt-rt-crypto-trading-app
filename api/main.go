package main

// main.go — the HTTP surface: env config, a 100ms tick loop that drives the
// seeded feed, the read-only REST routes the page needs (config, book snapshot,
// candle history), the scenario injector the recording and tests drive
// (POST /api/scenario, feed.go), and the WebSocket stream (ws.go) the book and
// tape ride on (Bullet 1).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// tickInterval is the market heartbeat: one feed step per 100ms.
const tickInterval = 100 * time.Millisecond

const (
	shutdownGrace = 5 * time.Second
	defaultPort   = "8080"
	defaultSeed   = 42
	defaultSymbol = "BTC-USD"
	defaultLimit  = 120
)

// Interval is one candle duration the API offers; Label is its wire form.
type Interval struct {
	Label string
	Dur   time.Duration
}

// intervals is the single source of truth for candle intervals: /api/config
// advertises it, /api/history validates against it, and /ws subscribes to it.
// It is a code constant rather than an env var because the feed aggregates
// exactly these buckets (feed.go's Tick): an interval the feed does not
// aggregate would serve an empty history, which is worse than not offering it.
// Widening it is a one-line change here plus the feed's accumulation.
var intervals = []Interval{
	{Label: "1s", Dur: time.Second},
	{Label: "1m", Dur: time.Minute},
}

// Config is env-derived runtime configuration. Nothing else reads the
// environment, so local and deployed behavior differ by config, not code.
// Environment keys — the whole runtime configuration surface of the API
// (README "Configuration"). Anything not listed here is a code constant, and
// deliberately so: the interval set must match what the feed aggregates (see
// `intervals`), and the connection hygiene budget is transport plumbing.
const (
	envPort              = "PORT"
	envSeed              = "SEED"
	envSymbol            = "SYMBOL"
	envTierFullMaxMS     = "TIER_FULL_MAX_MS"
	envTierDegradedMaxMS = "TIER_DEGRADED_MAX_MS"
	envTierMaxJitterMS   = "TIER_MAX_JITTER_MS"
	envTierDownVotes     = "TIER_DOWN_VOTES"
	envTierUpVotes       = "TIER_UP_VOTES"
	envTierMissDegraded  = "TIER_MISS_DEGRADED"
	envTierMissMinimal   = "TIER_MISS_MINIMAL"
)

// Config is env-derived runtime configuration. Nothing else reads the
// environment, so local and deployed behavior differ by config, not code.
type Config struct {
	Port   string
	Seed   int64
	Symbol string
	// Tier is the delivery policy every connection is given. A zero value
	// means "the shipped defaults" (tierConfig), so a Config literal — a test,
	// or any caller that only cares about the port — is never a machine with
	// all-zero thresholds.
	Tier TierConfig
}

// tierConfig is the tier policy to run: what was configured, or the shipped
// defaults when nothing was.
func (c Config) tierConfig() TierConfig {
	if c.Tier == (TierConfig{}) {
		return DefaultTierConfig()
	}
	return c.Tier
}

// loadConfig reads the environment (envPort/envSeed/envSymbol and the TIER_*
// band edges), falling back to dev defaults. A malformed SEED or threshold is
// an error rather than a silent fallback: a demo that reports a seed it did not
// use, or bands other than the ones it is running, is a lie about determinism.
func loadConfig() (Config, error) {
	cfg := Config{Port: defaultPort, Seed: defaultSeed, Symbol: defaultSymbol, Tier: DefaultTierConfig()}
	if v := os.Getenv(envPort); v != "" {
		cfg.Port = v
	}
	if v := os.Getenv(envSymbol); v != "" {
		cfg.Symbol = v
	}
	if v := os.Getenv(envSeed); v != "" {
		seed, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("%s %q must be an integer: %w", envSeed, v, err)
		}
		cfg.Seed = seed
	}

	tier, err := tierConfigFromEnv(cfg.Tier)
	if err != nil {
		return Config{}, err
	}
	cfg.Tier = tier
	return cfg, nil
}

// tierConfigFromEnv applies the TIER_* overrides onto base. The bands are the
// numbers the README justifies and the tier badge renders, so they are
// configuration like the seed: retune them for a deployment without a rebuild.
func tierConfigFromEnv(base TierConfig) (TierConfig, error) {
	tier := base
	durations := []struct {
		key string
		dst *time.Duration
	}{
		{envTierFullMaxMS, &tier.FullMaxLatency},
		{envTierDegradedMaxMS, &tier.DegMaxLatency},
		{envTierMaxJitterMS, &tier.MaxJitter},
	}
	for _, o := range durations {
		ms, err := envMS(o.key, *o.dst)
		if err != nil {
			return TierConfig{}, err
		}
		*o.dst = ms
	}

	counts := []struct {
		key string
		dst *int
	}{
		{envTierDownVotes, &tier.DownVotes},
		{envTierUpVotes, &tier.UpVotes},
		{envTierMissDegraded, &tier.MissToDegraded},
		{envTierMissMinimal, &tier.MissToMinimal},
	}
	for _, o := range counts {
		n, err := envCount(o.key, *o.dst)
		if err != nil {
			return TierConfig{}, err
		}
		*o.dst = n
	}
	return tier, nil
}

// envMS reads a non-negative millisecond value, or def when unset.
func envMS(key string, def time.Duration) (time.Duration, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms < 0 {
		return 0, fmt.Errorf("%s %q must be a non-negative integer of milliseconds", key, raw)
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// envCount reads a positive count, or def when unset.
func envCount(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%s %q must be a positive integer", key, raw)
	}
	return n, nil
}

func intervalFor(label string) (time.Duration, bool) {
	for _, iv := range intervals {
		if iv.Label == label {
			return iv.Dur, true
		}
	}
	return 0, false
}

func intervalLabels() []string {
	labels := make([]string, 0, len(intervals))
	for _, iv := range intervals {
		labels = append(labels, iv.Label)
	}
	return labels
}

// configResponse is the boot payload: what market this server simulates and
// which intervals it will serve.
type configResponse struct {
	Symbol    string   `json:"symbol"`
	Intervals []string `json:"intervals"`
	Seed      int64    `json:"seed"`
	// Protocol is the wire version (PROTOCOL.md "Versioning"): 2 = compact tuples.
	Protocol int `json:"protocol"`
}

type historyResponse struct {
	Interval string   `json:"interval"`
	Candles  []Candle `json:"candles"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// scenarioRequest and scenarioResponse are the injector's wire shape
// (docs/PROTOCOL.md "Scenario injector"): `scenario` is the armed or in-effect
// scenario, or null when the feed is running from the seed alone.
type scenarioRequest struct {
	Scenario string `json:"scenario"`
}

type scenarioResponse struct {
	Scenario *Scenario `json:"scenario"`
}

type server struct {
	cfg  Config
	feed *Feed

	// WebSocket delivery state: this process's hygiene budget and every live
	// session, so shutdown can close them (hijacked connections are invisible to
	// http.Server).
	ws       wsPolicy
	sessions *wsRegistry
}

// newServer builds the API surface over a feed. Tests drive the same handler the
// process serves, so the seam is the wire, not a helper.
func newServer(cfg Config, f *Feed) *server {
	cfg.Tier = cfg.tierConfig() // a zero Tier means the shipped defaults
	return &server{cfg: cfg, feed: f, ws: defaultWSPolicy(), sessions: newWSRegistry()}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/snapshot", s.handleSnapshot)
	mux.HandleFunc("GET /api/history", s.handleHistory)
	mux.HandleFunc("GET /api/scenario", s.handleScenarioGet)
	mux.HandleFunc("POST /api/scenario", s.handleScenarioPost)
	mux.HandleFunc("GET /ws", s.handleWS)
	return withCORS(mux)
}

// newHandler builds the full HTTP surface over a feed: the same routes the
// process serves, in one handler a test can drive.
func newHandler(cfg Config, f *Feed) http.Handler {
	return newServer(cfg, f).routes()
}

func (s *server) handleConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, configResponse{
		Symbol:    s.cfg.Symbol,
		Intervals: intervalLabels(),
		Seed:      s.cfg.Seed,
		Protocol:  2,
	})
}

func (s *server) handleSnapshot(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.feed.Snapshot())
}

func (s *server) handleHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	label := q.Get("interval")
	d, ok := intervalFor(label)
	if !ok {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("unsupported interval %q, want one of %s", label, strings.Join(intervalLabels(), ", ")))
		return
	}

	limit := defaultLimit
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid limit %q, want a positive integer", raw))
			return
		}
		limit = n
	}

	writeJSON(w, http.StatusOK, historyResponse{Interval: label, Candles: s.feed.History(d, limit)})
}

// handleScenarioGet reports what the injector is currently doing, so the debug
// control can render the truth instead of what it last asked for.
func (s *server) handleScenarioGet(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, scenarioPayload(s.feed.ArmedScenario()))
}

// handleScenarioPost injects a scripted market event (docs/PROTOCOL.md
// "Scenario injector"). An unknown name is a 400 with the accepted vocabulary,
// like an unknown interval in /api/history: the caller must be able to tell
// "armed" from "never happened".
func (s *server) handleScenarioPost(w http.ResponseWriter, r *http.Request) {
	var req scenarioRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("invalid scenario body, want {\"scenario\":\"<one of %s>\"}: %v", scenarioList(), err))
		return
	}
	if err := s.feed.ArmScenario(req.Scenario); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, scenarioPayload(s.feed.ArmedScenario()))
}

// scenarioPayload renders an armed scenario for the wire; disarmed is `null`,
// which a client reads as "the market is running from the seed".
func scenarioPayload(s Scenario) scenarioResponse {
	if s == "" {
		return scenarioResponse{}
	}
	return scenarioResponse{Scenario: &s}
}

// withCORS opens every origin — the API is read-only and credential-free, and
// local dev serves the UI from a different port. Preflights are answered here
// so they never reach a route that only accepts GET.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}

// runTicks advances the market every d until ctx is cancelled. Regeneration
// never depends on wall-clock drift, only on the tick itself.
func runTicks(ctx context.Context, f *Feed, d time.Duration) {
	ticker := time.NewTicker(d)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			f.Tick(now)
		}
	}
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	feed := NewFeed(cfg.Seed)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go runTicks(ctx, feed, tickInterval)

	api := newServer(cfg, feed)
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           api.routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	served := make(chan error, 1)
	go func() {
		tier := cfg.tierConfig()
		log.Printf("listening on :%s — symbol=%s seed=%d intervals=%s tick=%s",
			cfg.Port, cfg.Symbol, cfg.Seed, strings.Join(intervalLabels(), ","), tickInterval)
		log.Printf("tier bands — full<=%s jitter<=%s degraded<=%s down=%d up=%d miss=%d/%d",
			tier.FullMaxLatency, tier.MaxJitter, tier.DegMaxLatency,
			tier.DownVotes, tier.UpVotes, tier.MissToDegraded, tier.MissToMinimal)
		served <- srv.ListenAndServe()
	}()

	select {
	case err := <-served:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server: %v", err)
		}
	case <-ctx.Done():
		log.Print("signal received, shutting down")
		// Hijacked WebSocket connections are invisible to Shutdown, so they are
		// ended first: a socket left open would only be killed by the process
		// exiting, and the client would sit on a half-open connection.
		api.shutdownWS()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown: %v", err)
		}
	}
}
