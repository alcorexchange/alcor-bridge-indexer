# Alcor Bridge: integration guide for a trading bot

How to move assets between **WAX**, **Ethereum**, **BSC** and **Telos** through
the Alcor bridge from your own code: what to send on each chain, in which
format, how to follow a transfer, and what can go wrong.

This file is meant to be handed to a developer or to an AI assistant as
complete context. Everything here is public: contract names, the public API and
on-chain actions. No keys or operator infrastructure are involved. You sign
everything with **your own** accounts.

> This file is served at `https://telos.alcor.exchange/api/bridge/docs/bot`.
> The full endpoint reference, served by the API itself (always matches
> production): `https://telos.alcor.exchange/api/bridge/docs`

---

## 1. The model in one minute

- **Telos is the hub.** Every route runs between Telos and one other chain.
  WAX ↔ Ethereum is two crossings: WAX → Telos, then Telos → Ethereum. A hop
  contract on Telos (`hop.alcor`) chains them for you, so from your side it is
  **one transaction on the source chain**.
- **Ethereum / BSC are "backing" chains.** Assets lock in a vault contract
  there, and a canonical token is minted on Telos.
- **WAX holds two kinds of route.**
  - `WAX` (the native coin) is a backing route: WAX locks in the WAX vault and
    is minted on Telos.
  - `USDC`, `USDT`, `ETH` and `BNB` on WAX are **mirrors** (spokes). Telos
    keeps the canonical tokens locked, and the WAX vault mints a mirror token
    on `wrap.alcor` (WAX). Sending a mirror back burns it on WAX and unlocks it
    on Telos.
- **No trusted relayer is needed for correctness.** Every step is a proof that
  a contract checks. The operator runs relayers for the Antelope legs (WAX and
  Telos) so those finish automatically. **Ethereum and BSC payouts are not
  relayed: whoever receives sends the final `release` transaction and pays the
  gas.** For a bot that is your own EVM wallet.

```
            Ethereum (1)          BSC (56)
             AlcorVault           AlcorVault
                 │                    │
                 └─────────┬──────────┘
                           │  proofs
                     ┌─────▼─────┐
                     │   TELOS   │  bridge.alcor (ledger)
                     │    hub    │  wrap.alcor   (canonical tokens)
                     │           │  hop.alcor    (chains two crossings)
                     └─────┬─────┘
                           │  proofs (relayed automatically)
                     ┌─────▼─────┐
                     │    WAX    │  bridge.alcor (vault)
                     │           │  wrap.alcor   (mirrors USDC/USDT/ETH/BNB)
                     └───────────┘
```

---

## 2. Addresses and constants

### Domains (chain ids as the bridge spells them in memos)

| chain | domain | address format |
|---|---|---|
| Ethereum mainnet | `1` | `0x` + 40 hex |
| BSC mainnet | `56` | `0x` + 40 hex |
| WAX | `1181148696416462999` | Antelope account name, `^[a-z1-5.]{1,12}$` |

The WAX domain is the first 8 bytes of the WAX chain id read as a number. It is
larger than a JS `number` can hold exactly, so **keep it as a string**.

### Telos (the hub)

| account | role |
|---|---|
| `bridge.alcor` | the ledger: withdrawals start here, claims are collected here |
| `wrap.alcor` | canonical tokens on Telos: `ETH` (8), `USDC` (6), `USDT` (6), `WAX` (8), `BNB` (8) |
| `hop.alcor` | hop contract: WAX ↔ Ethereum / BSC in one go |

### WAX

| account | role |
|---|---|
| `bridge.alcor` | the WAX vault: send tokens here to bridge out of WAX |
| `eosio.token` | native `WAX` (8 decimals) |
| `wrap.alcor` | mirror tokens: `USDC` (6), `USDT` (6), `ETH` (8), `BNB` (8) |

Note that `bridge.alcor` and `wrap.alcor` exist on **both** Telos and WAX.
Those are different accounts on different chains.

### Ethereum mainnet (chain id 1)

