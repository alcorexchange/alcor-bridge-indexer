# The indexer API, for a front end

```
https://telos.alcor.exchange/api/bridge
```

No authentication, `access-control-allow-origin: *`, JSON throughout. The
indexer only reads (`GET`); beside it under the same base, the courier takes
`POST /v1/deposit-addresses`. Every response is `cache-control: no-store` but
the public aggregates, shared for a few seconds (see *Polling*).

This document is served by the API it describes, at
`https://telos.alcor.exchange/api/bridge/docs` — so it cannot describe a version
other than the one answering you.

**Writing a bot rather than a front end?** The same bridge from the signing
side — every action to push on WAX, Telos, Ethereum and BSC, memo formats,
units, releases and failure modes, in one file meant to be handed to a
developer or an AI assistant:
[`/docs/bot`](https://telos.alcor.exchange/api/bridge/docs/bot).

**The contract** is [`/openapi.yaml`](https://telos.alcor.exchange/api/bridge/openapi.yaml)
(OpenAPI 3.1): every public path, parameter and field there keeps its name and
meaning; new fields and new values of an open list may appear, so read what you
know and pass over the rest. `/v1/stats`, `/v1/volume`, `/v1/upkeep`,
`/v1/finalizer-keys`, `/v1/savanna/branch` and the keepers' `/v1/<chain>` are
for whoever runs the bridge and may change.

**Two words for where a transfer stands.** `state` — `in_progress`,
`action_needed`, `delivered`, `returned` — is the stable one, for a program to
branch on; it is on `/v1/activity` and on every transfer row. `status` is the
detailed lifecycle below, for people and support, and may gain values.

**To follow transfers**, open [`/v1/stream`](#get-v1stream): a snapshot, then each
change as an event, and after a drop exactly what was missed.

The rule this is built to: **a front end never constructs a proof and never
decides which one is cheaper.** It asks what is outstanding, asks for the proof,
and sends the transaction. Everything about retention windows, merkle branches
and settlement tracks stays on the server.

---

## The model

A **crossing** is one transfer in one direction. Its `key` names what is being
proved, not just the transfer:

| key | what it is | where its transaction goes |
|---|---|---|
| `d:<chainId>:<nonce>` | a deposit, a source chain → Telos | Telos: `proveroot` + `credit` |
| `w:<id>` | a withdrawal, Telos → a source chain | the source chain: `release`, or `expire` past the deadline |
| `v:<id>` | the rollback of a withdrawal | Telos: `proveroot` + `voided`, which refunds |

A withdrawal that is rolled back has both `w:` and `v:` — at different times, on
different chains. That is why they are separate keys.

**A deposit key carries its chain, a withdrawal key does not**, and the asymmetry
is in where the number comes from. A deposit is numbered by the vault's own
counter, one counter per chain, so `d:1` named a deposit on every route at once. A
withdrawal is numbered by the bridge, which is shared, so its id is already unique
everywhere. Changed on 2026-09-21 when the second route went live; a database
written before that has its deposit keys rewritten on startup.

The chain a crossing belongs to is also a field — `domain` — on every transfer,
so nothing has to parse a key to find out. It is a **string**: an EVM chain id
(`"1"`, `"56"`), or for an Antelope chain the first eight bytes of its chain id
(WAX is `"1181148696416462999"`, past what a JSON number carries exactly).
On a WAX crossing `evm_address` holds the WAX account name, and `token` the
`(contract, symbol)` pair packed as the ledger's route has it.

### `status`

```
deposit      seen ──▶ provable ──▶ credited
                               └─▶ parked ──▶ forwarded
                                          └─▶ bounced
withdrawal   burned ──▶ provable ──▶ released
                                └─▶ expired ──▶ refunded
```

`provable` is the indexer's own word: a complete proof is stored and the
crossing can be finished by anyone, at any time. It is the state that makes the
deadline stop mattering.

A deposit with a `memo`, or to an account that does not exist yet, is `parked`
instead of `credited`: booked on Telos, not handed on. The operator's relayer
pushes `forward`, which transfers it to the beneficiary with that memo —
`forwarded`. If the beneficiary refuses it for an hour, anyone may `bounce` it:
it becomes a withdrawal `w:<id>` owned by the bridge, back to the sending
address with no fee, and the deposit reads `bounced`. That withdrawal is
settled like any other; the depositor has gas on that chain, since they
deposited from it.

### `flags`

Computed per request, because they are functions of the clock. Render these:

| flag | means |
|---|---|
| `unfrozen` | burned, no proof stored. The one with a real clock on it |
| `past-deadline` | `release` is refused from here on; `expire` is what unlocks the refund |
| `stuck` | proved for over half an hour and still waiting on the bridge's own pusher: a deposit uncredited, or a withdrawal with a delivery `fee` the courier has not released. Offer the push to anyone from here |
| `rolled-back` | voided on the far side; the refund is what is outstanding |
| `held` | a parked deposit still not handed on after ten minutes. The funds are on Telos and someone has to look |
| `over-limit` | a deposit larger than its route's cap leaves room for. Telos will not credit it as things stand |
| `daily-limit` | a withdrawal larger than what the vault still lets out today. It waits for the limit to refill |

A held, over-limit or daily-limit crossing also has its `progress` say so:
`stage` is the reason in words, `waitingOn` is `bridge`, and `etaSeconds` is
when the daily limit fits it, or null when nothing can tell. Show the stage
as written. The words are deliberately the same whatever the cause.

### `track`

Which proof a request will come back with, without having to ask for it. It
means different things in the two directions.

**A withdrawal**, on the EVM side:

| | gas | when |
|---|---|---|
| `light` | measured 144k-176k | a root covering this burn is already trusted; one call |
| `hard` | measured 2,395,047 + 176,202 | no such root, or the leaf window no longer reaches. Two calls. The first figure scales with the quorum and is mostly storage, not cryptography |

**A deposit**, on the Antelope side:

| | ready after | when |
|---|---|---|
| `fast` | the route's `min_confirmations` — about 2.4 minutes at twelve on Ethereum; the whole wait is `/v1/chains` → `timing.depositFast` | the route accepts unfinalized proofs and the depth is there |
| `finalized` | the source chain's own figure, from `/v1/chains` → `timing.deposit` | always, once the block finalizes |

`null` when neither is available yet. The finalized wait is **per chain** and the
spread is more than an order of magnitude — about 32 seconds on BSC, about 17
minutes on Ethereum — so it is served rather than written down here.

---

## For a front end: a withdrawal to Ethereum, start to finish

The user pays for the crossing, both ends. Nothing runs on our side that
spends gas on Ethereum, and nothing has to: every call below is permissionless
and the contracts check what they are given.

1. **Burn on Telos.** A transfer of the canonical token to the bridge with memo
   `<chainId>:<address>[:<fee>]`, or the token's `withdraw` when the far side
   needs a memo — see [Starting a withdrawal](#starting-a-withdrawal-on-telos).
   The response carries the withdrawal id; the key is `w:<id>`.
2. **Wait for the proof.** Poll `GET /v1/transfers/w:<id>` until `hasProof` is
   true, or `GET /v1/pending` for everything ready at once. The finality
   certificate takes Telos about a minute and a half after the burn.
3. **Fetch and send.** `GET /v1/proofs/w:<id>` — one object, Solidity struct
   order, with both contract addresses inside. On `track: "hard"` send one
   transaction, `submitAndRelease`, to `hard.releaseTo` from the user's
   wallet (~2.6M gas); on `track: "light"` the root is already trusted and it is
   `release` alone (~180k). Code in [A withdrawal, on Ethereum](#a-withdrawal-on-ethereum).
   Past `deadline` the same body goes to `expire` instead, and the tokens come
   back on Telos.

That is the whole path. It does **not** depend on the light client holding
Telos's current finalizer generation: the proof carries the certificate's own
signers, and the contract only counts how many of the seats it holds are among
them. Two generations of lag leave at least 17 of 21; the threshold is 15.

**Upkeep, optional.** `GET /v1/upkeep` lists what would keep the light client
current, ready to send, and a UI may offer it to whoever is connected — as a
"maintain the bridge" button, never as a gate in front of a withdrawal:

- `advancePolicy` moves the held generation forward, one step at a time
  (`submitRoot` then `installPolicy`, ~2.2M + 0.4M gas per step). Listed only
  once finalizers have really left — out of Telos's policy a whole day, not
  rotated out for twelve hours — so that two or fewer seats of spare weight are
  left (`policy.quorum.spare`); `urgent` at none.
- `registerKey` teaches the light client the key of a finalizer that signs for
  Telos now and that it has never seen. Listed only then, and always `urgent`:
  a certificate that key signed cannot be verified until it is registered.
  Registered producers not finalizing are in `GET /v1/finalizer-keys`, not here.

### WAX, both ways

WAX is on the same ledger as an Antelope chain, and the same endpoints carry it.
`GET /v1/chains` has a source with `"id": "wax"` and `"kind": "antelope"`; what
differs from an EVM source is what a form needs to know:

- **Addresses are account names**: 1–12 characters of `a-z`, `1-5` and `.`
  (`accountFormat` on the source). Validate against that, not as hex.
- **Routes carry `antelopeToken`** — `{ contract, symbol, precision }` — instead
  of an ERC-20 address. That is the token to read a balance of on WAX and to
  send to the vault: `eosio.token WAX` on the backing route, `wrap.alcor USDC`,
  `USDT`, `ETH` on the spokes (the mirrors, issued by the vault).
- **Telos → WAX** is a transfer to the bridge with `withdrawMemo`,
  `<domain>:<wax account>[:<fee>]`. No transaction on WAX: the relayer proves
  it and the vault pays (a mirror is minted). About two minutes (`timing.withdrawal`).
- **WAX → Telos** is a transfer to `contracts.vault` (`bridge.alcor` on WAX) of
  the route's token with `depositMemo`, `<telos account>[:<note>]`, signed on
  WAX. About fifty seconds later it is on the account's balance on Telos
  (`timing.deposit`), or delivered with the note.
- **How soon it shows.** A WAX deposit is a `seen` row in `/v1/transfers`
  within a few seconds of its block, with `src_tx`, `account`, `amount` and
  `memo`; `credited` follows when the proof lands on Telos. A Telos burn is a
  `burned` row within a second or two, `released` a few seconds after the
  relayer pays it on WAX. Nothing on this route waits for the slow pass.
- **Bounds.** `available` is what may still go: the vault's holding for the
  backing route, the room under the cap for a spoke; `withdrawableNow` is that
  or `maxWithdrawal`, whichever is less. There is no daily meter on the WAX
  vault, so `outflowLeft` is null.
- **`active`** folds in the vault's pause flag on WAX, both light clients being
  bootstrapped, and the blockroot keeper following; `upkeep` shows each light
  client's schedule generation against the chain's — the relayers keep those,
  nothing here is for a user to send.

In `/v1/transfers` a WAX crossing has `domain` `"1181148696416462999"`,
`evm_address` the WAX account name, `token` the packed `(contract, symbol)`
that `symbol`/`precision` are resolved from, `src_tx`/`dst_tx` the WAX and
Telos transactions.

### XPR Network, both ways

XPR Network is the same kind of chain as WAX and every point above holds for it
under its own source, `"id": "xpr"`, domain `"4057084141687023600"`:

- **Tokens**: `eosio.token XPR` on the backing route, `wrap.alcor USDC`, `USDT`,
  `ETH` on XPR for the spokes. The vault is `bridge.alcor` on XPR too.
- **Timing** is slower than WAX on the way in: 21 producers sign in turn, and
  two rounds of 15 take about three minutes (`timing.deposit`). The way out is
  the same two minutes.
- **`upkeep`** carries `xprOnTelos` and `telosOnXpr` where WAX has `waxOnTelos`
  and `telosOnWax`; the keeper is at `/v1/xpr`.

### Vaulta, both ways

Vaulta (formerly EOS) runs Savanna, as Telos does, and the same contracts and
endpoints carry it under `"id": "vaulta"`, domain `"12439917377594391589"` —
twenty digits, past int64 as well as what a JSON number carries; keep it a
string end to end. Every point under WAX holds, with these differences:

- **Tokens**: `core.vaulta A` on the backing route, `wrap.alcor USDC`, `USDT`,
  `ETH` on Vaulta for the spokes. The vault is `bridge.alcor` on Vaulta too.
- **`strategy`** is `savanna`: blocks are proved by finality certificates
  (`savannalc` both ways, `vlt.lc.alcor` on Telos and `tls.lc.alcor` on
  Vaulta), not producer rounds.
- **Timing** is seconds both ways, with no producer rounds to wait for. The
  figures are an estimate until production is measured, and say so:
  `timing.*.measured` is `false`.
- **`upkeep`** has `kind: "finalizer policies"`, with `vaultaOnTelos` and
  `telosOnVaulta` as `{ held, active, lag }` in finalizer-policy generations
  (`active` is the newest the chain has published, pending or in force).
  `keeper` is always `null`: there is no blockroot keeper and no `/v1/vaulta`;
  the relayers prove everything, and a lag means one of them is behind.
- **`active`** folds in the vault's pause flag and both light clients holding a
  policy; there is no keeper to wait for.

### Sui, both ways

Sui is its own kind of chain, `"kind": "sui"`, `"id": "sui"`, domain
`"3856007665771390095"` (the first eight bytes of its chain identifier). On only
where the instance has `SUI_GRAPHQL`. Hops and swap plans go through Sui like
any chain: a deposit to `hop.alcor` (or `route.alcor`) with the memo in the
deposit, a way back of `<sui domain>:0x<64 hex digits>`.

- **Objects**, in `contracts`: the `vault` (shared), the `package` that defines
  it and the `telosClient` (shared). Read them from here, never from your own
  source: they are what the ledger's route names.
- **Routes** carry `coinType` (what to deposit, as a wallet takes it) instead
  of `token`, and the vault's own numbers: `vaultCap`, `vaultHeld`,
  `depositableNow`, `outflowPerDay`, `outflowLeft`, `withdrawableNow`, all in
  canonical units. `vaultEnabled` false: the vault refuses deposits of it.
- **A deposit** is one Move call from the user's Sui wallet, in a programmable
  transaction: split the amount off a coin, then
  `<package>::vault::deposit<coinType>(vault, coin, telos_to, refund_to, 0, 0, memo)`
  and transfer the coin it returns (the dust below one canonical unit) back to
  the sender. `telos_to` is the Telos account as its 64-bit name, `refund_to`
  the sender's Sui address, `memo` empty. The relayer proves it on Telos in
  seconds; it is a row in `/v1/transfers` like any other.
- **A withdrawal** starts on Telos as on every route: the bridge token to
  `bridge.alcor` with the memo `3856007665771390095:0x<64 hex>`. It is released
  on Sui by the recipient's wallet with `/v1/proofs/w:<id>` (below): the root,
  then `release_entry` — one programmable transaction. Past the deadline,
  `expire_entry` instead; the relayer then reissues it on Telos.
- **`strategy`** is `committee`: a checkpoint is final once the epoch's
  committee certified it. `committee` says which epoch `lightClient.account`
  holds.

### NEAR, both ways

NEAR is its own kind of chain, `"kind": "near"`: `"id": "near"`, domain
`"14338890689662875897"` on mainnet, and `"id": "near-testnet"`, domain
`"15529777497819211366"` on testnet (the first eight bytes of each genesis
hash). On only where the instance has `NEAR_RPC` / `NEAR_TESTNET_RPC`, and only
once the ledger has a route to it. Hops and swap plans go through NEAR like any
chain; in a hop memo a NEAR account is written as on Telos,
`<near domain>:0x<sha256 of the account id>` (`/v1/swap/plan` takes the account
id and writes the hash itself).

- **Addresses.** On Telos every NEAR account is the sha256 of its account id:
  the vault, each token (the NEP-141 contract's id; native NEAR is `NEAR`), each
  recipient. `contracts.vault` is the vault's account id (the route's gateway
  names it, checked against the route), `contracts.vaultAddress` its sha256.
  The vault holds the Telos light client too, so `contracts.telosClient` is the
  same account; `telosClient.generation` is the finalizer generation it seats.
- **Routes** carry `nearToken` (the NEP-141 contract, or `NEAR`) instead of
  `token`, and the vault's own numbers: `vaultCap`, `vaultHeld`,
  `depositableNow`, `outflowPerDay`, `outflowLeft`, `withdrawableNow`, all in
  canonical units. `vaultEnabled` false: the vault refuses deposits of it.
- **A deposit** is one call from the user's NEAR wallet. A token:
  `ft_transfer_call` on the token contract with `receiver_id` = the vault,
  `amount` (raw units), and `msg` = `{"telos_to":"<telos account>"}` (optional
  `refund_to`, `memo`); what does not divide into whole canonical units is
  returned by the token. Native NEAR: `deposit_near({"args":{"telos_to":…}})`
  on the vault with the amount attached — a whole number of canonical units,
  nothing is returned. The relayer proves it on Telos in seconds.
- **A withdrawal** starts on Telos as on every route: the bridge token to
  `bridge.alcor` with the memo `<domain>:0x<sha256 of the NEAR account id>`
  (the vault's view `address_of({"id": "alice.near"})` returns that hash). It is
  released on NEAR by the recipient's wallet with `/v1/proofs/w:<id>` (below).
  Past the deadline, `expire` instead; the relayer then reissues it on Telos.
- **`strategy`** is `approvals`: a head is final once more than two thirds of
  its epoch's block-producer stake approved it. `provedTop` is the newest head
  `lightClient.account` accepted.

### Ethereum ↔ WAX, through Telos

Two source chains never meet directly: Ethereum to WAX is a deposit to Telos
and a withdrawal from it. The hop contract, `hop.alcor` on Telos, makes that one
transfer for the user — nothing is signed on Telos and nothing is claimed there.

- **Which pairs exist** is `GET /v1/routes`: every asset, every pair of chains,
  with `via: "telos"` on a hop, whether it is `open` (and a `reason`
  when not), its `min`/`max` in canonical units, and `how` to start it.
- **Ethereum → WAX** is an ordinary `deposit` on Ethereum with `telosTo` set to
  `hop.alcor`, `refundTo` the user's own address, and the memo
  `<wax domain>:<wax account>|1:<user's address>` — where it goes, then where it
  goes back to if WAX never pays it. Check first that the WAX account exists: the
  bridge cannot see WAX accounts, and one that does not exist costs the user a
  week before the tokens come back.
- **WAX → Ethereum** is a transfer on WAX to the vault (`bridge.alcor`) with the
  memo `hop.alcor:1:<0x address>|<wax domain>:<wax account>`. The Ethereum leg is
  then a withdrawal like any other, `w:<id>`: the user releases it from their own
  wallet (see *A withdrawal to Ethereum, start to finish*).
- **Delivered by the courier.** The leg out may carry a fee, as a withdrawal
  from Telos does: `<domain>:<recipient>:<fee>|<way back>`, for example
  `hop.alcor:56:<0x address>:<fee>|<wax domain>:<wax account>`. The fee is in
  canonical units of the token, out of the amount, and goes to whoever releases
  the leg: the courier takes it from `/v1/pending` and releases it, so the user
  needs no wallet or gas on the EVM chain. What to ask is the courier's
  `GET /v1/fees` → `withdrawal` for that chain and token. The
  amount less the fee must still be at least the leg's minimum, or the hop is
  refused. The way back carries no fee (`<domain>:<recipient>` only); a leg
  voided over there comes back whole, its fee too. The leg's row on
  `/v1/transfers` has the `fee`; above zero, the release button is the
  courier's, until the leg is flagged `stuck`.
- **Following it** is `GET /v1/hops?party=<address or account>` for a list, or
  `GET /v1/hops/<deposit key>` for one. Each is one journey with a `status` a
  person understands. On `/v1/transfers` the two legs are two rows, and each
  carries a `hop` field pointing at the other and at the journey.
- **When it goes wrong, it goes back.** A hop the contract refuses — no memo, a
  bad one, a closed route, an amount out of bounds — never leaves the deposit:
  an hour later it is sent back to `refundTo` on the chain it came from. A leg
  the far chain never pays is voided at its deadline and sent to the way back.
  A deposit to `hop.alcor` with no memo is refused like any other bad one.

### Swaps: any token in, any token out, one signature

A crossing can start with a swap on an EVM chain, swap in the middle on Telos,
and end with a swap on an Antelope chain. Every address and format below comes
from `GET /v1/chains`: `swaps` on each source, and `settlement.swaps` /
`settlement.hopMemo` on Telos. `swaps` is `null` wherever the contract is not
deployed, and then that leg does not exist.

- **The swap memo.** A crossing pays out to `bridgeroute` — `swaps.route`,
  `route.alcor` — instead of the user, with the memo `swaps.memo.format`:

      <to>|<least out>@<token contract>|<deadline>[|<back>]
      alice|403.5737 TLM@alien.worlds|1760300000
      56:0x5b38…ddc4|99.500000 USDT@wrap.alcor|1760300000|137:0x5b38…ddc4

  `to` is where the token bought goes, `back` where the token that arrived goes
  if it is never swapped; `back` left out is `to`. Each is an account on the
  chain the order is on, or — **on Telos only** — a leg, `<domain>:<recipient>`,
  on a chain the bridge reaches from Telos: an EVM address with its chain id,
  an account with an Antelope chain's domain. A leg may end in a courier fee,
  `<domain>:<recipient>:<fee>`, in canonical units of the token delivered there
  (the one bought for `to`, the one that arrived for `back`), and the token less
  the fee must clear that leg's minimum; `back` left out is `to` without its fee.
  The least is written as
  swap.alcor writes an asset, its decimals giving the precision; the deadline
  is unix seconds, at most `swaps.memo.maxWait` ahead.

  The executor swaps it on Alcor's pools and orderbooks within seconds of the
  payout. Either the token asked for — at least the least — is delivered to
  `to`, or the token that arrived is delivered to `back`. A memo the contract
  cannot read, a deadline already passed, a token that does not exist, a token
  that has no route to `to`'s chain, or a least under that route's minimum:
  delivered to `back` as it arrived. Refused, and the crossing goes home the way
  a refused deposit does, only when `to` or `back` is neither an account nor a
  leg, or `back` is a leg the token that arrived could never be withdrawn to.
  The account `back` names can take the tokens as they arrived at any time with
  `route.alcor::cancel(id)`; an order whose `back` is a leg ends by `refund` at
  its deadline.

- **To a leg** — the swap in the middle. On Telos, a delivery to a leg is a
  transfer to `hop.alcor` with that leg as where it goes, and the same place
  without a fee as where it goes back to: a withdrawal to the leg, owned by the
  hop, with the leg's fee. Following it is that withdrawal, `swap.onward`
  (below). A withdrawal to an EVM chain is released by the courier when it pays
  a fee, else from the user's own wallet; one to an Antelope chain is delivered
  by the relayer. If the far side voids it,
  `hop.alcor::recover` sends it to the same leg again. A delivery the ledger
  refuses for now — over the leg's `max_withdrawal`, the route closed or out of
  backing — leaves the order waiting until it fits or its deadline passes.

  Telos is the only place where an order can be delivered to another chain.
  So EVM → EVM with a different token is a swap on Telos: Polygon USDC to BSC
  USDT is a deposit on Polygon with `telosTo: route.alcor`, `refundTo` the
  user, and the memo `56:<address>|<least>@wrap.alcor|<deadline>|137:<address>`.
  The token bought has to be one the bridge carries to `to`'s chain
  (`wrap.alcor`, with a route there in `/v1/chains`).

- **Where it goes in.** To Telos: from an EVM chain, a deposit with `telosTo`
  `route.alcor` and the swap memo as the deposit's memo; from WAX, XPR or
  Vaulta, a transfer to the vault with the memo `route.alcor:<swap memo>`. To
  WAX, XPR or Vaulta: the hop's third part — deposit to `hop.alcor` with
  `<domain>:route.alcor|<way back>|<swap memo>` (`settlement.hopMemo`); from
  Telos it is a withdrawal's fourth field, `<domain>:route.alcor:0:<swap memo>`.
  There `to` and `back` are accounts on that chain. The whole memo has to fit in
  `maxBytes` (256); EVM to EVM with both legs is about 135.

- **Swap at the start** (Ethereum, BSC, Polygon). `GET /v1/swap/quote` returns the
  `Swap` half of `AlcorRouter.swapAndDeposit` (an ERC-20, signed over with
  Permit2) or `swapNativeAndDeposit` (the native coin as value). The `Delivery`
  half is what a plain deposit takes — `telosTo`, `fillFee`, `filler`, `memo` —
  and `refundTo` is always the sender. So EVM → swap → WAX is the router with
  `telosTo: hop.alcor` and the hop memo above. AlcorRouter is not deployed
  anywhere yet: `swaps` is `null` on every EVM chain.

- **Following it.** On `/v1/transfers` the row whose payout made an order carries
  `swap`:

  ```json
  { "chain": "telos", "id": 12, "status": "swapped",
    "to": "56:0x5b38…ddc4", "back": "137:0x5b38…ddc4",
    "input": "100.000000 USDC@wrap.alcor", "least": "99.500000 USDT@wrap.alcor",
    "deadline": 1760300000,
    "paid": [{ "to": "56:0x5b38…ddc4", "asset": "99.731200 USDT@wrap.alcor" }],
    "onward": ["w:412"],
    "summary": "delivered as 99.731200 USDT",
    "payoutTx": "…", "closedTx": "…" }
  ```

  `status` is `swapping`, `swapped`, `unread`, `late`, `expired`,
  `cancelled`, `over cap` or `returned` (a market order the executor gave up
  on). `paid` says what was delivered where. `onward` lists the
  withdrawals that carry a delivery to a leg on — follow `/v1/transfers/w:412`
  for the rest of the journey, including the release on an EVM chain; it is
  empty for a delivery on the order's own chain, and until the indexer has
  read the withdrawal (seconds). A hop's journey (`/v1/hops/<key>`) carries the
  same `swap` at the top.

## Endpoints

### `GET /docs`

This document, as `text/markdown`. Shipped inside the image, so it always
matches the build that serves it.

### `GET /health`

Both followers, lag, alarms, storage, recent incidents. `status` is
`following` | `catching-up` | `degraded`; `alarms` is a list of sentences meant
to be shown to a human as they are.

Besides the infrastructure, `alarms` names the crossings an operator should
look at:
- deposits held on Telos for over an hour;
- deposits over their route's cap;
- withdrawals waiting on a vault's daily limit;
- every withdrawal of the last 24 hours that took at least half of its route's
  `maxWithdrawal`.

A crossing is named by its key (`w:441`, `d:1:138`), as `/v1/transfers/<key>`
and `/v1/activity/<key>` take it.

```json
{
  "instance": "telos-production",
  "status": "following",
  "alarms": [],
  "savanna": { "chain": "telos", "at": 489599838, "head": 489599839, "behind": 1, "mismatches": 0 },
  "sources": [{ "chain": "mainnet", "at": 26091656, "head": 26091656, "behind": 0, "wiring": "as configured" }],
  "histories": [{ "chain": "telos", "at": 495384480, "lib": 495384482, "behind": 2, "lastError": null }],
  "trustedRoots": 2,
  "committee": { "stored": 1363, "head": 1363, "lagPeriods": 0 },
  "ram": [
    { "chain": "telos", "account": "bridge.alcor", "used": 943396, "quota": 3302986, "free": 2359590 },
    { "chain": "telos", "account": "hop.alcor", "used": 343520, "quota": 1403250, "free": 1059730 },
    { "chain": "wax", "account": "bridge.alcor", "used": 402590, "quota": 1677339, "free": 1274749 }
  ],
  "transfers": { "deposit.seen": 1, "withdrawal.provable": 1, "withdrawal.refunded": 1 }
}
```

`committee.lagPeriods` above 1 means deposits will start failing: the Ethereum
sync committee cannot skip a period. It is an operator alarm, not a user one.

`ram` is what the ledger, the hop and the WAX vault have left for the rows they
pay for themselves. Out of it, every credit and every withdrawal on every route
fails until someone buys more, so an account under `RAM_ALARM_BYTES` (250 000 by
default) is an alarm too. Read once a minute. The relayers' own accounts pay for
every block they prove to a light client; list them in `RELAYER_RAM_ACCOUNTS` as
`<chain>:<account>` pairs (`telos:payer,xpr:relayer`) and each one under
`RELAYER_RAM_ALARM_BYTES` (32 000 by default) is an alarm as well.

`histories` is the indexer's own history of each Antelope chain, read from
irreversible blocks of its state-history socket. One more than ten minutes
behind its chain's last irreversible block, or not advancing for ten, is an
alarm; `lastError` says why — a lost socket, or a gap the node no longer holds.

A crossing waiting on the bridge three times past its route's usual time, and at
least fifteen minutes, is an alarm whatever stopped it — a relayer down or out of
RAM, a follower stuck — unless a hold already explains it.

### `GET /v1/chains`

What this deployment is connected to, and how far along each side is. One answer
for "is everything moving?" across every chain there is a route to, rather than
for the pair this process was configured with.

```json
{
  "settlement": {
    "id": "telos",
    "accounts": { "bridge": "bridge.alcor", "…": "…" },
    "at": 489841501, "head": 489841502, "leaves": 9554846,
    "note": "one state-history stream and one finality tree serve every source chain"
  },
  "sources": [
    {
      "id": "bsc", "chainId": 56, "strategy": "parlia",
      "head": 132231549,
      "provedTop": { "block": 132224274, "hash": "0x…", "at": "…", "signers": 9 },
      "behind": 7275,
      "lightClient": { "account": "bsc.lc.alcor", "contract": "0x4b95…" },
      "gateway": "bsc.g.alcor",
      "contracts": { "vault": "0x53f1…", "withdrawals": "0x6132…" },
      "upkeep": { "kind": "validator sets", "action": "updateset",
                  "stored": 132224000, "chain": 132231000, "lag": 7 },
      "active": { "deposits": true, "withdrawals": true },
      "timing": {
        "deposit": {
          "seconds": 32, "range": [1, 65], "measured": true,
          "human": "about 32 s (1 s\u201365 s)",
          "parts": [
            { "what": "BNB Smart Chain confirms the deposit", "seconds": 2 },
            { "what": "the bridge delivers it to Telos", "seconds": 30 }
          ]
        },
        "withdrawal": { "seconds": 32, "range": [1, 64], "measured": true,
                        "human": "about 32 s (1 s\u201364 s)", "parts": […] }
      },
      "routes": [{ "symbol": "BNB", "scale": "10000000000",
                   "available": "1240000000", "minWithdrawal": "1000000", "maxWithdrawal": "50000000",
                   "outflowLeft": "30000000", "withdrawableNow": "30000000",
                   "deposits": true, "withdrawals": true }]
    }
  ]
}
```

Only the routes of the vault this deployment follows on each chain are listed;
routes of a retired vault stay on Telos, closed, and are left out.

The WAX source has the same shape with a few fields of its own:

```json
{
  "id": "wax", "name": "WAX", "kind": "antelope", "strategy": "producers",
  "chainId": "1064487b…", "domain": "1181148696416462999",
  "head": 458599140,
  "provedTop": { "block": 458590370, "hash": "1b5588a2…", "signers": 6 },
  "lightClient": { "account": "wax.lc.alcor", "contract": "tls.lc.alcor" },
  "gateway": "wax.g.alcor",
  "contracts": { "vault": "bridge.alcor", "withdrawals": "bridge.alcor", "mirror": "wrap.alcor" },
  "upkeep": { "kind": "producer schedules",
              "waxOnTelos": { "held": 937, "active": 937, "lag": 0 },
              "telosOnWax": { "held": 7901, "active": 7901, "lag": 0 },
              "keeper": { "status": "following", "committed": 458599031, "head": 458599140 } },
  "active": { "deposits": true, "withdrawals": true },
  "timing": { "deposit": { "seconds": 50, "…": "…" }, "withdrawal": { "seconds": 107, "…": "…" } },
  "accountFormat": "^[a-z1-5.]{1,12}$",
  "routes": [
    { "kind": "backing", "symbol": "WAX", "precision": 8, "token": null,
      "antelopeToken": { "contract": "eosio.token", "symbol": "WAX", "precision": 8 },
      "available": "0", "withdrawableNow": "0", "outflowLeft": null,
      "withdrawMemo": "1181148696416462999:<account>", "depositMemo": "<telos account>[:<note>]", "…": "…" },
    { "kind": "spoke", "locked": "0", "symbol": "USDC", "precision": 6, "token": null,
      "antelopeToken": { "contract": "wrap.alcor", "symbol": "USDC", "precision": 6 },
      "available": "10000000000", "withdrawableNow": "2000000000", "…": "…" }
  ]
}
```

`lightClient.account` is the WAX light client on Telos and `lightClient.contract`
the Telos light client on WAX; `contracts.vault` holds WAX and issues the
mirrors on `contracts.mirror`. A `spoke` route holds no collateral over there:
`locked` is what Telos keeps for the mirror, and `available` is the room under
its cap. See [WAX, both ways](#wax-both-ways) for what a form does with these.

Bounds on a withdrawal to a chain, all in canonical units:

| field | what it is | where it is enforced |
|---|---|---|
| `available` | what that chain's vault holds for the supply circulating on Telos — the asset is one token on Telos, but each chain pays out only what arrived there | Telos refuses more before anything burns |
| `maxWithdrawal` | the largest single withdrawal the route opens | Telos refuses more |
| `minWithdrawal` | the smallest one; the route's `min_deposit`, which holds both ways | Telos refuses less |
| `outflowPerDay` | the vault's daily allowance for the token; `null` when unmetered (every WAX route) | the vault |
| `outflowLeft` | what is left of it right now; `null` when the token has no limit | the vault: more is accepted on Telos, then waits on the far side for the limit to refill |

`withdrawableNow` is the least of the three: the most that burns now **and**
pays out today. Show it next to the chain in a withdrawal form. When the vault
could not be read, the route has `outflowError` instead of `withdrawableNow` —
unknown, which is not the same as unlimited.

Bounds on a deposit from a chain, the same units:

| field | what it is |
|---|---|
| `minDeposit` | the smallest deposit the route credits; the vault refuses less before it locks anything |
| `cap` | what may be held for the route: on an Ethereum route `"0"`, the vault caps its own balance; on a WAX route the bound on WAX held over there (backing) or on the mirror's supply locked here (spoke) |
| `fastMax` | the largest deposit credited on an unfinalized proof, with `minConfirmations` blocks on top; `"0"` means every deposit waits for finality. An Antelope proof is final, so a WAX route has no fast path |
| `vaultCap`, `vaultHeld` | on an Ethereum route: the vault's own cap on what it holds of the token, and its balance now; `vaultCap` is `null` when uncapped |
| `depositableNow` | the most one deposit can still add: `vaultCap − vaultHeld` on an Ethereum route, the room under the Telos `cap` on the WAX backing route, the mirror `locked` on a WAX spoke (no more can come home than went out); `null` when nothing caps it. Above it the vault refuses with `CapExceeded`, so a form should say so before anyone signs |
| `vaultEnabled` | the vault takes this token at all (`AssetDisabled` otherwise) |

`provedTop` is the highest block this deployment has **proved on Telos**, read out
of the light client's own table — not the highest it has seen. `behind` is the gap
to the chain's head, and on a healthy route it is however long nobody has needed a
proof, not a backlog.

`upkeep` is what each consensus costs to keep provable, and it is the one field
worth alarming on. It reports whatever that chain's mechanism actually waits for,
which is a different thing for each consensus:

| strategy | `kind` | what goes wrong |
|---|---|---|
| `beacon` | sync committee | a period is skipped and no deposit can be proved until it is walked |
| `parlia` | validator sets | `lag` above zero: deposits newer than `stored` wait |
| `milestone` | validator set | `current: false`: Heimdall's set moved and the polygon relayer has not installed it yet; proofs wait |
| `producers` | producer schedules | `lag` above zero: the relayer has not proved a schedule change yet (WAX, XPR) |
| `savanna` | finalizer policies | `lag` above zero: the relayer has not proved a policy transition yet (Vaulta) |

A sync committee rotates about once a day, a Parlia validator set every seven
and a half minutes and Heimdall's about hourly; none of the rotations can be
skipped.

#### `active` — the flag to grey a button on

Four facts have to agree before a direction is open, and they live in four
places: the mechanism (this repo), the contracts (the far chain), the route
(Telos), and the vault's own pause flags (the far chain again). Any one of them
closes the direction, so the endpoint reports the conjunction and names every
reason it is false:

```json
"active": { "deposits": true, "withdrawals": false,
            "reason": "withdrawals are paused at the vault" }
```

The vault flags are read from the vault on every request, which is the half a
front end cannot infer: a guardian halting a vault touches nothing on Telos, so a
status built from the bridge's tables alone would show a halted chain as open. A
vault that does not answer counts as closed, not as open — unknown is not the
same as fine.

#### `timing` — how long each direction takes

Per chain, because the answer is per chain by more than an order of magnitude:

| chain | deposit | withdrawal |
|---|---|---|
| BNB Smart Chain | about 32 s (1–65 s) | about 32 s |
| Ethereum | about 17 min (13–20) | about 55 s |
| Polygon PoS | about 38 s (5–80 s) | about 34 s |

Withdrawals are quick everywhere for one reason: the slow half of a crossing is
always the chain being **proved**, and on that side it is Telos, which finalizes
in a second. What is left is a relayer's poll and one transaction.

Deposits differ because the proof differs. BSC carries finality in its own
headers. Ethereum needs two epochs. Polygon is proved from a Heimdall milestone
over the block; a deposit that path has not closed in half an hour falls back
to a checkpoint proved through Ethereum, about forty minutes more.
`src/chains/eta.ts` carries the measurement behind every figure.

`range` is `[fastest, slowest]` in seconds and `seconds` is the typical case.
Nothing here is a single number: a relayer's poll can fire at once or a minute
later, and an epoch boundary can be missed. `measured: false` marks an estimate
not yet observed on mainnet (Vaulta).

### `GET /v1/pending`

The queue of everything waiting for somebody to sign. This is the screen.

```
?account=alcor     only that Antelope account's crossings
?address=0x…       only that EVM address's
?chain=mainnet     only what is pushed there
?ready=true        only what can be signed right now
```

```json
{
  "pending": [
    {
      "key": "w:1",
      "direction": "withdrawal",
      "action": "submitRoot + release (~2.6M gas)",
      "pushOn": "mainnet",
      "ready": true,
      "reason": "burned and not yet released",
      "proof": "/v1/proofs/w:1",
      "account": "alcor",
      "evmAddress": "0x17942036d5b3c5b7e4017f2db12aacd0b7680b8a",
      "amount": "10000000",
      "symbol": "ETH",
      "precision": 8,
      "deadline": { "at": 1790693001, "secondsLeft": 874200,
                    "what": "after this it can no longer be claimed, only cancelled and refunded on Telos" }
    }
  ],
  "count": 1
}
```

`pushOn` is the chain the transaction goes to: `telos` for everything settled
on Telos (credits, refunds, the operator's rotations), otherwise the far chain
by its registry id. Every transfer's item carries `symbol` and `precision`, the
units of `amount` — null for a token the bridge lists no route for.

A deposit's `deadline` exists only on a beacon chain (Ethereum): its finalized
proof carries one beacon header per slot back to the block, and the indexer
builds none longer than 4096 of them — about 13.6 hours. BSC, Polygon and the
Antelope chains have no such clock, so their deposits carry no `deadline`.

A deposit's `action` says which proof it would come with — `proveroot + credit
(fast, 40 confirmations)` or `(finalized)` — and `ready` is decided from the
confirmation count alone, so polling this costs no beacon requests.

Items that are **not** ready are listed too, with the reason. A deposit waiting
two minutes for confirmations is normal; one that has been waiting nine hours is
what you need to show. Do not filter them out by default.

`direction` here is finer than on a transfer: `withdrawal`, `withdrawal-expire`,
`withdrawal-rollback`, `deposit`, `finalizer-key`, and `committee` for the one
operator item, which also carries `"admin": true`.

A `finalizer-key` item is not anyone's transfer and needs no one's permission:
a producer finalizing Telos whose key that chain's light client has never seen.
Until it is registered every withdrawal to that chain fails, so a UI can offer
it to whoever is withdrawing there — one transaction, about 470k gas, with the
arguments at `/v1/finalizer-keys`.

### `GET /v1/finalizer-keys`

The finalizer keys each withdrawal chain's `TelosLightClient` does not know,
with the `registerKey` call that teaches it. Anyone may send it; the call
carries the key's proof of possession, which the contract checks, so the
sender vouches for nothing.

```
?chain=mainnet     only that chain
```

```json
{
  "asOf": 1790693001,
  "activeGeneration": 149,
  "chains": [
    {
      "chain": "mainnet",
      "name": "Ethereum",
      "lightClient": "0xd6716330ce88b83b4d35b516e5b0abc2536c5651",
      "known": 29,
      "missing": [
        {
          "finalizer": "powernoru112",
          "keyId": "0xa0e0c440…",
          "inPolicy": false,
          "registerKey": {
            "to": "0xd6716330ce88b83b4d35b516e5b0abc2536c5651",
            "signature": "registerKey(bytes,bytes)",
            "args": ["0x<96-byte key>", "0x<192-byte proof of possession>"],
            "gas": 470000
          }
        }
      ]
    }
  ],
  "unknownToHistory": []
}
```

`inPolicy: true` is the urgent kind: that producer is in Telos's active or
pending finalizer policy, and withdrawals to the chain fail until the key is
registered. Those, and only those, also appear in `/v1/pending`. `false` is a
registered producer not finalizing yet — registering it early is what keeps
the day it starts from being an outage. Missing ones come urgent first.

Refreshed every ten minutes. `unknownToHistory` lists policy keys with no
registration in Telos history to take a proof of possession from; it should
always be empty.

### `GET /v1/upkeep`

The maintenance the bridge needs right now, and the transactions that do it.
Built for a front end that wants to offer them to whoever is connected: every
EVM step here is permissionless, and the contract checks what it is given, so
the sender vouches for nothing and only pays gas.

```
?chain=mainnet     only that chain
```

```json
{
  "asOf": 1790726775,
  "todo": [
    { "chain": "mainnet", "action": "advancePolicy", "count": 1, "urgent": false, "anyone": true }
  ],
  "chains": [
    {
      "chain": "mainnet",
      "name": "Ethereum",
      "lightClient": "0xd6716330ce88b83b4d35b516e5b0abc2536c5651",
      "policy": {
        "held": 151,
        "active": 152,
        "lag": 1,
        "quorum": { "threshold": 15, "present": 18, "spare": 3 },
        "steps": [
          {
            "generation": 152,
            "telosBlock": 491407774,
            "submitRoot": {
              "to": "0xd6716330ce88b83b4d35b516e5b0abc2536c5651",
              "signature": "submitRoot((uint32,…),bytes,bytes,bytes32[],(bytes,bytes,bytes))",
              "args": { "finality": { "…": "…" }, "bits": "0x…", "signature": "0x…", "policyKeys": ["0x…"], "pending": { "policy": "0x…", "bits": "0x…", "signature": "0x…" } },
              "gas": 2200000
            },
            "installPolicy": {
              "to": "0xd6716330ce88b83b4d35b516e5b0abc2536c5651",
              "signature": "installPolicy(bytes)",
              "args": ["0x<packed policy>"],
              "gas": 400000
            }
          }
        ]
      },
      "keys": { "known": 32, "missing": 0, "inPolicy": 0 },
      "consensus": { "kind": "sync committee", "action": "updcommit", "stored": 1870, "head": 1870, "lag": 0 },
      "errors": []
    }
  ]
}
```

`todo` is the short answer, one line per thing to do:

| `action` | what it is | `anyone` |
|---|---|---|
| `advancePolicy` | the chain's `TelosLightClient` trails Telos by `count` generations, and finalizers who left have brought `policy.quorum.spare` to two or fewer | `true` when `policy.steps` has something to send |
| `registerKey` | `count` finalizers sign for Telos with keys the light client has never seen; the calls are in `/v1/finalizer-keys` | `true` |
| `updcommit` / `updateset` | the Telos-side light client for this chain is `count` periods (epochs, for BSC) behind; the relayer pushes these | `false` |

`urgent: true` means withdrawals or deposits are failing, or are about to,
until it is done. **`advancePolicy` is maintenance, not a prerequisite**: a
withdrawal is verified against whoever signed its certificate, and the light
client only counts how many of its own seats are among them — 15 of 21. A
rotation moves two seats, so a client two generations behind still sees at
least 17 of the current signers, and a fresh withdrawal releases without any
step here. What lag costs is that a finalizer Telos has *removed* keeps its
seat until the policy moves. `policy.quorum` counts it: `present` is the held
seats' weight whose finalizers were in Telos's policy within the last day — the
standby rotation hands a seat back in twelve hours, so it does not count as
leaving — and `spare` is `present − threshold`. At two or fewer the step is
offered; at none it is `urgent`, withdrawals fail until it is done, and
`/health` raises an alarm. `quorum` is null when it could not be read; then
`urgent` falls back to three generations of lag.

`registerKey` is the one that can block: a certificate signed by a key the
light client has never seen cannot be verified at all, so when `keys.inPolicy`
is above zero, the calls in `/v1/finalizer-keys` come before any withdrawal
signed by that finalizer.

**Advancing the policy.** `policy.steps` is oldest first, and each step is two
transactions, `submitRoot` then `installPolicy`, to `lightClient`. Send one
step's pair and wait for both to land before the next: a handover is signed by
the generation it hands over from, so the light client has to hold it first.
`submitRoot.args` has the same shape as a withdrawal's `hard.submitRoot`, so the
same encoder serves both. A step someone else already took reverts; refetch and carry on.

`policy.blocked` appears when the light client needs a generation with no
stored handover. The indexer stores each one a few seconds after Telos
publishes it; if it missed one and state-history has since pruned it, only the
policy admin's `setPolicy` moves the light client on. It is also a `/health`
alarm.

Refreshed every minute.

### `GET /v1/transfers`

```
?account= &address= &direction= &status= &flag= &limit= &before=
```

`before` is a unix second, for paging: pass the `src_time` of the last row you
have. `limit` defaults to 50, caps at 500. Rows are newest first.

```json
{
  "key": "d:1181148696416462999:3", "direction": "deposit", "ref": 3, "status": "credited",
  "chain": "wax", "domain": "1181148696416462999",
  "account": "carol", "evm_address": "carol.wam",
  "amount": "2000000000", "amountHuman": "20 WAX",
  "asset": { "symbol": "WAX", "precision": 8, "contract": "eosio.token" },
  "symbol": "WAX", "precision": 8, "token": "00a6823403ea30550857415800000000",
  "src_block": 458605094, "src_time": 1790789587, "src_tx": "5ac0df3b…",
  "dst_block": 491538543, "dst_time": 1790789646, "dst_tx": "b1879643…",
  "deadline": null, "secondsToDeadline": null, "memo": null, "fee": null,
  "flags": [], "hasProof": false, "track": null,
  "progress": { "stage": "Arrived on Telos", "percent": 100, "etaSeconds": null, "exact": true, "waitingOn": null },
  "state": "delivered"
}
```

`state` is the row's place in the four words `/v1/activity` uses; `status` the
detailed step. For a hop the row is one leg — the journey's own `state` is on
`/v1/activity/<deposit key>`.

`fee` is a withdrawal's delivery fee, canonical units out of `amount`, signed
with the burn. Above zero the courier releases it and the owner has nothing to
send; zero or null leaves the release to the owner.

**What to render.** `chain` is the far chain by its registry id (`mainnet`,
`wax`), `asset` the token as a person knows it — `symbol`, `precision`, and
where it lives over there: `address` for an ERC-20, `contract` for an Antelope
token — and `amountHuman` is `amount` already formatted with them. `account`
is the Telos side, `evm_address` the far side: a hex address on an EVM chain,
an account name on WAX. Times are unix seconds from the block.

Both transactions travel with every crossing: `src_tx` where it started and
`dst_tx` where it landed, on the two different chains. A rollback takes a third
— burned here, expired there, reissued here — and that one is `refund_tx`.

They are filled from the stream as the actions go by. A crossing the stream did
not see whole is completed from the indexer's own history of each chain on the
next reconcile pass: the token and the crediting transaction from Telos's
`credit`, the WAX transactions from the vault's `deplog` and `release`. So every
row ends up with both halves.

`src_*` is where the crossing started, `dst_*` where it was settled. Times are
unix seconds and come from the **block**, not from when the indexer saw it.

`amount` is canonical units as a decimal string — a `uint64` on chain, so keep
it a string or a `BigInt` rather than a number. **It means nothing without
`precision`**: `1000000` is `0.01 ETH` on one route and `1.000000 USDT` on
another. Both travel with every row:

```js
const shown = `${Number(t.amount) / 10 ** t.precision} ${t.symbol}`
```

`symbol` and `precision` come from the listing the bridge holds on chain, read
fresh, so an asset listed a minute ago renders correctly with no deploy. They
are `null` only when the route a transfer used has since been removed, and there
is nothing left to resolve them from.

`GET /v1/transfers/<key>` returns one of these.

**`progress`** is on every row, so nothing has to be computed in the browser:

```json
"progress": { "stage": "7 of 12 confirmations on Ethereum", "percent": 53,
              "etaSeconds": 65, "exact": true, "waitingOn": "bridge" }
```

Confirmations are counted the way the ledger counts them: blocks built on top
of the deposit's own, so a deposit is creditable at `minConfirmations`, and the
count here, in `/v1/pending` and in a fast proof's `confirmations` is the same
number.

`stage` says what is happening now; `percent` is 0–100; `etaSeconds` is how long
until the bridge's own part is done. `exact` is true where it is counted from
the chain (confirmations on a fast route) and false where it is estimated from
measured timings (WAX producers confirming, Ethereum finalizing) — an estimate
stops at 95 and never claims to be finished. `waitingOn` is `"bridge"`,
`"user"` — a withdrawal to Ethereum that is ready for the user to release, with
`etaSeconds: null` — or null once there is nothing left to do.

**`hop`** is null unless the row is one leg of a hop through `hop.alcor`. On the
deposit it names the withdrawal that carried it on; on a withdrawal, the deposit
(or, for a way back, the hop it returns):

```json
"hop": {
  "journey": "d:1:42", "next": "w:118",
  "to":   { "domain": "1181148696416462999", "recipient": "alice.wam", "chain": "wax" },
  "back": { "domain": "1", "recipient": "0xab…", "chain": "mainnet" }
}
```

On a withdrawal the second field is `"from": "d:1:42"` instead of `next`. A
withdrawal a `route.alcor` order sent on Telos — the token bought, or the one
that arrived going back — also names the order, how it ended (a `swap.status`)
and the deposit that paid it in; `order` is null on any other leg:

```json
"order": { "chain": "telos", "id": 9, "status": "expired", "deposit": "d:56:9" }
```

### `GET /v1/routes`

```
?symbol= &from= &to=
```

Every way an asset can go, as pairs of chains by registry id: straight to and
from Telos, and between two source chains through the hop contract.

```json
{ "symbol": "USDC", "precision": 6,
  "from": "mainnet", "to": "wax", "via": "telos",
  "open": true, "min": "2000000", "max": "2000000000",
  "how": { "deposit": { "token": "0xa0b8…", "telosTo": "hop.alcor",
                        "memo": "1181148696416462999:<account>|1:<your address>" } } }
```

`via` is null for a direct crossing. `open` is false with a `reason` when either
end is closed or the hop contract is not deployed. `min` and `max` are canonical
units; `max` is null where nothing bounds it. On a hop they are the tightest of
everything the contract checks: `min` the floors of the route it goes on by and
the route it would come back by; `max` the route it goes on by and what the
first chain may still take in. The way back's ceiling does not bound a hop: if
the far chain voids one larger than a withdrawal back may be, `recover` waits
until it fits (see `GET /v1/hops`).

`how` is what to send on the first chain: `deposit` on an EVM chain (the vault's
`deposit`, `telosTo` and `memo` filled in), `transfer` on an Antelope one (to the
vault, with `memo`). The `<…>` parts are the user's to fill. Recomputed every 30
seconds, from the same reads as `/v1/chains`.

### `GET /v1/hops`

```
?party= &limit= &before= &recover=true
```

Journeys through `hop.alcor`, newest first. `recover=true` lists instead only
the journeys waiting on a `recover` — a leg voided over there and not sent back
yet. `party` matches anyone to it: the
depositor, the recipient over there, the way back — a `0x` address or an account
name. `before` is a unix second, the deposit's `src_time` of the last journey you
have. A journey is listed from the moment its deposit is seen on the far chain
— seconds after a WAX transfer, a block after an Ethereum deposit — as
`arriving`, with `to` and `back` read from its memo until the hop opens.

```json
{ "key": "d:1:42", "status": "sending",
  "from": { "domain": "1", "address": "0xab…", "chain": "mainnet" },
  "to":   { "domain": "1181148696416462999", "recipient": "alice.wam", "chain": "wax" },
  "back": { "domain": "1", "recipient": "0xab…", "chain": "mainnet" },
  "deposit": { …a transfer row… },
  "legs": [ { "key": "w:118", "returning": false, "quantity": "5.000000 USDC",
              "to": { … }, "tx": "…", "at": 1790…, "transfer": { …a transfer row… } } ],
  "recover": null }
```

| `status` | meaning |
|---|---|
| `arriving` | the deposit is on its way to Telos |
| `bounced` | the hop refused it; it went back to where it came from |
| `sending` | carried on, on its way to the far chain |
| `delivered` | paid out over there — done |
| `returning` | the far chain voided it; on its way to the way back |
| `returned` | paid out at the way back — done |

A journey has its own `progress`, the same shape: the deposit is the first half,
the onward leg the second, and `etaSeconds` runs through the onward leg when a
relayer pays it (WAX) and up to the user's release when they do (Ethereum).

`recover` is non-null while a voided leg waits in the hop contract: the action
that sends it back. The relayer pushes it within a minute for a first leg;
anyone may. A way back that was voided as well — its account over there does
not exist, or refuses — the relayer leaves alone, since it would only be voided
again: its last leg has `returning: true`, and whoever fixes the way back pushes
the `recover`. So does a voided leg larger than the way back's `max_withdrawal`
(Ethereum's is the vault's daily outflow): `recover` is refused, the tokens wait
in the hop contract, and it goes through once the route takes the amount.

`GET /v1/hops/<deposit key>` returns one of these.

### `GET /v1/swap/plan`

One token on one chain to another token on another chain: everything to show
it and to sign it, or why it cannot go now.

```
/v1/swap/plan?from=xpr:XPR&to=vaulta:A&amount=1233
             &recipient=bob&sender=erin[&slippageBps=50][&deadlineSeconds=1800][&courierFee=<units>]
```

`from` and `to` are `<chain>:<SYMBOL>`, chains as `/v1/chains` names them
(`telos` included). On an Antelope chain any token can be named with its
contract, `xpr:LOAN@loan.token`; the bridge's own tokens need only the symbol
(`vaulta:A` is `A@core.vaulta`, `xpr:USDC` is `USDC@wrap.alcor`). On an EVM
chain only the bridge's tokens, by symbol. `amount` is in whole tokens.
`recipient` receives on the destination, `sender` is the user on the source.
`courierFee`, only for an EVM destination, is what the last leg pays the courier
to release it — canonical units of the token out, the courier's `/v1/fees`
`withdrawal` for that chain and token. It goes into the leg's memo
(`56:<address>:<fee>`) and out of `to`; left out or `0`, the user releases it.

A journey swaps in up to two of three places, and the plan answers the way that
delivers the most:

- **at the source**, on an Antelope chain: the user's own transaction swaps on
  Alcor there and sends what it bought to the bridge, in one signature. The
  transfer to the bridge sends the swap's least; what the swap gives above it
  stays with the sender (`leftover`).
- **on Telos**, by `route.alcor`, which sends what it bought on to the
  destination.
- **at the destination**, on an Antelope chain, by `route.alcor` there: the
  crossing (a hop through Telos, or a withdrawal from it) pays out to it with the
  swap memo.

Never on Telos and at the destination both, and nothing swaps on an EVM chain.

```json
{ "possible": true,
  "from": { "chain": "xpr", "symbol": "XPR", "contract": "eosio.token", "amount": "1233", "raw": "12330000", "precision": 4 },
  "to": { "chain": "vaulta", "symbol": "A", "contract": "core.vaulta", "recipient": "bob",
          "expected": "26.6841", "least": "26.5506", "raw": "266841", "precision": 4 },
  "carried": { "symbol": "USDC", "amount": "2.766575" },
  "swaps": [
    { "chain": "xpr", "by": "sender", "input": "1233.0000 XPR", "expected": "2.780409 USDC",
      "least": "2.766575 USDC", "priceImpact": "0.34", "pools": [15, 11708, 11710] },
    { "chain": "vaulta", "by": "route.alcor", "input": "2.766575 USDC", "expected": "26.6841 A",
      "least": "26.5506 A", "priceImpact": "0.46", "pools": [728] } ],
  "priceImpact": "0.80",
  "slippageBps": 50,
  "leftover": { "chain": "xpr", "asset": "0.013834 USDC", "contract": "wrap.alcor" },
  "deadline": 1760301800,
  "memo": "bob|26.5506 A@core.vaulta|1760301800",
  "back": "bob",
  "sign": { "kind": "actions", "chain": "xpr", "actions": [
    { "account": "eosio.token", "name": "transfer", "data": { "from": "erin", "to": "swap.alcor",
      "quantity": "826.1100 XPR", "memo": "swapexactin#15,11708#erin#1.853606 USDC@wrap.alcor#0" } },
    { "account": "eosio.token", "name": "transfer", "data": { "from": "erin", "to": "swap.alcor",
      "quantity": "406.8900 XPR", "memo": "swapexactin#11710#erin#0.912969 USDC@wrap.alcor#0" } },
    { "account": "wrap.alcor", "name": "transfer", "data": { "from": "erin", "to": "bridge.alcor",
      "quantity": "2.766575 USDC",
      "memo": "hop.alcor:12439917377594391589:route.alcor|4057084141687023600:erin|bob|26.5506 A@core.vaulta|1760301800" } } ] },
  "release": "relayer",
  "eta": { "seconds": 195, "parts": [ … ] },
  "follow": "the hop on /v1/hops/<deposit key>: its swap, then delivered" }
```

- `sign` is the one thing the user signs. On an Antelope chain (Telos
  included) `kind: "actions"`: the actions of one transaction, in order, ready
  to sign as they are — the swap's transfers, then the transfer to the bridge
  (the vault, or on Telos the ledger). On an EVM chain `kind: "deposit"`: a
  vault `deposit` with `token`, `telosTo` (`route.alcor`, `hop.alcor`), `refundTo`
  and `memo`; the amount in the token's own decimals is the front end's, as for
  any deposit.
- `swaps` lists every swap in order; `by: "sender"` is in the user's own
  transaction, `by: "route.alcor"` is the bridge's. `priceImpact` is theirs
  together. `carried` is the bridge's token that crosses.
- `memo` and `back` are those of the bridge's swap: what it must buy, and where
  what arrived goes if it never swaps (on Telos the source chain's sender; at
  the destination the recipient there, as the token that arrived). Both null
  when only the user swaps.
- `to.least` is what the recipient gets at the least; with no swap by the
  bridge it is exact.
- `release`: `courier` on an EVM destination with a `courierFee` (released for
  the fee), `user` on one without (released from their wallet), `relayer` on an
  Antelope one, null on Telos. `courierFee` in the answer is that fee in the
  token out, already taken out of `to.expected` and `to.least`; null for none. `follow` says where to watch it:
  the deposit on `/v1/transfers`, a hop on `/v1/hops/<deposit key>`, or a
  withdrawal from Telos on `/v1/transfers`.

Not possible now is still 200: `{ "possible": false, "reason": "…" }` — no pool
path, under a minimum, over what a crossing takes now, a route closed, the same
token on both ends (see `/v1/routes`), a `recipient` that cannot take the
delivery: an account that does not exist on Telos or the Antelope destination
(`… does not exist on WAX: create the account first`), or the bridge's own
account there (its vault, `route.alcor`, `wrap.alcor`). When no way works, the
reason is the first way's. A malformed request is 400; Alcor's router failing
on every way is 502 (failing on some, the others are still answered). The quote
is live: plan again right before signing, and do not reuse a memo past its
deadline.

### `GET /v1/swap/quote`

```
?chain=mainnet &tokenIn=0x… &tokenOut=0x… &amountIn=<raw units> [&slippageBps=50]
```

The swap half of a call to `AlcorRouter`, quoted by KyberSwap for the router as
its caller and recipient. `tokenIn` and `tokenOut` are addresses, the zero
address for the native coin; `tokenOut` must be a token the chain's vault takes
(a route's `token` in `/v1/chains`). 400 for a request that cannot be quoted
(an unknown chain, the router not deployed there, a `tokenOut` the vault does
not take), 502 when the aggregator fails.

```json
{ "chain": "mainnet", "provider": "kyberswap",
  "router": "0x…", "call": "swapAndDeposit", "value": "0",
  "swap": { "tokenIn": "0x6982…", "amountIn": "100000000000000000000000000",
            "swapper": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", "data": "0xe21f…",
            "tokenOut": "0xa0b8…", "minOut": "405400000" },
  "expectedOut": "407437802",
  "permit2": { "address": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
               "token": "0x6982…", "amount": "100000000000000000000000000", "spender": "0x…" } }
```

Send `call` on `router` with `swap`, the deposit's `Delivery` and — for
`swapAndDeposit` — a Permit2 `PermitTransferFrom` for `permit2.token` and
`amount`, `spender` the router, signed by the sender (who must have approved
Permit2 for the token once). `swapNativeAndDeposit` takes `value` and no permit.
`minOut` is `expectedOut` less the slippage; below it the transaction reverts,
and nothing moves. The quote is for the head: send it within a block or two.

### `GET /v1/accounts/<name>` and `…/transfers`

```json
{ "account": "alcor",
  "counts": { "provable": 1, "credited": 3, "released": 2 },
  "open": 1, "needsAttention": 0,
  "claimable": [ { "symbol": "ETH", "amount": "1000000", "precision": 8 } ],
  "claims":    [ { "trx_id": "…", "symbol": "ETH", "block": 489…, "at": 1789… } ],
  "transfers": [ … ] }
```

`needsAttention` counts rows with any flag — the badge.

`claimable` is what the bridge is holding for this account right now, read from
the chain. A deposit to a plain account (no code, no memo) is paid to its balance
in the credit itself, and so is a refund, so for a person this is normally empty.
It is not empty for a contract's refund, a solver's balance, or a deposit
credited before 2026-10-14, when deposits were still collected by hand: those
wait here until the owner sends `bridge.alcor::claim`. `claims` is what they
have already picked up.

### `GET /v1/volume`

How much crossed and how many people crossed it, per asset and direction:
for a stats page, and for the operator choosing limits. `?days=` (1–366,
default 30) sets how many days `daily` covers.

```json
{
  "asOf": 1790856000,
  "windows": {
    "24h": {
      "since": 1790769600,
      "days": 1,
      "people": {
        "deposit":    { "accounts": 1, "addresses": 1 },
        "withdrawal": { "accounts": 1, "addresses": 1 },
        "all":        { "accounts": 1, "addresses": 1 }
      },
      "assets": [
        {
          "direction": "withdrawal", "chain": "wax", "symbol": "WAX", "token": "…",
          "count": 2, "amount": "1500000000", "amountHuman": "15 WAX",
          "accounts": 1, "addresses": 1,
          "perDay": "1500000000", "perDayHuman": "15 WAX",
          "peakDay": { "day": "2026-09-30", "amount": "1500000000", "amountHuman": "15 WAX" }
        }
      ]
    },
    "7d": { "…": "…" }, "30d": { "…": "…" }, "all": { "…": "…" }
  },
  "daily": [
    { "day": "2026-09-30", "direction": "deposit", "chain": "mainnet", "symbol": "USDC",
      "count": 2, "amount": "105000000", "amountHuman": "105 USDC", "accounts": 1, "addresses": 1 }
  ]
}
```

- A deposit counts once it is booked on Telos, a withdrawal once it is burned,
  except one that was rolled back (`expired`, `refunded`): that never left.
  Both are dated by when they started (`src_time`), days in UTC.
- `accounts` are distinct Telos accounts; `addresses` distinct far-side ones —
  an Ethereum address, a WAX account. `people.all` counts each once across
  every asset and both directions, so it is not the sum of the rows.
- `amount` is canonical units, like a transfer's; amounts are never added
  across tokens.
- `perDay` is the window's amount over its days; for `all`, the days since the
  first crossing. `peakDay` is the busiest UTC day inside the window.
- `daily` has a row per day, direction and asset that saw a crossing, oldest
  first. A quiet day has no rows.

`/v1/volume` counts rows, so a hop counts twice: once arriving on Telos and
once leaving it. For a public page, use `/v1/activity`.

### `GET /v1/activity`

```
?limit= &cursor= &chain= &asset= &state= &party=
```

Every transfer, newest first, as the person who sent it sees it: **one item
per transfer**. A hop (Ethereum → Telos → WAX) is one item keyed by its
deposit, the same key `/v1/hops/<key>` takes; a direct crossing is one item
keyed by its row, as in `/v1/transfers/<key>`. A hop's legs and the withdrawal
that sends a refused deposit back are never items of their own.

- `limit` 1–100, default 25. `cursor` is the previous page's, opaque; `null`
  when there is no more.
- `chain` matches either end (`wax`, `telos`, `mainnet`, `bsc`, `polygon`).
  Telos in the middle of a hop is not an end.
- `asset` a symbol, `USDC`. `state` one of the four below.
- `party` the start of an EVM address or an Antelope account, as the sender
  or the recipient; case does not matter. `4uba` finds `4ubaw.wam`, `0xd2da`
  finds every address beginning so; a whole name is its own prefix.

```json
{ "items": [
  { "key": "d:1181148696416462999:28", "kind": "hop",
    "from": { "chain": "wax", "address": "zr1ko.c.wam" },
    "to":   { "chain": "mainnet", "recipient": "0xee06…20d2" },
    "asset": { "symbol": "ETH", "precision": 8 }, "amount": "0.00206223",
    "state": "action_needed", "waitingOn": "user",
    "stage": "Ready to claim on Ethereum",
    "percent": 50, "exact": true, "etaAt": null,
    "startedAt": 1791210219, "finishedAt": null,
    "srcTx": "a8ae…b191", "dstTx": null } ],
  "cursor": "MTc5MTIxMDIxOXxk…" }
```

| `state` | meaning |
|---|---|
| `delivered` | at the recipient: `credited`, `forwarded`, `released`; a hop `delivered` |
| `action_needed` | the next step is the user's (`waitingOn: "user"`): a withdrawal to release on an EVM chain |
| `returned` | not delivered, sent back: `bounced`, `expired`, `refunded`; a hop `bounced` or `returned` |
| `in_progress` | everything else, the bridge's move — a hop `returning` included |

- `stage` says what is happening now, a sentence to show ("7 of 12
  confirmations on Ethereum"); `percent` is 0–100 for a bar; `exact` is true
  when counted from the chain (confirmations) and false when estimated from
  measured timings (finality, producers confirming) — an estimate moves in
  steps of five. `etaAt` is the unix second the bridge's own part should be
  done: count down to it; in the past means running late, "any moment"; null
  when finished or waiting on the user.
- `amount` is a decimal string in `asset.precision`, never a float. `asset`
  and `amount` are `null` for a token this build has no listing for.
- `from.address` is who sent it: an EVM address or an account. For a
  withdrawal from Telos it is the Telos account.
- `finishedAt`/`dstTx`: when and in which transaction it was paid out where it
  ended. For a `returned` one, the transaction that gave it back where known:
  a refunded withdrawal has `dstTx` (the refund) and no `finishedAt`, which is
  not recorded.
- `to` of a hop the bridge refused before it opened can be `null` both ways,
  when its memo did not name a destination.
- A deposit `forwarded` to a contract (the account factory `ac`, the exchange
  `alcor`) is `delivered`, with that contract as `to.recipient`; the account
  `ac` creates is in the deposit's memo, which `/v1/transfers/<key>` shows.

Shared for 15 seconds (`cache-control: public, max-age=15`).

### `GET /v1/activity/<key>`

One transfer, as `/v1/activity` lists it, by **any** of its keys: a direct
crossing's key, a hop's deposit key or any of its legs' (`w:<id>`), the
withdrawal that sent a refused deposit back, a rollback's `v:<id>`. The item is
keyed by the transfer whichever key was asked — `/v1/activity/w:118` answers
`"key": "d:1:42"` for the hop that leg belongs to. Read now, not from the shared
feed. `404` with `NOT_FOUND` for a key the indexer has not seen (yet).

### `GET /v1/stream`

```
?key=<key> [&key=<key>…]     some transfers, by any of their keys (up to 50)
?party=<address or account>  every transfer with any of them at either end, exactly, any case;
                             repeat for a person's wallets on several chains (up to 10)
(none)                       every transfer: the public feed
```

The transfers asked for, then each change to them as the bridge sees it, over
[server-sent events](https://developer.mozilla.org/docs/Web/API/Server-sent_events).
A page needs two handlers and keeps no bookkeeping of its own:

```js
const url = 'https://telos.alcor.exchange/api/bridge/v1/stream?party=' + encodeURIComponent(account);
const stream = new EventSource(url);

// The list as it stands. On opening, and whenever a replay would not be whole.
stream.addEventListener('snapshot', (e) => {
  const { transfers } = JSON.parse(e.data);
  setList(transfers);                       // replace
});

// One change. Put it in the list by its key; tell the user when it matters.
stream.addEventListener('transfer', (e) => {
  const { change, transfer, previous } = JSON.parse(e.data);
  upsert(transfer);                         // by transfer.key
  if (change !== 'progress') notify(change, transfer);
});
```

`transfer` is a transfer exactly as `/v1/activity/<key>` shows it. `change`
says what happened, in one word:

| `change` | |
|---|---|
| `new` | the bridge has just seen it — a deposit's log, a burn on Telos |
| `action_needed` | the next step became the user's: a release to sign on an EVM chain |
| `delivered` | at the recipient |
| `returned` | given back, or on its way back |
| `progress` | anything else: a confirmation, a stage, a transaction, back in the bridge's hands |

`previous` is `{ state, stage }` as it was, null for `new`. A write that changes
nothing a person sees — the indexer reading a chain again — sends nothing.

**Drops are the server's problem.** Every message has an `id`. `EventSource`
reconnects by itself and sends the last one it had (`Last-Event-ID`); the events
since are sent again, in order, and the page never notices. Away longer than
events are kept (30 days) or for more than 500 of them, a fresh `snapshot`
comes instead — the same handler. A client reconnecting by hand passes
`?after=<id>`.

- A `key` not seen yet (a deposit just sent) is told as `new` when it is. Any
  key of a transfer works: a hop's leg, the `v:` of a rollback.
- A snapshot of parties or of everything holds the newest 50.
- A comment line (`: ping`) every 20 seconds keeps proxies from closing it.
- Nothing here is faster than the indexer: a deposit appears when its chain is
  scanned, as on a poll. What goes away is the poll's own delay.
- Up to 10 streams from one address; more is `429` with `RATE_LIMITED`.
- Progress that moves with the clock is sent too: each confirmation ("7 of
  12" → "8 of 12"), each five-percent step of an estimate, a hold lifting —
  as `progress`, at most one every few seconds per transfer. A later `etaAt`
  alone is not a change. The bar and the countdown need nothing else.

### `GET /v1/events`

```
?key= &party= &change= &after= &limit=     (limit 1–100, default 10)
```

The same events, listed, oldest first: without `after` the newest `limit` (a
notification panel), with it the ones after (polling instead of streaming —
pass back `last` each time). `change` is repeatable: only those — a bell asks
for `new`, `action_needed`, `delivered`, `returned` and leaves out the
`progress` ticks. Kept 30 days.

```json
{ "events": [
  { "id": 4182, "at": 1791210300, "change": "delivered",
    "transfer": { "key": "d:1:42", "kind": "hop", "state": "delivered", "stage": "delivered on WAX", … },
    "previous": { "state": "in_progress", "stage": "on its way to WAX" } } ],
  "last": 4182 }
```

### `GET /v1/activity/summary`

```
?period=24h|7d|30d|all     (default all)
```

The same transfers as `/v1/activity`, counted and summed. A hop counts once.

```json
{ "period": "all", "since": null,
  "transfers": 103, "wallets": 18,
  "byState": { "in_progress": 0, "action_needed": 1, "delivered": 102, "returned": 0 },
  "duration": { "median": 120, "p90": 279 },
  "assets": [ { "symbol": "USDT", "precision": 6, "transfers": 15,
                "toAntelope": "53425.906", "fromAntelope": "791.502943", "net": "52634.403057" } ],
  "routes": [ { "from": "mainnet", "to": "wax", "transfers": 32,
                "duration": { "median": 259, "p90": 279 },
                "amounts": [ { "symbol": "USDT", "amount": "53425.906" } ] } ],
  "daily": [ { "day": "2026-10-07", "transfers": 17,
               "amounts": [ { "symbol": "BNB", "amount": "0.71305868" } ] } ] }
```

- `since` is the window's start, `null` for `all`. A transfer belongs to the
  window it started in.
- `wallets` distinct senders (`from.address`).
- `duration` seconds from start to payout, `delivered` only, nearest-rank
  median and 90th percentile; `null` when nothing was delivered in the window.
- Sums are per symbol, decimal strings, never added across symbols. No USD:
  price them yourself. A `returned` transfer counts in `transfers` and adds
  nothing to any sum — the money went back.
- `toAntelope` came from an EVM chain into Telos or WAX; `fromAntelope` went
  the other way; `net` is the difference. A transfer between two Antelope
  chains (Telos → WAX) or two EVM chains moves neither, and counts only in
  `transfers`.
- `routes` by the two ends, Telos in the middle of a hop left out, busiest
  first. `daily` has every UTC day of the window, empty ones included, oldest
  first; for `all`, from the first transfer.

Shared for 30 seconds.

### `GET /v1/reserves`

What is bridged now, read from the chains: the wrapped supply on Telos beside
what backs it on each chain. Unlike `net`, which adds up flows, these are
balances.

```json
{ "asOf": 1791413000,
  "assets": [
    { "symbol": "ETH", "precision": 8,
      "issued": "0.39656382",
      "locked": [ { "chain": "mainnet", "amount": "0.39862605", "read": "vault" } ],
      "lockedTotal": "0.39862605",
      "mirrored": [ { "chain": "wax", "amount": "0.39636382" } ] } ] }
```

- `issued` the `wrap.alcor` supply on Telos; `null` if it could not be read.
- `locked` lists every chain with a backing route for the asset, read or not:
  - `read: "vault"` — the vault's own balance, read on its chain;
  - `read: "ledger"` — Telos's record of it; only WAX, whose vault is not read
    here;
  - `read: "failed"` — the vault did not answer: `amount` is `null` and `error`
    says why. Unknown, not zero.
- `lockedTotal` is the sum of `locked`, and `null` while any entry is
  `failed`, so a partial sum is never taken for the whole. When present it is
  above `issued` by what is in flight: a withdrawal burned on Telos and not yet
  released still sits in its vault.
- `mirrored` is the part of `issued` out on WAX as a mirror token — inside
  `issued`, not on top of it.

```json
{ "symbol": "USDC", "precision": 6, "issued": "6065.930894",
  "locked": [ { "chain": "mainnet", "amount": null, "read": "failed", "error": "fetch failed" },
              { "chain": "bsc", "amount": "119.5", "read": "vault" },
              { "chain": "polygon", "amount": "351.089", "read": "vault" } ],
  "lockedTotal": null, "mirrored": [ … ] }
```

Shared for a minute when everything was read; a few seconds, and not
cacheable over HTTP, when something was not.

### `GET /v1/proofs/<key>`

Arguments ready to send. `404` while nothing is stored yet, with the transfer's
status in the body so you can say *why*.

For a withdrawal to Sui the body has a `sui` object instead of `hard`/`light`:

```json
{
  "chain": "sui",
  "sui": {
    "package": "0x…", "telosClient": "0x…", "vault": "0x…", "coinType": "0x…::sui::SUI",
    "signingGeneration": 197, "seatedGeneration": 197, "catchUp": null,
    "calls": {
      "submitRoot": { "target": "0x…::telos_client::submit_root_entry", "typeArguments": [], "arguments": [{ "object": "0x…" }, { "type": "u32", "value": 1 }, …] },
      "release":    { "target": "0x…::vault::release_entry", "typeArguments": ["0x…::sui::SUI"], "arguments": [{ "object": "0x…" }, …, { "object": "0x6" }] },
      "expire":     { "target": "0x…::vault::expire_entry", "typeArguments": [], "arguments": […] }
    }
  }
}
```

Each argument is `{ "object": id }` (pass it as an object) or
`{ "type": "u32" | "u64" | "vector<u8>" | "vector<bool>" | "vector<vector<u8>>", "value": … }`
(a pure value of that Move type; byte vectors are `0x` hex). Put `submitRoot`
and `release` (or `expire` past `deadline`) in one programmable transaction.

When `catchUp` is set, the Sui client seats an older finalizer policy than the
one that signed: walk `/v1/handovers?after=<seatedGeneration>` first.

For a withdrawal to NEAR the body has a `near` object: the function calls the
wallet sends to the vault, in order.

```json
{
  "chain": "near",
  "near": {
    "network": "mainnet",
    "vault": "alcor-bridge.near",
    "token": "NEAR",
    "recipient": "alice.near",
    "recipientAddress": "<sha256 of the recipient's account id, hex>",
    "signingGeneration": 197, "seatedGeneration": 197, "catchUp": null,
    "unknownSigners": [],
    "rootTrusted": false,
    "action": "release",
    "calls": [
      { "contract": "alcor-bridge.near", "method": "register_key", "args": { "key": "<base64>", "pop": "<base64>" },
        "deposit": "10000000000000000000000", "gas": "100000000000000" },
      { "contract": "alcor-bridge.near", "method": "submit_root", "args": { "finality": { … }, "bits": "…", "signature": "…", "policy_keys": […],
        "pending_policy": null, "pending_bits": null, "pending_signature": null }, "deposit": "…", "gas": "…" },
      { "contract": "alcor-bridge.near", "method": "release", "args": { "proof": { … }, "token": "NEAR", "recipient": "alice.near" },
        "deposit": "…", "gas": "…" }
    ]
  }
}
```

- Each call is a `FunctionCall` as near-api-js and the wallet selector take it:
  `args` JSON (byte strings base64), `deposit` in yoctoNEAR (0.01 NEAR: the
  storage the call adds, the rest refunded), `gas` in gas units (100 Tgas, the
  unused part refunded; the sender must hold it at the top gas price first,
  ~0.1 NEAR). Send them in this order, as separate transactions.
- `register_key` comes once per signer key the vault's client does not know
  yet, with its proof of possession from Telos's `regfinkey` history; anyone
  may send it. `submit_root` is left out when the root is already trusted.
- The last call is `release` before `deadline`, `expire` after it (`action`).
- `recipient` is filled when the vault's own logs named that account (it
  deposited, it was a refund address, it was paid before). Otherwise it is
  `null`: the wallet puts in its own account id, whose sha256 must equal
  `recipientAddress` — the vault checks.
- When `catchUp` is set the client seats an older finalizer policy than the one
  that signed: walk `/v1/handovers?after=<seatedGeneration>` (`nearCalls`)
  first. `unknownSigners` lists signer key ids no history holds; the walk
  teaches those.

### `GET /v1/handovers?after=<generation>[&limit=50]`

Telos's finalizer-policy handovers, oldest first, as the indexer stored them
when they happened: `{ generation, block, carrierBlock, previousGeneration,
submitRoot }`. A light client that lags walks them in order: the root of each
(`submitRoot`), then its policy (`submitRoot.pending.policy`). A generation
whose handover could not be built is missing; the walk goes on with the next.

On an instance with Sui each also has `suiCalls`: the two Move calls
(`submit_root_entry`, `install_policy`) in the same shape as above. Anyone may
send them; the first withdrawal after a quiet spell usually does.

On an instance with NEAR each also has `nearCalls`: `submit_root` and
`install_policy` (`{"packed": "<base64 policy>"}`) on the vault, in the call
shape of `/v1/proofs` above.

---

### Deposit addresses and fees: the courier

Served by the courier, beside the indexer under the same base URL (and at
`/api/courier/…` as before). Same error shape; the courier adds `RATE_LIMITED`
for too many new addresses from one client.

| | |
|---|---|
| `POST /v1/deposit-addresses` | `{ "chain": "telos" \| "<chain id>", "to": "<recipient>" }` → the address on every EVM chain that forwards what arrives to that destination. The same request always answers the same. |
| `GET /v1/deposit-addresses/<0x…>` | its destination, holds per chain, and its last forwards |
| `GET /v1/fees` | what a forward and a delivered withdrawal cost now, per chain and token |

- `POST` answers `address` (lowercase), `destination`, `telosTo`, `leg`,
  `factory`, `feeCap` (`"1%"`) and `chains[]`: the networks the address works on
  (Ethereum, BSC, Polygon), each with `tokens[]` — `symbol`, `token`,
  `decimals`, and `min`/`max` in raw units **for this destination** (`max` null
  when unlimited). `INVALID_REQUEST` where the deposit would only come back (no
  such account, the bridge's own account, the zero address, a recipient that
  does not fit the chain); `RATE_LIMITED` past 20 new addresses an hour per
  client or 2000 a day in all — an address registered before always answers.
- **Compute the address yourself and refuse one that differs.** It is
  `CREATE2(factory, keccak256(abi.encode(uint64 telosTo, string leg)),
  keccak256(EIP-1167 clone of the factory's first contract, CREATE(factory, 1)))`,
  the factory `0x6bc5481445aaed9e37db72fdbd989b857a15c362` on all three chains.
  `telosTo` is the Telos account as a name's uint64 — the recipient's own to
  stay on Telos (`leg` empty), `hop.alcor` to go on, with `leg`
  `<domain>:<recipient>` (an EVM or Sui address lowercase, a NEAR id as `0x` +
  sha256 of it, an Antelope name as is). `telos:alice` is
  `0x242333bB7361fA6C9B716951a415341e9f45D7F8`, `wax:alice`
  `0xA1AD9334E53e7136B3962cdcECf7Ef2c82F86a29`.
- `GET /v1/deposit-addresses/<address>`: the destination, `held` (a token that
  came back from the destination waits there; keys `<chainId>:<address>:<token>`)
  and the last 20 `forwards`. Follow what was forwarded on `/v1/stream?party=<the address>`.
- `GET /v1/fees`: per network and token, `deposit` (a forward's gas, raw units,
  before the 1% cap), `forwardsFrom` (the least forwarded now; less waits at the
  address) and `withdrawal` (the fee for a delivered withdrawal, canonical
  units: the `<fee>` in `<chainId>:<address>:<fee>`).
- An address with an EVM destination never carries a delivery fee: the
  recipient releases what it delivers there.

## Sending the transaction

### A withdrawal, on Ethereum

```json
{
  "key": "w:1", "track": "hard", "burnBlock": 488926666,
  "vault": "0x1ece552b3a7aef5fc60259db5300638171b8057b",
  "hard": {
    "gas": "~2.4M + 176k",
    "submitRootTo": "0x4bf3bc3817654ef9fb83984b2ad1ccb21e067159",
    "releaseTo":    "0x1ece552b3a7aef5fc60259db5300638171b8057b",
    "submitRoot": { "finality": { … }, "bits": "0x…", "signature": "0x…",
                    "policyKeys": ["0x…"],
                    "pending": { "policy": "0x", "bits": "0x", "signature": "0x" } },
    "release": { "id": "1", "domain": "1", "token": "0x…", … }
  },
  "lightUnavailable": "leaves for block 488926666 are outside the retained window"
}
```

When `track` is `light` there is a `light` object instead, holding `releaseTo`
and a `release` — its root is already trusted, so there is nothing to submit
first.

Both contract addresses travel with the proof. Do not hardcode them: they have
been redeployed once already, and the indexer reads which pair is live from the
vault itself.

`vault` is the vault the withdrawal was burned for. It is signed into `wdlog`,
and `AlcorWithdrawals` rebuilds the digest with its own vault, so only that
vault's releaser accepts the proof. It is not a field of `release`. When it is
not the chain's current vault, the response carries a `warning` saying so; when
the withdrawal names a chain this build does not know at all, `chain` is null
and the `warning` says that instead.

The field order of these objects is the Solidity struct order, so they can be
passed straight through:

```ts
// track === 'light'  →  one transaction
await writeContract({ address: p.light.releaseTo, abi: withdrawalsAbi,
                      functionName: 'release', args: [p.light.release] })

// track === 'hard'   →  also one: the root is submitted inside it, if needed
const s = p.hard.submitRoot
await writeContract({ address: p.hard.releaseTo, abi: withdrawalsAbi,
                      functionName: 'submitAndRelease',
                      args: [s.finality, s.bits, s.signature, s.policyKeys, s.pending, p.hard.release] })
```

`pending` is the second half of the certificate when the root comes from a
finalizer-policy transition block, and three empty `0x` values otherwise. Pass it
through either way: the contract refuses a transition root without it, and any
other root with it.

One transaction on both tracks. Sending `submitRoot` and `release` separately
still works, but the second one then races the node: a load-balanced RPC can
answer the `release` simulation from a node that has not seen the root yet, and
it reverts with `UntrustedRoot`.

Past the deadline the call is `expire` instead of `release` — same argument, same
struct. `/v1/pending` says which in `action`; the proof body is identical.

### Starting a withdrawal, on Telos

Two ways in, one withdrawal out of both:

```
wrap.alcor::transfer    from, "bridge.alcor", "1.000000 USDT",
                        "<chainId>:<address>[:<fee>[:<memo>]]"

wrap.alcor::withdraw    owner, "1.000000 USDT", <chainId>, "<address hex>",
                        "0.010000 USDT", "<memo hex>"
```

The transfer is what any wallet or exchange can send; its fee is a number of
canonical units in text, and everything after a third colon is the memo for the
far side — within the 256 bytes a transfer memo has. It is the only way a
withdrawal to a spoke (a mirror on WAX) carries one. `withdraw` burns the
owner's tokens and hands the bridge the same fields plus a **memo of up to 1024
bytes**, arbitrary data for whoever receives on the far side; a spoke refuses it.

**`fee`** is part of the amount and paid to whoever sends `release`; the
recipient gets `amount − fee`. Zero, the default, means the recipient delivers
it themselves.

The amount may not exceed the route's `max_withdrawal` (the `routes` table): the
vault lets only so much out per day, and a larger withdrawal could never be
paid. The zero address is refused as a recipient.

**`memo`** is signed into `wdlog` with the amount and the recipient, so it is
proved on the far side like they are: `release` takes it in the proof and
`AlcorWithdrawals` emits it in `Released(id, token, to, amount, memo)`. Empty
for a transfer.

A withdrawal whose owner is the bridge itself is a deposit sent back
(`bounce`). It has no fee, and its memo is `refund:<chainId>:<nonce>`, naming
the deposit — so a contract that deposited on someone's behalf can tell whose
tokens came back.

### A deposit or a refund, on Telos

Two proofs exist for a deposit and the response carries whichever apply. They
claim different things: the fast one says the committee saw the block and `K`
blocks were built on top — checked on chain, not asserted — while the finalized
one says the chain can no longer abandon it.

```json
{
  "key": "d:1:6", "kind": "deposit", "pushOn": "telos",
  "track": "fast",
  "fast": {
    "note": "40 confirmations proved, 12 required — credited now instead of waiting for finality",
    "confirmations": 40, "required": 12, "signedBy": "476/512",
    "actions": [
      { "account": "eth.lc.alcor", "name": "proveroot", "data": [ … ] },
      { "account": "eth.g.alcor",  "name": "credit",    "data": [ … ] }
    ]
  },
  "finalized": {
    "note": "the chain can no longer abandon this block; never goes stale",
    "signedBy": "479/512", "ancestryHeaders": 68,
    "actions": [ … same two, same shape … ]
  }
}
```

Take `fast` when it is there — it is the same two actions, ten minutes earlier.
`finalized` is the one the indexer stores; `fast` is built at the moment you ask,
because an optimistic proof bakes in its depth and a stored one would be
worthless the moment a route raises `min_confirmations`.

Before anything is frozen the response has `fast` and a `finalizedPending`
string instead of `finalized`. That window is the whole point of the fast path,
so it answers `200` there rather than `404`.

When the fast path is not on offer, `fastUnavailable` says why in a sentence
worth showing: `"8 of 12 confirmations; about 48 s more"`, or
`"this route accepts finalized proofs only"`.

`data` is a positional array in the action's own argument order — hand it to
wharfkit as-is. Send both actions in **one** transaction: state applies in order
inside a transaction, so the expensive half is still paid once per block and the
user clicks once.

For a rollback (`v:<id>`) the second action is `voided` instead of `credit`, and
it triggers the refund inline. That one is finalized-only: a refund reverses a
burn, and an unfinalized proof of a rollback is not worth the class of bug it
invites.

The first action is large — around 50 KB, most of it the 512 committee keys.
That is expected and fits Telos's 600 KB transaction limit with room to spare.

---

## New tokens

Nothing is compiled in. The indexer reads the routes and assets the bridge
contract lists, holds them for a minute, and matches deposits against them by
`(domain, token address)` — native ETH included, where the address is twenty
zero bytes. A listing added while it runs shows up within that minute: no
restart, no redeploy, no configuration.

What a new asset needs is on chain and not here: `setAsset` on the vault,
`addasset` and `addroute` on the settlement chain. Once those land, deposits of
it appear in `/v1/transfers` and become creditable on the same paths as any
other.

Two things about a listing cannot be undone afterwards, so they are decided
before the first one rather than discovered at the second:

**Precision binds every chain that will ever back the asset.** One symbol can
have a route per source chain — USDC from Ethereum, Arbitrum and BSC is one
fungible USDC here — but `scale` is raw units per canonical unit and a positive
integer, so precision must be at most the decimals everywhere. USDC is 6, 6 and
18 on those three, which makes 6 the only workable precision.

**One route per asset per chain**, enforced in `addroute`. A withdrawal memo is
`<domain>:0x<address>` and names no token, so two routes for one asset on one
chain would make "USDC on Arbitrum" mean whichever was registered first. USDC
and USDC.e that must both exist are two assets.

## Polling

A page following its own transfers is better off on `/v1/stream`: one request,
told each change, caught up after a drop. Otherwise `/v1/pending` and `/v1/transfers` every 10–15 seconds is plenty: Telos blocks
are half a second but a crossing changes state on the order of minutes. Nothing
there is cached, so a tighter loop only costs you requests. The public
aggregates are: `/v1/activity` for 15 seconds, its summary for 30,
`/v1/reserves` for 60 (a few seconds when a vault was not read).

After sending a transaction, the state does not change instantly — the indexer
sees it when the block carrying it is scanned. Show the transaction hash you
already have and let the next poll move the row.

## Errors

| | |
|---|---|
| `400` | a parameter out of range: `limit`, `state`, `period`, a `cursor` this API did not hand out |
| `404` | unknown route, unknown transfer, or no proof available yet — for a deposit that means the fast path is not on offer *and* nothing is frozen, and `fastUnavailable` says why |
| `405` | anything but `GET` (and `OPTIONS`, a browser's preflight) on the indexer's paths |
| `429` | too many streams from one address |
| `500` | something the indexer could not do; `error` says what |
| `502` | a chain or service the answer needed did not answer (a plan, a quote) |

All carry `{"error": "…", "code": "…"}`: `error` written to be shown to a
person, which may change, and `code` for a program to branch on, which only
gains values:

| `code` | |
|---|---|
| `INVALID_REQUEST` | a parameter out of range or malformed; a plan or quote refused as asked |
| `NOT_FOUND` | no such route, transfer, deposit or block |
| `PROOF_NOT_READY` | the transfer exists, its proof does not yet — usually "not yet", with its `status` |
| `METHOD_NOT_ALLOWED` | not `GET` |
| `RATE_LIMITED` | too many at once from one address |
| `UPSTREAM_ERROR` | a chain or service did not answer; worth retrying |
| `INTERNAL_ERROR` | something this instance could not do |

A `404` on a proof is not a failure state — it is usually "not yet". Use the
transfer's `status` and `flags` to say which.
