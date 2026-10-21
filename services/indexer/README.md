# The indexer

Follows both chains, freezes a proof for every crossing the moment it starts,
and serves the lot over HTTP so a front end never has to know how any of it
works.

It holds no keys and pushes nothing. Every path it prepares is permissionless
and verified on chain, so if this process disappears nothing is stolen and
nothing is lost — proofs just get slower to assemble. That property is the point,
and it is why this stays an observer.

**The pushing lives next door**, in `services/relayer/`: `close.ts` signs whatever
this process marks ready, and `bsc.ts` keeps a Parlia light client's validator sets
current. They are separate processes because they hold a key and this one must not
— and the key they hold is not the bridge's. Every action they send names its payer
as an argument and `require_auth`s it, so a dedicated account suffices, and its
worst case if the host is taken is paying RAM for proofs that are verified anyway.

## One settlement chain, several source chains

An instance is one Savanna chain and a LIST of source chains, not a pair. The Telos
half is what costs something to run — a state-history stream and a tree of nine and
a half million leaves — and it is identical whichever chain a crossing came from:
one bridge contract holds withdrawals bound for every route. So a second source
chain is a second log poller inside this process, and the deployment stays one
container with one database.

The list comes from the settlement registry's `sources` (`src/chains/savanna.ts`),
which names the light client and gateway that verify each chain. `cfg.sources` is
computed once and walked by the followers, by the reconciler and by `/v1/chains`,
so none of them can disagree about which chains exist.

What that cost, and every one of these was a silently wrong answer rather than a
failure: the execution endpoints were read from the active chain; a deposit key was
the vault's nonce, which numbers a deposit on every chain at once; one saved scan
position served all of them; `EVM_FROM_BLOCK` is a block number and means nothing
on another chain; and the bridge's `seen` table is scoped by domain, so reading one
scope marked only one chain's deposits as credited.

## Why it exists

Nothing in the bridge needs a daemon to be *correct*. What a daemon buys is that
proofs remain **possible**, and that has a deadline attached.

A withdrawal proof has two halves, kept for very different spans:

```
block log (headers, QC)   effectively forever, from any full node
trace_history             ~36 days
finality_data_history     ~8 days   <- the binding one
```

`submitRoot` needs the full `finality_data` of the block carrying the root. So a
burn that is not turned into an artifact inside eight days can no longer be
proved from live data, however perfect the tree is. Freezing costs two kilobytes
and happens about a second after the burn, because the certificate that signs
the root arrives two blocks later.

**The deposit side has a tighter deadline, and it is not eight days.** A
finalized proof carries a `parent_root` chain from the log's block up to a
finalized header, and that chain grows by one 112-byte header every twelve
seconds of age. Antelope allows 600 KB per transaction and the committee blob
already takes ~49 KB, so past roughly five thousand headers the proof does not
fit in one transaction at all:

```
~13 min   the block finalizes; ancestry is ~40 headers, the bundle ~2 KB
~16 h     ancestry ~4,800 headers; the transaction stops fitting
```

Measured, not estimated: a bundle built 45 slots behind finality took 6.8 s and
2.1 KB beside a shared 48 KB committee. One attempted 15 hours late was still
walking 4,500 headers after ten minutes. So deposits are frozen as soon as their
block finalizes, and the indexer refuses to start a chain longer than
`MAX_ANCESTRY` rather than build something that cannot be pushed.

## The two settlement tracks

`AlcorWithdrawals._verify` checks `lightClient.trustedRoots(p.finalityMroot)` and
nothing else about which root it is, and `trustedRoots` only ever accumulates.
So a withdrawal may fold into **any** root taken at or after its burn block:

| | gas | when |
|---|---|---|
| light — fold into a root someone already made trusted | ~135k | the normal case |
| hard — submit this withdrawal's own root, then release | measured 2,395,047 + 176,202 | no later root is trusted, or the window no longer reaches |

The frozen artifact is the hard track, self-contained and permanent. The light
track is rebuilt on demand from the leaf window, checked, and only offered if it
folds. `GET /v1/proofs/<key>` returns whichever apply and says which to use — the
front end does not choose.

## What it keeps

```
frontier                  < 1 KB      constant forever
checkpoints               ~1 KB each  one per 50,000 leaves, ~1.3 MB a year
leaf window, 32 B/block   ~77 MB      per 14 days of a half-second chain
withdrawal artifact       ~3 KB       per unsettled burn, never dropped
deposit proof             ~17 KB      per uncredited deposit, dropped once credited
sync committee            ~49 KB      once per ~27 h period, shared by every deposit in it
```