| contract | address |
|---|---|
| AlcorVault (deposit here) | `0x3e447d533321ad6a8412f97034ac295a9ff8d858` |
| AlcorWithdrawals (release here) | `0x04fb700b93eb68cadd88d8e8d4dfe4857d5cb3c6` |
| USDC | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| USDT | `0xdac17f958d2ee523a2206206994597c13d831ec7` |
| native ETH | `0x0000000000000000000000000000000000000000` (use `depositNative`) |

### BSC mainnet (chain id 56)

| contract | address |
|---|---|
| AlcorVault | `0x53f18eaa8bf8099b5ba21bb7e11ed311b677690e` |
| AlcorWithdrawals | `0x6132b4d02e02f1b378f0fc67c3d4f553eb76acb5` |
| native BNB | `0x0000000000000000000000000000000000000000` (use `depositNative`) |

**Don't hardcode the withdrawal contract in the release path.** Every proof
from the API carries the contract address to send it to (`releaseTo`). Use
that address. The table above is for orientation and for deposits.

### Public endpoints

- Bridge API: `https://telos.alcor.exchange/api/bridge`
- Telos RPC: any public Telos API, e.g. `https://mainnet.telos.net`
- WAX RPC: any public WAX API
- Ethereum / BSC RPC: your own provider

---

## 3. Units: read this before computing any amount

The bridge counts in **canonical units**: an integer, with the token's
**precision** on Telos and WAX.

| asset | precision | 1.0 token in canonical units | EVM decimals | `scale` (raw per canonical) |
|---|---|---|---|---|
| ETH | 8 | `100000000` | 18 | `1e10` |
| BNB | 8 | `100000000` | 18 | `1e10` |
| USDC | 6 | `1000000` | 6 | `1` |
| USDT | 6 | `1000000` | 6 | `1` |
| WAX | 8 | `100000000` | (n/a) | `1` |

- API amounts (`amount`, `min`, `max`, `withdrawableNow`, ...) are canonical
  units as **decimal strings**. Parse them with `BigInt`, never `Number`.
- On EVM the vault **rounds a deposit down** to a whole canonical unit. For
  ETH, anything below `1e10` wei is not taken (native: refunded in the same tx).
- Antelope quantities are strings with exact precision:
  `"12.345678 USDC"`, `"0.10000000 ETH"`, `"100.00000000 WAX"`. Wrong
  precision means the action fails with `symbol precision mismatch`.

---

## 4. Always read live limits first

Routes, minimums, maximums and open/closed status change. **Query them before
every transfer.** Don't hardcode them.

### `GET /v1/routes`

Every asset and every chain pair, including hops. Filter with
`?symbol=USDC&from=wax&to=mainnet`. Chain ids in this endpoint: `mainnet`,
`bsc`, `wax`, `telos-production`.

```json
{ "symbol": "USDC", "precision": 6,
  "from": "wax", "to": "mainnet", "via": "telos-production",
  "open": true, "min": "5000000", "max": "2228799580",
  "how": { "transfer": { "contract": "wrap.alcor",
           "memo": "hop.alcor:1:0x<address>|1181148696416462999:<your account>" } } }
```

- `open: false` comes with a `reason`. Don't send.
- `min` and `max` are canonical units. `max` is `null` when nothing bounds it.
  On a hop they are the tightest of everything the contracts check.
- `how` is the exact template: what to call on the source chain, and with
  which memo.

### `GET /v1/chains`

Detail per chain: `active.deposits` / `active.withdrawals`, `timing`, and per
route `minDeposit`, `maxWithdrawal`, `withdrawableNow`, `depositableNow`,
`fastMax`.

The two figures that matter most for sizing:

- **`withdrawableNow`** (Telos → that chain): the most that can burn now **and**
  be paid out today. On Ethereum it includes the vault's **daily outflow
  limit**.
