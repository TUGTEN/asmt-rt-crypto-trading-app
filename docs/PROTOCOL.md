# Wire Protocol — REST + WebSocket

Single source of truth for the wire. Backend and frontend must match this;
change it here first, in one commit, before touching code on either side.

## Conventions

- Money crosses the wire as **decimal strings** (`"65000.12"`, `"0.002500"`).
- Timestamps are **UTC ISO-8601** (`time.RFC3339Nano`).
- Every market-data message carries an **ordering id** (`seq`, `uint64`).
- Base URL from env (`NEXT_PUBLIC_API_URL`, default `http://localhost:8080`).
  The WS endpoint replaces the scheme (`ws://` / `wss://`).

## REST

| Method | Path | Response |
|---|---|---|
| GET | `/api/config` | `{"symbol":"BTC-USD","intervals":["1s","1m"],"seed":42,"protocol":2}` |
| GET | `/api/snapshot` | `{"seq":N,"bids":[["price","qty"]×10],"asks":[…]}` |
| GET | `/api/history?interval=1s\|1m&limit=N` | `{"interval":"1s","candles":[["t","o","h","l","c","v"]]}` oldest-first, `[]` never `null`; bad interval/limit → `400 {"error":"…"}` |
| GET | `/api/scenario` | `{"scenario":"spike"\|null}` — the scenario armed or in effect, `null` when the feed is running from the seed alone |
| POST | `/api/scenario` | body `{"scenario":"spike\|halt\|gap\|burst\|clear"}` → `{"scenario":"…"\|null}`; unknown name or bad body → `400 {"error":"…"}` |

Shapes (protocol v2, compact tuples): Level `["price","qty"]` (positions `[0]=price, [1]=qty`, decimal strings);
Candle `["t","o","h","l","c","v"]` (positions `[0]=t … [5]=v`, OHLCV decimal strings);
Trade and book/candle *frames* are full tuples — see WebSocket below. REST envelopes
(`snapshot`, `history`, `config`) stay named-key objects; only their repeated
market-data entries are tuples.

### Scenario injector

A debug/demo control, not market data: it scripts one known event onto the
seeded feed so the recording and the tests can show recovery paths on demand
(SPEC story 20, issue #6). The response is the injector's state after the
call, and `GET` reports what is armed or in effect — so a control can render
the truth rather than what it last asked for. With nothing armed the feed is
the seeded market, untouched.

| Name | Effect on the market |
|---|---|
| `spike` | Next tick: one ~10-sigma upward step (10 × the diffusion's per-tick sigma, ≈ +0.2%), then normal diffusion. Fires once. |
| `halt` | 5s with no trades: the tape is silent and candles stay flat, while the book keeps being served (its `seq` keeps advancing). Trades resume on their own. |
| `gap` | Next book frame skips 5 seq numbers, so its `prevSeq` is not the client's last applied `seq`: a legitimate break that must trigger the snapshot refetch + resume path above. One frame only. |
| `burst` | ~500 trades in the next second (50 per 100ms tick), numbered densely and in order; the seeded rate resumes after. |
| `clear` | Disarm. Also ends a running `halt` or `burst` immediately. |

`spike` and `gap` are one-shot and report themselves only until their tick has
happened; `halt` and `burst` report themselves for their window and then
disarm. Every name opens on the first tick after the request, never on the
request itself, and arming a name replaces whatever was armed before —
including ending a running `halt` or `burst`.

## WebSocket

Endpoint `GET /ws`. Query params select the stream:

```
/ws?topics=book,trades,chart&interval=1s
```

- `topics`: comma subset of `book`, `trades`, `chart` (default all).
- `interval`: the chart subscription interval, `1s` or `1m` (default `1s`).

### Server → client frames (JSON text messages)

Market data rides as **positional tuples** (protocol v2); control frames stay
named-key objects. The leading string tags the tuple, so devtools still
reads `\"book\"` / `\"trade\"` / `\"candle\"` at index 0:

```jsonc
{"type":"tier","tier":"full|degraded|minimal","rate":4}   // on connect + on change (object, control plane)
["trade",N,"…ts…","…price…","…qty…"]                     // [1]=seq, [2]=ts, [3]=price, [4]=qty
["book",N,M,[["p","q"]…],[ ["p","q"]…]]              // [1]=seq, [2]=prevSeq, [3]=bids, [4]=asks; full 10×10 image + ids (tracer; diffs are a later optimization)
["candle","1s","…t…","…o…","…h…","…l…","…c…","…v…",false]  // [1]=interval, [2]=t, [3..7]=o,h,l,c,v, [8]=complete; tier-throttled
{"type":"pong","tSend":12345,"tRecv":"…"}                  // answer to ping; tSend echoed verbatim (object, control plane)
```

Positions are the contract: `[\"trade\",seq,ts,price,qty]`, `[\"book\",seq,prevSeq,bids,asks]`
with each level `[price,qty]`, `[\"candle\",interval,t,o,h,l,c,v,complete]`. Money stays
**decimal strings** inside the tuples — the float-precision risk the old rejected
alternative carried (`[1710842000,64250.5,…]`) is not taken: only the key names are
dropped, never the string encoding. A tuple of the wrong length or tag, or with a
mistyped entry, is malformed exactly like a bad object frame was.

Gap rule (client): apply a `book` tuple only if `[2]` (prevSeq) equals the last
applied `seq`; otherwise refetch `/api/snapshot` and resume. Buffer frames
that arrive while the snapshot request is in flight; discard buffered frames
with `seq` at or below the snapshot `seq`.

### Client → server frames

```jsonc
{"type":"report","latencyMs":12.3,"jitterMs":4.1}  // every 2s; drives tiering
{"type":"force","tier":"degraded|null"}            // debug override; null clears
{"type":"ping","tSend":12345}                      // client ms timestamp; expect pong
```

RTT math (client): `RTT = tRecv − tSend`, `latency = RTT/2`,
`jitter = EMA(|RTT − prevRTT|)`. Same formulas the README documents.

## Versioning

Control-plane objects (`tier`, `pong`, client frames) and REST envelopes accept
additive fields without a version bump. Tuple positions are versioned instead: any
reorder, insert, or removal bumps `GET /api/config` `"protocol"` (now `2`) and is a
same-commit change on both sides.

## Compact tuples (adopted, protocol v2)

Positional array tuples were first proposed, then rejected (bandwidth ungraded at
localhost sizes; float-precision risk; unreadable in devtools; field order as lockstep
contract; additive-fields rule). They are adopted now, in a narrower shape than the
rejected one, for one new reason: the backend chooser (tunnel/hosted URLs) puts the
stream on metered, higher-latency links where the book image dominates — 20 levels ×
key names per frame at 4Hz — and the measured saving (~35-40% on book frames,
~30% on trades/candles) compounds exactly where the minimal tier is weakest.

The rejection's risks are answered, not ignored:

- **Float precision:** tuples keep decimal strings (`[\"65164.44\",\"0.032098\"]`), never
  floats. Only key names are dropped, never the string encoding.
- **Readability:** the tag travels at `[0]` (`\"trade\"`/`\"book\"`/`\"candle\"`), and
  `docs/PROTOCOL.md` position tables are the reader's key. Devtools shows shorter
  lines, not opaque ones.
- **Lockstep contract:** positions are versioned by `GET /api/config` `\"protocol\"`
  (`2`); the control plane (`tier`/`pong`/client frames) and REST envelopes stay
  named-key objects with the additive-fields rule intact.
- **Lever order:** tier-throttled delivery rates remain the performance lever that
  matters; payload shape is the multiplier on top, graded now that tunnel hosts
  make bandwidth billable.