Flat, not linear. The leaf window is sized from the routes' own `withdraw_ttl`
(times `LEAF_WINDOW_FACTOR`, with a floor), because the deadline is what decides
how long the cheap track has to stay open — not the node's retention.

The 49 KB committee blob is the largest thing in a `proveroot` transaction and
is identical for every deposit in its period, so it is stored once and stitched
back in when a proof is served.

## Endpoints

Everything hangs off `API_BASE_PATH`, `/api/bridge` in this deployment, so the
indexer shares an origin with the front end that consumes it. The service serves
that prefix itself rather than having a proxy strip it — the path in a log is
then the path in a browser, and there is no rewrite rule to remember at three in
the morning. The prefix root answers `/health`, and the bare `/` answers with
the route list, because something always curls it.

`/api` alone was not available. The wildcard `.alcor.exchange` vhost already
sends it to the exchange backend, and `/api/markets` is a live route there;
nginx picks the longest `^~` prefix, so `/api/bridge/` sits beside it without
ambiguity.

| | |
|---|---|
| `GET /api/bridge/docs` | the front-end document, served by the API it describes |
| `GET /api/bridge/health` | both streams, lag, alarms (among them EVM vault floors out of order, `minimums.ts`), storage, recent incidents |
| `GET /api/bridge/v1/stats` | counts by direction and status |
| `GET /api/bridge/v1/volume` | volume and distinct accounts/addresses per asset and direction: 24h, 7d, 30d, all time, average per day, busiest day, daily series; `?days=` |
| `GET /api/bridge/v1/transfers` | `?account= &address= &direction= &status= &flag= &limit= &before=` |
| `GET /api/bridge/v1/transfers/<key>` | one crossing, decorated |
| `GET /api/bridge/v1/accounts/<name>` | summary plus the newest fifty |
| `GET /api/bridge/v1/accounts/<name>/transfers` | that account's history |
| `GET /api/bridge/v1/pending` | everything waiting for somebody to sign, with its proof |
| `GET /api/bridge/v1/proofs/<key>` | arguments ready to push, both tracks |
| `GET /api/bridge/v1/finalizer-keys` | finalizer keys a withdrawal chain's light client lacks, with the `registerKey` call; `?chain=` |
| `GET /api/bridge/v1/upkeep` | what the bridge needs done now: policy handovers to send (`submitRoot` + `installPolicy`, ready to push), missing keys, committee lag; `?chain=` |

For a front end there is a separate document, live at
<https://telos.alcor.exchange/api/bridge/docs> and in the repository at
[`docs/API.md`](../../docs/API.md)
— response shapes, what each status and flag means, and how to turn a proof into
a transaction on either chain.

Keys name what is being proved, not just the transfer:

```
w:<id>      the withdrawal artifact — submitRoot + release (or expire), on the EVM
v:<id>      the vault's `Voided` log   — proveroot + voided, on Antelope: the refund
d:<chainId>:<nonce>
            a deposit bundle           — proveroot + credit, on Antelope
```

A withdrawal that is rolled back needs both `w:` and `v:`, at different times
and on different chains, which is why they are separate proofs.

### `GET /v1/pending`

The queue of outstanding transactions — which is what an observer that does not
push is *for*. It knows exactly what is owed, on which chain, and whether the
proof already exists, so a user can finish their own crossing and an operator can
watch the queue, without either of them trusting this service with a key.

```
?account=alcor     only that Antelope account's crossings
?address=0x…       only that EVM address's
?chain=mainnet     only what is pushed there
?ready=true        only what can be signed right now
```

Each item carries `action` in words, `pushOn`, `ready`, a `reason`, a link to
the proof, and a `deadline` when there is a clock on it. Items that are *not*
ready are listed too, with why: a deposit waiting thirteen minutes for finality
is normal, and one that has been waiting nine hours is the thing you need to
see. One item is for an operator rather than a user — a sync-committee rotation
that has fallen behind, flagged `admin: true`.

Every transfer carries `flags`, computed at read time because they are functions
of the clock: `unfrozen` (burned, no proof stored — the one with eight days on
it), `past-deadline` (release is no longer possible; `expire` is), `stuck` (a
deposit proved and uncredited for half an hour), `rolled-back`.

## Running it