- **`depositableNow`** (that chain → Telos): the most one deposit can add. On a
  WAX mirror it is the mirror amount currently out ("no more can come home than
  went out"). For example, `WAX → BSC (BNB)` is closed until somebody has
  bridged BNB to WAX.

---

## 5. Flows

Every flow below uses the same three steps. **(1)** Check the route. **(2)** Send
one transaction on the source chain. **(3)** Track it through the API, and send
`release` yourself if the destination is Ethereum or BSC.

### 5.1 WAX → Ethereum (or BSC), via hop

**On WAX**, send one transfer to the WAX vault:

```
contract:  wrap.alcor            (USDC / USDT / ETH / BNB mirrors; native WAX has no hop
                                  to Ethereum or BSC, see /v1/routes)
action:    transfer
data:      from     = <your wax account>
           to       = "bridge.alcor"
           quantity = "100.000000 USDC"
           memo     = "hop.alcor:1:0x<your eth address>|1181148696416462999:<your wax account>"
```

How the memo reads:

```
hop.alcor : 1 : 0xabc…            | 1181148696416462999 : mywaxacc
└─Telos──┘ └─where it goes─────┘   └─where it comes back to if it fails─┘
beneficiary  (domain:recipient)       (domain:recipient)
```

- For BSC use domain `56`: `hop.alcor:56:0x…|1181148696416462999:<wax account>`.
- No spaces. No fee field. A third `:` in a leg is refused.

**What happens next:**

1. **WAX → Telos.** About 50 s. The operator's relayer proves the deposit on
   Telos. The key is `d:1181148696416462999:<nonce>`, where `nonce` is in the
   vault's inline `deplog` action in your WAX transaction trace.
2. **Telos.** The deposit is parked (it has a memo), then forwarded to
   `hop.alcor`. The hop immediately opens a withdrawal to Ethereum, key
   `w:<id>`, with fee `0`.
3. **Telos → Ethereum.** The Telos finality certificate takes about 1–2 min.
   Then the proof is ready and **you send `release` on Ethereum from your own
   wallet** (section 6).

**Tracking:** `GET /v1/hops?party=<your wax account>` or
`GET /v1/hops/d:1181148696416462999:<nonce>`. `legs[0].key` is the `w:<id>`
you release. See section 7.

### 5.2 Ethereum (or BSC) → WAX, via hop

**On Ethereum**, call the vault. For ERC-20 tokens, `approve` first.

```solidity
// ERC-20 (USDC, USDT)
function deposit(
    address token,      // USDC / USDT address
    uint256 amount,     // raw token units (6 decimals for USDC/USDT)
    uint64  telosTo,    // Antelope name "hop.alcor" encoded as uint64 (see below)
    address refundTo,   // YOUR address: where it goes back if the hop is refused
    uint64  fillFee,    // 0
    uint64  filler,     // 0
    bytes   memo        // utf8 bytes of "1181148696416462999:<wax account>|1:<your eth address>"
) external;

// native ETH / BNB
function depositNative(
    uint64  telosTo,
    address refundTo,
    uint64  fillFee,    // 0
    uint64  filler,     // 0
    bytes   memo
) external payable;
```

- From BSC the memo's way back is `|56:<your address>`.
- `fillFee` and `filler` must be `0`. Early delivery by solvers is not enabled.
- **USDT quirk:** USDT's `approve` reverts when the current allowance is non-zero.
  Approve `0` first, then the amount.
- The `Deposit` event gives you `nonce`. The key is `d:1:<nonce>` (or
  `d:56:<nonce>`).
- **Check that the WAX account exists before you send.** The bridge can't see
  WAX accounts. If the account doesn't exist, the WAX payout is voided only at
  its deadline (7 days), and then the funds go back to `refundTo`.

**What happens next:**

1. **Ethereum → Telos.** Up to the route's `fastMax` (currently 1.85 ETH or
   5,000 USDC / USDT; read it from `/v1/chains`), the deposit is credited on a
   fast proof after 12 confirmations, about 2.5–3 min. Above `fastMax` it
   waits for Ethereum finality, about 13–20 min. BSC takes about 30 s either way.
2. **Telos.** Parked, then forwarded to `hop.alcor`, which withdraws to WAX.
3. **Telos → WAX.** About 1.5–2 min. The relayer pays on WAX: the mirror (or
   WAX) is minted or transferred straight to your WAX account. **Nothing for you
   to sign on WAX.**

Measured end to end: 1,000 USDC Ethereum → WAX took about 4.5 min.

