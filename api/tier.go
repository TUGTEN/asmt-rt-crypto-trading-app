package main

// tier.go — per-connection delivery tier: full/degraded/minimal.
// Backend owns the decision; the client only reports latency+jitter.

import "time"

type Tier string

const (
	TierFull     Tier = "full"
	TierDegraded Tier = "degraded"
	TierMinimal  Tier = "minimal"
)

// Rates in chart updates/sec the tier entitles a connection to.
func (t Tier) Rate() float64 {
	switch t {
	case TierDegraded:
		return 1
	case TierMinimal:
		return 0.25
	default:
		return 4
	}
}

type TierConfig struct {
	FullMaxLatency time.Duration // <= this && jitter ok -> full candidate
	DegMaxLatency  time.Duration // <= this -> degraded candidate, else minimal
	MaxJitter      time.Duration
	DownVotes      int // consecutive bad probes to step down
	UpVotes        int // consecutive good probes to step up
	MissToDegraded int
	MissToMinimal  int
}

func DefaultTierConfig() TierConfig {
	return TierConfig{
		FullMaxLatency: 150 * time.Millisecond,
		DegMaxLatency:  300 * time.Millisecond,
		MaxJitter:      50 * time.Millisecond,
		DownVotes:      3,
		UpVotes:        5,
		MissToDegraded: 3,
		MissToMinimal:  6,
	}
}

type TierMachine struct {
	cfg    TierConfig
	tier   Tier
	forced *Tier // debug override; nil = automatic
	up, dn int
	missed int
}

func NewTierMachine(cfg TierConfig) *TierMachine {
	return &TierMachine{cfg: cfg, tier: TierFull}
}

func (m *TierMachine) Tier() Tier { return m.tier }

// Force sets/clears the debug override. Forced tier wins immediately.
func (m *TierMachine) Force(t *Tier) { m.forced = t }

// Report feeds one client latency+jitter probe.
func (m *TierMachine) Report(latency, jitter time.Duration) {
	m.missed = 0
	if m.forced != nil {
		m.tier = *m.forced
		return
	}
	want := TierMinimal
	if latency <= m.cfg.DegMaxLatency {
		want = TierDegraded
	}
	if latency <= m.cfg.FullMaxLatency && jitter <= m.cfg.MaxJitter {
		want = TierFull
	}
	m.step(want)
}

// Miss records a missing report (no probe in the expected window).
func (m *TierMachine) Miss() {
	if m.forced != nil {
		m.tier = *m.forced
		return
	}
	m.missed++
	m.up, m.dn = 0, 0
	switch {
	case m.missed >= m.cfg.MissToMinimal:
		m.tier = TierMinimal
	case m.missed >= m.cfg.MissToDegraded && m.tier == TierFull:
		m.tier = TierDegraded
	}
}

func rank(t Tier) int {
	switch t {
	case TierFull:
		return 2
	case TierDegraded:
		return 1
	default:
		return 0
	}
}

// step moves at most one tier per call, with asymmetric hysteresis.
func (m *TierMachine) step(want Tier) {
	switch {
	case rank(want) < rank(m.tier):
		m.up = 0
		m.dn++
		if m.dn >= m.cfg.DownVotes {
			m.dn = 0
			if m.tier == TierFull {
				m.tier = TierDegraded
			} else {
				m.tier = TierMinimal
			}
		}
	case rank(want) > rank(m.tier):
		m.dn = 0
		m.up++
		if m.up >= m.cfg.UpVotes {
			m.up = 0
			if m.tier == TierMinimal {
				m.tier = TierDegraded
			} else {
				m.tier = TierFull
			}
		}
	default:
		m.up, m.dn = 0, 0
	}
}
