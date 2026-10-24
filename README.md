# Alcor bridge indexer

The indexer behind the [Alcor](https://alcor.exchange) bridge: it follows Telos
and every chain the bridge has a route to, freezes a proof for every crossing
the moment it starts, and serves the lot over HTTP. Run your own so that a front
end, a bot or the SDK reads bridge state from you instead of from
`https://telos.alcor.exchange/api/bridge`.

```
cp .env.example .env      # SHIP_URL and TELOS_RPC at the least
docker compose up -d
curl -s localhost:8899/api/bridge/health | jq .status
```

Read section 3 before the first start.

The indexer is an **observer**. It holds no keys and sends no transactions.
Every proof it serves is checked on chain by the contract it is meant for, so a
broken, stale or dishonest indexer cannot move anyone's funds. The worst it can
do is give out proofs that the contract rejects, or report a status that is
wrong. That is why running your own is optional: you get independence, your own
rate limits and a second opinion. It does not make the bridge any safer for your
users.

What this document covers:

1. [What it does](#1-what-it-does)
2. [What it needs](#2-what-it-needs)
3. [The first start: where the tree comes from](#3-the-first-start-where-the-tree-comes-from)
4. [Running it](#4-running-it)
5. [Configuration](#5-configuration)
6. [Is it healthy](#6-is-it-healthy)
7. [Exposing it](#7-exposing-it)
8. [Restarts, upgrades, backups](#8-restarts-upgrades-backups)
9. [Pointing a client at it](#9-pointing-a-client-at-it)

The internals (why each part exists and what bit us building it) are in
`services/indexer/README.md`. The HTTP API is in `docs/API.md`, and every
running instance also serves it at `<base>/docs`.

---

## 1. What it does

One process, one SQLite database, one data directory.

- **Telos.** It follows a Telos state-history stream and builds the Savanna
  finality tree: one leaf per block. When a withdrawal starts (`wdlog` on
  `bridge.alcor`), it freezes the proof for it about a second later. It reads
  credits, refunds and claims from the same stream.
- **Ethereum, BSC, Polygon.** It polls the vault contracts for `Deposit`,
  `Released`, `Voided` and `Expired` logs, and builds the deposit proofs that
  Telos verifies.
- **WAX, XPR Network** (optional). It follows their state-history and keeps each
  chain's block-root merkle, which proving one of their blocks on Telos needs.
- **Vaulta** (optional). It reads the vault's tables over HTTP.
- **HTTP API.** It serves all of the above: routes and live limits, transfer
  status, ready-to-send proofs. See `docs/API.md`.

The bridge does not depend on any of this to be correct. The indexer keeps
proofs *possible* and *quick*, because some of the inputs they need are only
kept by nodes for a few days (see `services/indexer/README.md`, "Why it
exists").

## 2. What it needs

### Software

- Docker with Compose, or Node.js 24+ (the code runs as TypeScript directly;
  `node:sqlite` is built in, so there are no native modules).
- This repository: the image is built from it.

### A Telos node with state-history

This is the expensive requirement, and there is no way around it. The tree needs
every block, in order, from a stream.

| what | why |
|---|---|
| `state_history_plugin` with `trace-history = true` | withdrawals, credits and claims are read from action traces |
| `finality-data-history = true` | the finality data every leaf is computed from |
| `state-history-endpoint` reachable from the indexer | `SHIP_URL`, e.g. `ws://127.0.0.1:8080` |
| retention at least as long as your longest planned downtime | after an outage the indexer resumes from where it stopped; a gap cannot be skipped (section 8). A week is comfortable |
| an HTTP API (`get_block`, `get_table_rows`, `get_info`) | `TELOS_RPC`. Headers are read over HTTP, not from the stream |

Chain-state history (`chain-state-history`) is **not** needed. The indexer asks
for traces and finality data only.

If your node's block log is short, list a full-history public endpoint after
your node in `TELOS_RPC`. A node with a short block log answers
`HTTP 400 Unknown Block` for an old block, and the indexer then moves on to the
next endpoint. `.env.example` does exactly this: your node first,
`https://telos.eosusa.io` behind it.

Run the indexer on the same host as the node, with both on loopback. The stream
is constant traffic, and a dropped tunnel stops the tree.

### EVM endpoints

The defaults in `src/chains/evm.ts` are free public endpoints. They are fine
for Ethereum and Polygon at low volume, but **not for BSC**: publicnode refuses
every receipt except the newest, and the Binance seeds refuse `eth_getLogs`. For
BSC, set a paid endpoint (`EXEC_URLS_56`, `ARCHIVE_URLS_56`), Alchemy for one.

| chain | exec (logs, receipts) | other |
|---|---|---|
| Ethereum (1) | `EXEC_URLS` | beacon API, `BEACON_URLS` (default: publicnode). Deposit proofs come from the sync committee |
| BSC (56) | `EXEC_URLS_56`, `ARCHIVE_URLS_56` (paid) | none |
| Polygon (137) | `EXEC_URLS_137`, `ARCHIVE_URLS_137` | Heimdall comet and REST, from the registry (Polygon's own first, publicnode second) |

Endpoint keys belong in `.env`, never in the registry. `.env` is this
process's alone: `docker-compose.yml` hands all of it to the container.

### WAX, XPR Network, Vaulta (optional)

Without them, everything Telos ↔ Ethereum/BSC/Polygon works, and transfers to
and from these chains show only their Telos half. To follow WAX as well, you
need:

| what | env |
|---|---|
| a WAX state-history endpoint, with traces | `WAX_SHIP_URL` |
| a WAX HTTP API | `WAX_RPC` (default `https://wax.eosusa.io`) |

XPR Network is the same kind of chain and is followed the same way, under the
prefix `XPR_` (`XPR_SHIP_URL`, `XPR_RPC`); the chains themselves
are listed in `src/chains/antelope.ts`. Each keeper has the same first-start
question as the Telos tree. See section 3.

Vaulta runs Savanna and needs no keeper: its relayers prove everything. Giving
its HTTP API is what turns it on, and its state-history socket is required with
it:

| what | env |
|---|---|
| a Vaulta HTTP API | `VAULTA_RPC` (no default; e.g. `https://eos.api.eosnation.io`) |
| a Vaulta state-history endpoint, with traces | `VAULTA_SHIP_URL` |

On every Antelope chain, Telos included, the indexer keeps its own history of
the few actions it reads — bridgeroute's orders, the vault's deposits and
settlements, the bridge's credits and burns — straight off that socket, from
irreversible blocks (`services/indexer/actions.ts`). No Hyperion is asked. A
socket that no longer holds the blocks the history needs next (the indexer was
down longer than the node keeps traces) is an alarm on `/health` until a person
fills the gap.

### Hardware

Measured on the production instance, a ~0.5 s Telos chain plus three EVM
chains, WAX and XPR:

| data | size | over time |
|---|---|---|
| frontier (`tree-state.json`) | under 1 KB | constant |
| checkpoints | ~1 KB each, one per 50,000 leaves | ~1.3 MB a year |
| leaf window | 32 bytes per Telos block | flat: the default 30 days is ~110 MB |
| withdrawal proofs | ~3 KB per unsettled withdrawal | small |
| deposit proofs | ~17 KB per uncredited deposit | dropped once credited |
| sync committee | ~49 KB per ~27 h period | ~18 MB a year |
| WAX, XPR block ids (`wax/ids`, `xpr/ids`) | 32 bytes per block, each chain | ~5.5 MB a day each, ~2 GB a year each; only with the chain on |

So about 250 MB in the first two weeks, then ~330 MB a month with WAX and XPR on
and almost nothing without them. The process itself takes ~300 MB of memory.
A few gigabytes of disk is plenty for the indexer. The Telos node next to it is
what needs real hardware; size it from the node's own documentation.

## 3. The first start: where the tree comes from

Read this before you start anything. It is the one step that cannot be
improvised.

The finality tree is a running counter over **every** Telos block since Savanna
activated. It cannot start at an arbitrary block. It must start from a
*frontier*: the tree's state at a known block, which is under a kilobyte. On the
first run with an empty data directory, the indexer uses the frontier built into
the image:

```
data/tree-seed.json   Telos block 488,587,246  (2026-09-13)
```

and streams forward from there. So the first start needs state-history that
reaches back to the seed. You have two ways to get there.

### Option A: replay from the built-in seed

This works if your node's state-history (traces and finality data) still holds
block 488,587,246. Leave the data directory empty and start the indexer. It
replays at roughly 700 blocks a second, about 1.7 hours for every 4 million
blocks behind the head, and then follows the head.

Most nodes do not keep that much. Check your node's state-history retention
before relying on this option.

### Option B: start from a frontier taken from a running instance

Copy the frontier from any instance that is already following the head. That
can be your own instance on another host, or an instance whose operator agrees
to share it. Your node then only needs state-history from that frontier's block
onward, which is minutes or hours, not weeks.

The frontier is in the source instance's data directory:

```
tree-state.json    the frontier: the tree, its block, its finalizer policies   required
checkpoints/       older frontiers, to replay from when a proof needs one       optional
leaves/            the leaf window, for cheap proofs of earlier withdrawals     optional
```

**Copy `tree-state.json` first, then `leaves/`.** The source writes leaves on
every block and the frontier every few seconds. A leaf window *ahead* of the
frontier is the normal recovery case: the indexer replays the leaves forward on
start. A window *behind* the frontier has a gap, and the indexer drops it whole
(an incident in `/health`, and the cheap track for older withdrawals is gone).

**You do not have to trust the frontier.** Whatever its origin, it is checked as
the indexer runs: a computed root is compared against the root the block
producers put in a later block header (`action_mroot`). Any divergence shows up
as `mismatches` and as an alarm in `/health` (section 6). For the first run, set
`VERIFY_EVERY=1000` so the first check happens within minutes rather than hours.
Even an unchecked bad frontier could not cost anyone funds: it would only produce
proofs that the contracts refuse.

### What a fresh instance does not know

- **Telos.** An instance can freeze a withdrawal proof only for a withdrawal it
  saw, or one whose block lies after a checkpoint it holds and inside its node's
  state-history. Older withdrawals are still provable by
  `scripts/build-withdrawal.ts` against an archive node, then
  `scripts/import-artifact.ts` (both are in the image; see
  `services/indexer/README.md`, "Importing an artifact built elsewhere").
- **EVM.** Log scanning starts at `EVM_FROM_BLOCK` (`EVM_FROM_BLOCK_<chainId>`
  for the other chains). Unset, it starts at the head, and earlier deposits and
  releases stay invisible. To see the whole history, set it to the block the
  vault was deployed in. For Ethereum mainnet that is `26084601`. For BSC and
  Polygon, look up the creation transaction of the vault address in
  `src/chains/evm.ts` on the chain's explorer.

### WAX and XPR: the same question

The WAX keeper starts from `data/wax-blockroot-seed.json` (WAX block
457,961,307) and needs WAX state-history from there on, XPR's from
`data/xpr-blockroot-seed.json`. A node keeps block ids for about a month, and a
full-history node keeps them all. Otherwise, copy `wax/` (`xpr/`) from a running
instance's data directory, the same way as above.

## 4. Running it

`docker-compose.yml` runs the indexer beside a Telos node on the same host, with
its settings in `.env`:

```
cp .env.example .env      # then edit it
```

`.env.example` lists every setting with a comment; section 5 has them all. The
state lives in `./state`, mounted at `/data`.

Then:

```
docker compose up -d
docker compose logs -f indexer          # "[savanna] resuming from …: block …"
curl -s localhost:8899/api/bridge/health | jq .status
```

The log rotation in `docker-compose.yml` is not optional. The process logs a line per checkpoint
and a progress line every thirty seconds, for as long as it runs, and Docker's
default keeps all of it on the same disk as the node.

To print the whole resolved configuration (accounts, endpoints, sources, data
paths) and exit:

```
docker compose run --rm indexer node services/indexer/index.ts --check
```

Without Docker, from the repository (Node.js 24+):

```
npm ci
set -a; . ./.env; set +a; export DATA_DIR=state
npm run check
npm start
npm test        # a few seconds, no network
```

## 5. Configuration

Facts about a network (contract accounts, vault addresses, genesis times, block
intervals) come from the registries in `src/chains/` and cannot be overridden by
environment. Only things about *this process* can: where it keeps files, where
it connects, what port it answers on.

### Required

| variable | example | |
|---|---|---|
| `SHIP_URL` | `ws://127.0.0.1:8080` | Telos state-history. The process refuses to start without it |

`SAVANNA_CHAIN` (default `telos-production`, the ledger `bridge.alcor` on Telos)
and `CHAIN` (default `mainnet`, the primary EVM chain; the others come from
`sources` in `src/chains/savanna.ts`) select registry entries. Leave them.

### Usually set

| variable | default | |
|---|---|---|
| `TELOS_RPC` | registry | comma-separated, tried in order. Your node first |
| `HOST` | `0.0.0.0` | `127.0.0.1` behind a reverse proxy |
| `PORT` | `8899` | must differ from everything else on a `network_mode: host` box |
| `API_BASE_PATH` | `/api` | the prefix every route hangs off. Empty means none |
| `INSTANCE` | `<savanna>-<evm>` | the name in logs and `/health` |
| `EVM_FROM_BLOCK` | head | where log scanning starts on `CHAIN` |
| `EVM_FROM_BLOCK_<chainId>` | head | the same on another chain. A block number means nothing on a chain it was not written for |
| `EXEC_URLS` / `EXEC_URLS_<chainId>` | registry | execution endpoints, tried in order. Put the one with the longest retention first |
| `ARCHIVE_URLS_<chainId>` | registry | for old receipts |
| `BEACON_URLS` | registry | Ethereum beacon API |
| `EVM_POLL_MS` / `EVM_POLL_MS_<chainId>` | `12000` | log poll interval. Every poll is a billed request on a paid endpoint |
| `TELOS_HISTORY` | registry | Hyperion on Telos, for finalizer-key proofs of possession: the one thing still read from Hyperion |

### WAX, XPR Network and Vaulta

One set per chain in `src/chains/antelope.ts`, under its prefix (`WAX_`, `XPR_`,
`VAULTA_`):

| variable | default | |
|---|---|---|
| `<PREFIX>_SHIP_URL` | unset | the chain's state-history, with traces: the indexer's own history of it, and for WAX and XPR their keeper. For WAX and XPR this turns the chain on; Vaulta requires it once on |
| `<PREFIX>_RPC` | `https://wax.eosusa.io` WAX, `https://proton.eosusa.io` XPR; Vaulta unset (chain off) | the chain's HTTP API; for Vaulta this turns the chain on |
| `<PREFIX>_BLOCKROOT_SEED` | `data/<chain>-blockroot-seed.json` | WAX, XPR: the keeper's verified starting state |

### Tuning (defaults are what production runs)

| variable | default | |
|---|---|---|
| `LEAF_WINDOW_FACTOR` | `2` | leaf window as a multiple of the longest route's `withdraw_ttl` |
| `LEAF_WINDOW_MIN_DAYS` | `30` | the floor under it |
| `CHECKPOINT_EVERY` | `50000` | leaves between checkpoints |
| `VERIFY_EVERY` | `20000` | leaves between checking a root against the chain |
| `RECONCILE_MS` | `60000` | the slow pass over both chains' tables |
| `MAX_ANCESTRY` | `4096` | the longest Ethereum header chain worth building for a deposit proof |
| `DATA_DIR` | `/data` in the image | |

### Leave unset

| variable | why |
|---|---|
| `PROOF_PAYER` | names the account that served proofs bill RAM to. It only matters to whoever pushes those proofs. With it unset, the contracts pay for themselves |
| `RELAYER_DIR` | the crossings files of the operator's own WAX, XPR and Vaulta relayers (`<chain>-in/`, `<chain>-out/`). With a chain on and this unset, its half of a transfer is filled from the indexer's own history of the chain, on the next reconcile pass |
| `FALLBACK_PROXY`, `PROXY_ALL` | an HTTP CONNECT proxy a request that stalls is retried through once; unset, no retry. `PROXY_ALL=1` sends everything through it from the start, for a host behind DPI |

## 6. Is it healthy

```
curl -s localhost:8899/api/bridge/health | jq
```

| `status` | meaning |
|---|---|
| `catching-up` | replaying toward the head. Normal after a start |
| `following` | at the head, no alarms |
| `degraded` | at or near the head, with an alarm that needs a person |

The Docker healthcheck treats all three as alive, on purpose. A container
restart cannot fix an alarm. It only adds a restart loop to it. The container
turns unhealthy only when `/health` stops answering or answers something else.

Alarms worth a page:

- `N root(s) the chain disagreed with`: the tree has diverged. Every proof
  from it will be refused. Stop the indexer, and start again from a known-good
  frontier (section 3).
- `tree is N blocks behind`: the stream is stalled or the node is behind.
- `N burned withdrawal(s) with no stored proof`: a withdrawal was missed.
  Reconciliation backfills it if state-history still covers its block.
  Otherwise use `scripts/build-withdrawal.ts`.
- `sync committee is N periods behind`: Ethereum deposits will start failing.
  This one is about the light client on Telos, not about your indexer. Walking
  it forward (`updcommit`) is permissionless, and the operator runs a keeper
  for it. Your indexer reports it because it reads the same chain.

`savanna.behindSeconds`, `sources[].behind` and `sources[].lastError` are the
numbers to graph.

## 7. Exposing it

Bind to loopback (`HOST=127.0.0.1`) and put a reverse proxy with TLS in front.
The service serves its own prefix (`API_BASE_PATH`), so the proxy passes paths
through unchanged:

```nginx
location ^~ /api/bridge/ {
    proxy_pass http://127.0.0.1:8899;
}

# Server-sent events: unbuffered, and held open (the API pings every 20 s).
location = /api/bridge/v1/stream {
    proxy_pass http://127.0.0.1:8899;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_pass_header X-Accel-Buffering;
    proxy_read_timeout 1h;
}
```

The API answers `X-Accel-Buffering: no` on a stream, which one nginx obeys and
drops; `proxy_pass_header` hands it on, so a second proxy in front (a load
balancer) does not buffer the stream either.

Do not open the port on a public interface beside the proxy. That would be a way
around both the TLS and any rate limit you put there.

The API is read-only and has no authentication. The heaviest calls are
`/v1/proofs/<key>` for a fast Ethereum deposit (built on request) and the
history endpoints. Rate-limit at the proxy if the instance is public.

## 8. Restarts, upgrades, backups

**Restarts are safe.** The frontier is written every few seconds and the leaves
on every block, so after a crash the leaf file is ahead of the frontier. The
indexer replays the stored leaves until the two agree, then resumes the stream
from there.

**Downtime is safe while state-history covers it.** On start, the indexer
streams from the block after its frontier. If the node no longer holds that
block, the stream cannot resume, and the instance needs a fresh frontier
(section 3, option B). A gap is never patched over. A missing leaf would shift
every later leaf, and every root after it would be wrong.

**Upgrades.** Pull, rebuild, restart:

```
git pull
docker compose up -d --build
```

The database migrates itself on open. Read the commit log before an upgrade
that changes `src/chains/`. A registry change (a new route, a new vault) is
what makes an old image give stale answers.

**Backups.** Everything is in the data directory. Two parts cannot be rebuilt
from the chain quickly:

- `tree-state.json` and `checkpoints/`: the frontier and the replay points.
  Back them up often; they are tiny.
- `indexer.sqlite`: frozen proofs, including withdrawal proofs that become
  impossible to build from live data after about eight days. Back it up with
  `sqlite3 indexer.sqlite ".backup …"`, not by copying the file while it runs
  (the database is in WAL mode).

The leaf window can be lost. It only costs the cheap settlement track for
withdrawals older than the restart.

## 9. Pointing a client at it

Every client takes the indexer's base URL, the origin plus `API_BASE_PATH`:

```
https://bridge.example.com/api/bridge
```

The base is the only thing to change. Contract addresses do not come from the
indexer, and a client should never take them from it. They are constants of
the bridge (`docs/BOT-INTEGRATION.md`, section 2). The indexer supplies state:
routes, limits, statuses, proofs. Anything it serves that goes on chain is
checked there.

To check that two instances agree, compare the same transfer on both:

```
curl -s https://telos.alcor.exchange/api/bridge/v1/transfers/w:<id> | jq '{status, hasProof}'
curl -s localhost:8899/api/bridge/v1/transfers/w:<id>               | jq '{status, hasProof}'
```

## License

MIT, see `LICENSE`.