#### Encoding `telosTo` (Antelope name → uint64)

```ts
import { Name } from '@wharfkit/antelope'
const telosTo = BigInt(Name.from('hop.alcor').value.toString())
```

Or without dependencies:

```ts
function nameToUint64(s: string): bigint {
  const ch = (c: string) =>
    c === '.' ? 0n : c >= 'a' && c <= 'z' ? BigInt(c.charCodeAt(0) - 97 + 6) : BigInt(c.charCodeAt(0) - 49 + 1)
  let v = 0n
  for (let i = 0; i < 12; i++) v = (v << 5n) | (i < s.length ? ch(s[i]) : 0n)
  v <<= 4n
  if (s.length === 13) v |= ch(s[12]) & 0x0fn
  return v
}
```

#### viem example (USDC Ethereum → WAX)

```ts
import { parseAbi, toHex, parseUnits } from 'viem'

const VAULT = '0x3e447d533321ad6a8412f97034ac295a9ff8d858'
const USDC  = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const vaultAbi = parseAbi([
  'function deposit(address token, uint256 amount, uint64 telosTo, address refundTo, uint64 fillFee, uint64 filler, bytes memo)',
  'function depositNative(uint64 telosTo, address refundTo, uint64 fillFee, uint64 filler, bytes memo) payable',
  'event Deposit(address indexed token, address indexed from, uint256 amount, uint64 canonical, uint64 telosTo, uint64 nonce, address refundTo, uint64 fillFee, uint64 filler, bytes memo)',
])
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const amount = parseUnits('1000', 6)
const memo = toHex(`1181148696416462999:${waxAccount}|1:${me}`)

await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [VAULT, amount] })
const hash = await wallet.writeContract({
  address: VAULT, abi: vaultAbi, functionName: 'deposit',
  args: [USDC, amount, nameToUint64('hop.alcor'), me, 0n, 0n, memo],
})
// read `nonce` from the Deposit log in the receipt → key `d:1:${nonce}`
```

### 5.3 WAX → Telos

**On WAX:** transfer to `bridge.alcor`, with the token's contract:

```
eosio.token::transfer  <you> → bridge.alcor  "100.00000000 WAX"  memo "<telos account>"
wrap.alcor::transfer   <you> → bridge.alcor  "50.000000 USDC"    memo "<telos account>"
```

Memo: `<telos account>` or `<telos account>:<note>`.

- **Without a note**, the deposit lands on the account's balance in the same
  transaction that credits it. Nothing to sign on Telos.
- **With a note**, or when the target is a contract, the deposit is parked and
  then forwarded: transferred to the account with the note as the transfer
  memo. Use a note when you want the tokens to arrive on their own, or when the
  target is a contract that reads memos (a DEX, for example).

About 50 s. Track it with `/v1/transfers?account=<telos account>`.

### 5.4 Telos → WAX

**On Telos:** transfer the canonical token to the ledger:

```
wrap.alcor::transfer  <you> → bridge.alcor  "50.000000 USDC"
                      memo "1181148696416462999:<wax account>"
```

About 1.5–2 min, paid on WAX by the relayer. No WAX transaction needed. The
withdrawal id is in the inline `wdlog` action of your Telos transaction (key
`w:<id>`). The WAX account must exist.

### 5.5 Ethereum / BSC ↔ Telos (direct)

- **In:** `deposit` / `depositNative` as in 5.2, with `telosTo` = your Telos
  account and an **empty memo** (`0x`). It lands on your Telos balance.
- **Out:** on Telos,
  `wrap.alcor::transfer <you> → bridge.alcor "1.000000 USDC" memo "1:0x<address>"`
  (`56:0x…` for BSC). An optional third field `:<fee>` (canonical units) pays a
  courier out of the amount. Nobody runs a courier for Ethereum, so leave it
  out and release it yourself (section 6).

### 5.6 Claiming on Telos

Deposits and refunds to a plain account arrive on their own. The ledger holds
tokens for its owner only in three cases: a refund to a contract, a solver's
`fill` balance, and deposits credited before 2026-10-14. Those are collected
with:

```
bridge.alcor::claim  { owner: "<you>", sym_code: "USDC" }   // authorization: <you>@active
```

To see what is waiting: `GET /v1/accounts/<telos account>` → `claimable`.

---

## 6. Releasing a withdrawal on Ethereum / BSC (you pay gas)

Any Telos → EVM withdrawal (direct, or the second leg of a WAX → ETH hop) ends
with a `release` transaction that you send.

1. Poll `GET /v1/transfers/w:<id>` until `hasProof: true` (about 1–2 min after
   the burn on Telos). Or use `GET /v1/pending?address=0x…&ready=true`.
2. `GET /v1/proofs/w:<id>` returns the arguments, already in Solidity struct
   order:
   - `track: "light"`: a root covering this burn is already trusted. Send
     `release(p.light.release)` to `p.light.releaseTo`. About 150–180k gas.
   - `track: "hard"`: send
     `submitAndRelease(s.finality, s.bits, s.signature, s.policyKeys, s.pending, p.hard.release)`
     to `p.hard.releaseTo`. About 2.4–2.6M gas. **Factor this into arbitrage
     margins on Ethereum.**
3. Past `deadline` (7 days after the burn), `release` is refused. Send the same
   body to `expire` / `submitAndExpire` instead, and the tokens are reissued on
   Telos. For a hop, they are then sent back to the way back on WAX.

`release` doesn't depend on who sends it. Anyone may deliver a proof. Funds
always go to the recipient fixed on Telos.

```ts
const withdrawalsAbi = parseAbi([
  'struct FinalityInputs { uint32 majorVersion; uint32 minorVersion; uint32 activeGeneration; uint32 lastPendingGeneration; bytes32 finalityMroot; bytes32 lastPendingPolicyDigest; uint32 lastPendingPolicyStart; bytes32 reversibleBlocksMroot; uint32 qcClaimBlockNum; bytes32 qcClaimFinalityDigest; uint32 qcClaimTimestamp; uint32 timestamp; bytes32 baseDigest; }',
  'struct PendingQc { bytes policy; bytes bits; bytes signature; }',
  'struct Proof { uint64 id; uint64 domain; address token; address recipient; uint64 amount; uint64 deadline; uint64 fee; bytes memo; uint64 recvSequence; bytes32 witness; bytes32[] actionSiblings; uint256 actionPath; bytes32 actionMroot; uint32 majorVersion; uint32 minorVersion; uint32 blockNum; uint32 timestamp; uint32 parentTimestamp; bytes32 finalityDigest; bytes32[] treeSiblings; uint256 treePath; bytes32 finalityMroot; }',
  'function release(Proof p)',
  'function submitAndRelease(FinalityInputs f, bytes bits, bytes signature, bytes32[] policyKeys, PendingQc pending, Proof p)',
  'function expire(Proof p)',
  'function submitAndExpire(FinalityInputs f, bytes bits, bytes signature, bytes32[] policyKeys, PendingQc pending, Proof p)',
])

const p = await (await fetch(`${API}/v1/proofs/w:${id}`)).json()
if (p.track === 'light') {
  await wallet.writeContract({ address: p.light.releaseTo, abi: withdrawalsAbi,
    functionName: 'release', args: [p.light.release] })
} else {
  const s = p.hard.submitRoot
  await wallet.writeContract({ address: p.hard.releaseTo, abi: withdrawalsAbi,
    functionName: 'submitAndRelease',
    args: [s.finality, s.bits, s.signature, s.policyKeys, s.pending, p.hard.release] })
}
```

Notes:

- Integers in the proof JSON may arrive as strings. Convert `uint64`/`uint256`
  fields with `BigInt(...)` if your library is strict.
- Always use the **single-transaction** `submitAndRelease`, not `submitRoot`
  followed by `release`. With two transactions, the second can be simulated on
  a lagging RPC node and revert with `UntrustedRoot`.
- **Ethereum's vault has a daily outflow limit per token.** If it is used up,
  `release` reverts (`OutflowLimited`) and **stays valid**. Retry later, before
  the deadline. Avoid this by sizing against `withdrawableNow` before you burn.