How to run one — what it needs, the first start, configuration, health,
upgrades — is the repository's `README.md`. In short:

```
cp .env.example .env      # SHIP_URL and TELOS_RPC at the least
docker compose up -d
curl -s localhost:8899/api/bridge/health | jq
```

`network_mode: host`, because the node's state-history socket and HTTP API are on
loopback beside it.

A node whose block log is short answers `HTTP 400 Unknown Block` for anything
older. That is retention wearing the clothes of a bad request, which is why a
refusal falls through to the next endpoint in `src/net/antelope.ts` instead of
being raised — list a full-history endpoint after your own node in `TELOS_RPC`.
A burn from before the node's state-history needs `scripts/build-withdrawal.ts`
run against an archive, and then `scripts/import-artifact.ts` to put the result
where the indexer serves it from.

### Importing an artifact built elsewhere

```
docker compose exec indexer \
  node scripts/import-artifact.ts /data/withdrawal-<block>.json /data/indexer.sqlite
```

Checked on the way in, not trusted: the tree branch must fold the leaf to the
root the artifact names, and the payload must match the bridge contract's own
`wdraws` row. The second check is there because the first does not cover amount
or recipient — those are bound through the action digest, and re-implementing
that digest here would be a second copy of what the Solidity verifier already
does. Asking the chain what it recorded is cheaper and is not a copy.

Without Docker:

```
npm run check     # resolve and print the whole configuration, then exit
npm start
```

### Configuration

Chain facts come from `src/chains/*` and may not be overridden here; only this
process's own knobs live in the environment.

| | default | |
|---|---|---|
| `SAVANNA_CHAIN` | `telos-production` | registry id |
| `CHAIN` | `mainnet` | registry id: the instance's own EVM chain |
| `SHIP_URL` | required | state-history socket of your Telos node |
| `DATA_DIR` | `data` | `/data` in the image |
| `PORT` | `8899` | |
| `API_BASE_PATH` | `/api` | prefix every route hangs off; `/api/bridge` in the deployment, empty means none |
| `LEAF_WINDOW_FACTOR` | `2` | multiple of the longest route `withdraw_ttl` |
| `LEAF_WINDOW_MIN_DAYS` | `30` | floor under that |
| `CHECKPOINT_EVERY` | `50000` | leaves between checkpoints |
| `FORGET_EVERY` | `10000` | leaves between dropping interior nodes |
| `EVM_FROM_BLOCK` | head | where log scanning starts, for THIS instance's own chain |
| `EVM_FROM_BLOCK_<chainId>` | head | the same for another source chain. A block number means nothing on a chain it was not written for: 11,670,000 is early Sepolia and 120 million blocks of BSC history |
| `PROOF_PAYER` | the contracts | which account served proofs name as their payer, so a key that can only pay for verified proofs closes the queue |
| `MAX_ANCESTRY` | `4096` | longest `parent_root` chain worth building (see above) |
| `RECONCILE_MS` | `60000` | the slow pass over both chains' tables |
| `CROSSINGS_MS` | `200` | how often the WAX, XPR and Vaulta relayers' crossings files are read; a local stat |
| `WAX_HISTORY`, `XPR_HISTORY`, `VAULTA_HISTORY` | `https://wax.eosusa.io`, `https://proton.eosusa.io`, `https://eos.eosusa.io,https://eos.hyperion.eosrio.io` | each chain's Hyperion, to complete a row whose far transaction the relayers did not record |
| `VAULTA_RPC` | unset | Vaulta's HTTP API; setting it turns Vaulta on (no keeper, no state-history: its relayers prove everything) |
| `SUI_GRAPHQL` | unset | Sui's GraphQL endpoints, comma-separated; setting it turns Sui on in `/v1/chains`, its withdrawals' Move calls in `/v1/proofs` and `suiCalls` in `/v1/handovers` |
| `NEAR_RPC`, `NEAR_TESTNET_RPC` | unset | NEAR's JSON-RPC endpoints, comma-separated, per network; setting one turns that network on in `/v1/chains`, its withdrawals' function calls in `/v1/proofs`, `nearCalls` in `/v1/handovers`, and the follower of the vault's logs |
| `NEAR_TX_API`, `NEAR_TESTNET_TX_API` | `https://tx.main.fastnear.com`, `https://tx.test.fastnear.com` | FastNEAR's account history, which only finds the vault's transactions; what they say is read from the RPC |

## Tests

```
npm test          # node --test over tests/, a few seconds, no network
```