- If `release` reverts with `AlreadySettled`, someone already delivered it.
  Check that the recipient received the funds.

---

## 7. Tracking

### Keys

| key | meaning | where you get it |
|---|---|---|
| `d:1:<nonce>` | Ethereum deposit | `Deposit` event, `nonce` |
| `d:56:<nonce>` | BSC deposit | `Deposit` event |
| `d:1181148696416462999:<nonce>` | WAX deposit | inline `bridge.alcor::deplog` in your WAX tx trace, field `nonce` |
| `w:<id>` | withdrawal from Telos (to any chain) | inline `bridge.alcor::wdlog` on Telos, field `id`; for hops, `legs[].key` |

### Endpoints

| endpoint | use |
|---|---|
| `GET /v1/transfers/<key>` | one crossing: `status`, `flags`, `progress`, `hasProof`, `src_tx`/`dst_tx` |
| `GET /v1/transfers?account=&address=&status=&limit=` | list, newest first |
| `GET /v1/hops?party=<0x… or account>` | hop journeys for an address/account |
| `GET /v1/hops/<deposit key>` | one journey, with `status` and `legs` |
| `GET /v1/pending?address=0x…&ready=true` | everything waiting for you to sign |
| `GET /v1/proofs/<key>` | ready-to-send arguments (`404` = not ready yet) |
| `GET /v1/accounts/<telos account>` | `claimable` balances on Telos |

Poll every 10–15 s. A crossing changes state on the order of minutes.

### Statuses

```
deposit      seen ──▶ provable ──▶ credited                (on the Telos balance)
                               └─▶ parked ──▶ forwarded    (delivered with memo / to hop)
                                          └─▶ bounced      (sent back to refundTo)
withdrawal   burned ──▶ provable ──▶ released
                                 └─▶ expired ──▶ refunded
```

Hop journey `status`: `arriving` → `sending` → `delivered` is the happy path.
Failure paths are `bounced` (refused at the hop, sent back to source),
`returning` → `returned` (the far chain voided it, sent to the way back).

`progress.waitingOn` is `"bridge"`, `"user"` or `null`. **`"user"` on an
Ethereum/BSC leg means it is your turn to send `release`.**

### Suggested bot state machine (WAX → Ethereum)

```
SEND_WAX_TRANSFER
  → read deplog.nonce from the trace          key = d:1181148696416462999:<n>
POLL /v1/hops/<key>
  status == "arriving"        → wait
  status == "bounced"         → refunded on WAX, mark failed, alert
  status == "sending"         → wid = legs[0].key
POLL /v1/transfers/<wid>
  hasProof == false           → wait
  hasProof == true            → GET /v1/proofs/<wid> → release / submitAndRelease
  flags has "past-deadline"   → expire instead
CONFIRM  status == "released"  (or token balance on Ethereum)
```

---

## 8. Timing (measured on production)

| path | typical |
|---|---|
| WAX → Telos | ~50 s (40 s–2 min) |
| Telos → WAX | ~1.5–2 min |
| Ethereum → Telos, ≤ `fastMax` | ~2.5–3 min (12 confirmations) |
| Ethereum → Telos, > `fastMax` | ~13–20 min (finality) |
| Telos → Ethereum, proof ready | ~1–2 min, then **your** `release` |
| BSC → Telos / Telos → BSC | ~30 s each, plus your `release` on BSC |
| Ethereum → WAX (hop) | ~4–5 min below `fastMax` |
| WAX → Ethereum (hop) | ~2–3 min to a releasable proof, plus your `release` |

Live figures are in `/v1/chains` → `timing`. Each transfer also has
`progress.etaSeconds`.

---

## 9. Failure modes and how funds come back

Nothing gets stuck permanently. Funds return by rule, on a timer.

| what went wrong | what happens | your action |
|---|---|---|
| Hop refused: bad memo, closed route, amount out of bounds | Deposit stays parked; after **1 hour** it is sent back to the source chain: to `refundTo` on Ethereum/BSC, or to the sending account on WAX (relayed automatically) | If the return lands on Ethereum/BSC, `release` that withdrawal (it's a normal `w:<id>`, memo `refund:<chainId>:<nonce>`) |
| Destination WAX account doesn't exist / refuses | Withdrawal voided at deadline (**7 days**), then sent to the way back | Validate WAX accounts before sending |
| You never sent `release` on Ethereum | After 7 days `release` is refused | Send `expire`: tokens reissued on Telos (hop: sent on to the way back) |
| Ethereum daily outflow reached | `release` reverts, proof stays valid | Retry later |
| Amount below `min` | Vault / ledger refuses before taking funds (EVM: `BelowMinimum`; WAX: `deposit is below the minimum`) | Respect `min` |
| Amount above `depositableNow` | EVM: `CapExceeded`, tx reverts | Respect `depositableNow` |
| Route paused | `active.deposits` / `active.withdrawals` false in `/v1/chains` | Check before sending |

**Rule of thumb for a bot:** before every transfer, fetch `/v1/routes` for the
exact pair. Require `open == true` and `min ≤ amount ≤ max`. For hops into WAX,
also check that the WAX account exists via `get_account`.

---

## 10. Checklist and gotchas

- [ ] Amounts are `BigInt` / strings. Antelope quantities have exact precision.
- [ ] Memos are byte-exact: no spaces, lowercase Antelope names, `0x` addresses.
- [ ] WAX domain `1181148696416462999` is a **string** in code.
- [ ] Hop memos have **two legs** separated by `|`, and **no fee** field.
- [ ] Mirrors on WAX are `wrap.alcor` tokens (not some other USDC on WAX). Only
      `wrap.alcor` USDC/USDT/ETH/BNB and `eosio.token` WAX are accepted by the
      WAX vault. Anything else is refused (the transfer fails, nothing is lost).
- [ ] On WAX use `transfer`. The mirror token's `withdraw` action is refused by
      the vault.
- [ ] `telosTo` on EVM is the **uint64-encoded** Antelope name.
- [ ] `fillFee = 0`, `filler = 0`. Memo bytes are UTF-8, at most 256 bytes.
- [ ] USDT approve: reset to 0 first.
- [ ] Your accounts need resources: CPU/NET on WAX for the transfer, CPU/NET on
      Telos for `claim` / transfers, and ETH/BNB for gas on `deposit` and
      `release`.
- [ ] Ethereum `release` costs ~150k gas (light) or ~2.5M gas (hard). Budget for it.
- [ ] Size Telos → Ethereum against `withdrawableNow` (daily outflow), and
      deposits against `depositableNow`.
- [ ] Never assume instant: track by key, act on `status` / `hasProof` /
      `progress.waitingOn`.

---

## 11. Minimal action reference

### WAX

| action | args |
|---|---|
| `eosio.token::transfer` / `wrap.alcor::transfer` → `bridge.alcor` | `from, to, quantity, memo`. Memo `<telos account>[:<note>]`, or the hop memo `hop.alcor:<domain>:<0x…>\|1181148696416462999:<wax account>` |

### Telos

| action | args |
|---|---|
| `wrap.alcor::transfer` → `bridge.alcor` | memo `<domain>:<recipient>[:<fee>[:<memo>]]`. Domain `1` / `56` with `0x…`, or `1181148696416462999` with a WAX account. `<memo>`, everything after the third colon, is what the far side pays out with |
| `bridge.alcor::claim` | `owner, sym_code` (e.g. `"USDC"`) |
| `bridge.alcor::forward` | `domain, nonce`. Delivers a parked deposit. Anyone may; normally the operator does it within seconds |
| `hop.alcor::recover` | `id`. Sends a voided hop leg to its way back. Anyone may; normally automatic |

### Ethereum / BSC

| call | contract |
|---|---|
| `deposit(token, amount, telosTo, refundTo, 0, 0, memo)` | AlcorVault |
| `depositNative(telosTo, refundTo, 0, 0, memo)` payable | AlcorVault |
| `release(Proof)` / `submitAndRelease(...)` | `releaseTo` from `/v1/proofs/w:<id>` |
| `expire(Proof)` / `submitAndExpire(...)` | same, after `deadline` |