What is covered is the part that fails silently rather than loudly: name and
symbol packing against values read off live tables, the store's rule that a
rescan never moves a row backwards, the migrations a database from the field
goes through on open, the leaf window's refusal to patch a gap or prune to a
non-number, the crossings file read from its saved offset, and the decoding of
the bridge's own actions. The streams, the EVM pollers and the provers talk to
chains and are checked the way they were built: against the chains.

## The three loops

**savanna** streams state-history, appends a leaf per block, and freezes an
artifact whenever it sees a `wdlog`. Reconnects and resumes by itself. Traces
stay on even while catching up — the stream runs at ~700 blocks a second with
them, which is cheap enough that a burn is never missed for being in the past.

### Two deposit proofs, and only one of them is stored

The committee signs a head about twelve seconds after the block; finality is two
epochs behind, roughly thirteen minutes. Both are real proofs and they claim
different things, so the service keeps both and stores only one:

| | ready after | stored? | bounded by |
|---|---|---|---|
| fast (optimistic) | route's `min_confirmations` — ~2.4 min at twelve | no, built on request | `optimistic_max`, and the gateway's TTL |
| finalized | ~13 min | yes, frozen | nothing; never goes stale |

An optimistic bundle bakes in its depth, so one frozen at twelve confirmations
is worthless the moment a route asks for twenty, and it cannot be deepened after
the fact. So: **store what cannot go stale, serve what must be current.**
`GET /api/bridge/v1/proofs/d:<chainId>:<nonce>` returns whichever apply and says which to
use, and it answers during the ten minutes before anything has been frozen —
404 there would hide the entire point of the fast path.

The fast path also has no age limit: its ancestry is `min_confirmations`
headers whatever the block's age, while a finalized proof's grows by a header
every twelve seconds. The ~16-hour ceiling is therefore the *finalized* path's
alone, and it only binds where a route has `optimistic_max = 0`.

**evm** polls logs for `Deposit`, `Released`, `Voided`/`Expired` and
`RootAccepted`. Two of them are not just news but things Antelope has to be
shown — a `Deposit`, which the gateway turns into a credit, and a `Voided`,
which it turns into a refund — and both are frozen the same way, since
`ethgateway11::voided` takes exactly the argument shape `credit` does.

Only a `Voided` **from the vault** counts: the gateway checks that the log came
from a whitelisted source, and that is the vault, not the withdrawals contract.
An `Expired` from the withdrawals contract updates the status and nothing else.

Bundles are **finalized**, not optimistic: an optimistic one bakes in a
confirmation depth, so one frozen at twelve is worthless on a route that later
asks for twenty, while a finalized one can never become insufficient. The ~13
minutes costs nobody anything, since the fast path is served live rather than
from storage.

**reconcile** reads `wdraws`, `seen` and `routes` and is the authority. It finds
anything the streams missed, backfills its artifact, resolves the block number
behind a root somebody else submitted, trims the leaf window, and drops deposit
proofs whose nonce has been spent.

## Restart, and what cannot be patched

The frontier is written every few seconds, the leaves on every block, so after a
crash the leaf file is *ahead* of the frontier. That is the recovery log: the
tree is walked forward over the stored leaves until the two agree, and the stream
resumes from there.

A gap in the leaves cannot be patched. The tree is a carry-propagating counter,
so a missing leaf does not leave a hole — it shifts every later leaf into the
wrong position and every root computed from them is merely *different*. So the
store refuses a non-sequential append, and a window that somehow ends up with a
gap is dropped whole rather than carried.

## Keeping the cheap track available

A withdrawal settles for ~135k gas when a trusted root already covers its burn
block, and for ~2.6M when it has to submit one of its own. Roots accumulate for
free wherever there is traffic — every hard-track settlement leaves its root
behind — so the gap is the quiet case: the first withdrawal after a lull pays
816k to discover nobody has submitted a root in a week.

`scripts/submit-root.ts` submits one for its own sake, on a cron if you like:

```
node scripts/submit-root.ts          # dry run, prints the cast command
node scripts/submit-root.ts --send
```

It needs no tree — a header's `action_mroot` *is* the root as of the block that
header's certificate claims, so the value is read rather than computed. It walks
back until it finds a block whose certificate is strong, because a weak one
signs a different digest and does not finalize, and it verifies the certificate
locally before spending anything.

The arithmetic, per interval with N withdrawals in it:

```
without   N × 951k
with      816k + N × 135k     cheaper from N = 2
```

So the interval is a product decision rather than an accounting one: it is the
longest a user may wait before a cheap withdrawal is available, and shortening
it costs 816k gas a time.

## Things that bite

- **A branch needs a tree that appended the leaf itself.** A tree rebuilt from a
  frontier holds the peaks and no interior nodes, so a replay must start strictly
  *before* the block being proved. Starting on it yields "leaf is not under root",
  which names the symptom and not the cause.
- **Two withdrawals in one block.** `buildReleaseProof` takes the first `wdlog`
  unless told otherwise, and the fold would succeed — it would just be a valid
  proof of the wrong withdrawal. The indexer always passes the ordinal.
- **A sparse chunk reads back as zeros.** An instance that starts mid-chunk
  writes at an offset, and everything before it is a hole. Reporting the chunk's
  start as the window's start hands those zeros out as leaves — a tree that
  builds cleanly, folds perfectly, and agrees with nobody. The window's start is
  therefore the first leaf actually written, found by binary search for the end
  of the hole, since a sha256 output is never all zero.
- **A replayed tree checks itself against a header.** The streaming tree compares
  its roots with what producers signed as it goes; a replay has no such running
  check, so the backfill compares its root against the one block R carries before
  building anything on it.
- **`FinalizerPolicy` cannot be `JSON.stringify`d.** It holds `bigint` weights,
  which throw, and 96-byte `Uint8Array` keys, which become `{"0":1,…}` — an
  object that parses back cleanly and hashes to something merely wrong. The first
  failure is loud and the second is not, which is why `encodePolicy` exists.
- **`eth_getLogs` answers `[]` for a range it has pruned.** Not an error, not a
  `null` — an empty array, indistinguishable from "nothing happened there".
  Measured on Sepolia: for the block that released withdrawal 1, one public
  endpoint returned no logs while another returned the event, and the receipt
  carried it on both. A search through history therefore passes `confirmEmpty`
  and keeps asking; without it the history has holes that read as history.
- **…but the head has nothing pruned, and confirming it costs a rate limit.**
  Doing the above on every poll doubles the traffic of a scanner that never
  stops, to confirm a fact nobody doubted — which is how the rotation's second
  endpoint started answering 429. At the head one clean answer is the answer.
  An endpoint that refuses is parked for a minute rather than asked again
  twelve seconds later, and an endpoint that errors while another answered is
  not a failure: heads drift by a block between nodes, and a scan that stops on
  the laggard's `block range extends beyond current head` leaves settled
  crossings looking open.
- **A saved scan position must not outrank a configured one.** It used to, which
  made `EVM_FROM_BLOCK` do nothing on every run but the first — and the first
  run, before it was set, began at the head. A withdrawal released days earlier
  stayed invisible and the queue offered it as work.
- **The vault is the authority on whether a withdrawal is settled.** `wdraws` on
  the settlement chain cannot know: the release happens on the far side and
  nothing carries the news back until `settle` exists. Reconciliation asks the
  vault directly, because a queue built from one chain's view offers a
  transaction that reverts with `AlreadySettled` after the user paid the gas.
- **`seen` is scoped by domain, not by the contract.** `seen_table seen(get_self(), domain)`,
  and a table read with the wrong scope is not an error — it is an empty answer.
  Read as `ethbridge111` it returned nothing forever, so no deposit was ever
  marked credited: the queue offered work already done, and a deposit proved the
  day before still looked like it was waiting.
- **Event times come from the block, not the clock.** `eth_getLogs` carries no
  timestamp, and using `Date.now()` makes everything a backfill scan finds look
  like it happened just now — wrong in the history a user reads, and wrong in the
  deadline the push queue computes from it.
- **The sync committee cannot skip.** A committee is only provable by the one
  before it, so two periods behind is an incident, not a metric: once beacon
  nodes prune the intervening `light_client/updates`, the only way back is a
  re-bootstrap on authority. `/health` raises it as an alarm.
- **Wire's HTTP port is 6666**, which Node's `fetch` refuses outright as a WHATWG
  "bad port" — the call fails before a packet is sent, and a node does not get to
  move because a browser specification dislikes its port. `src/net/fetchJson.ts`
  notices and reissues through `node:http` with an explicit `Content-Length`,
  since nodeop also drops a chunked body mid-request and then answers nothing.
  That, and the proxy fallback, are why every call goes through one client.
