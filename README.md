# Ajna Reserve Auction Keeper

An open source bot that monitors and participates in [Ajna Protocol](https://www.ajna.finance/) reserve auctions across Ethereum Mainnet and Base.

Reserve auctions are the mechanism by which Ajna "buys back and burns" its native token using surplus quote tokens (interest) earned by pools. This bot automates participation in these Dutch auctions, executing trades when prices become favorable.

Current status: funded strategy supports live execution. Mainnet uses a single-tx Flashbots bundle path, Base uses private RPC submission, and flash-arb now has an executor-backed dry-run/live path when a deployed executor and per-chain routes are configured. Fork-tested end-to-end execution is still outstanding.

## How It Works

1. **Discovers pools** by scanning the Ajna PoolFactory for all deployed pools with whitelisted quote tokens (WETH, USDC, DAI)
2. **Monitors auctions** by polling each pool's reserve state via multicall
3. **Kicks auctions** when reserves are available and the 120-hour cooldown has elapsed (checks for unsettled liquidations first)
4. **Evaluates profitability** by comparing the Dutch auction price against configured market-price feeds
5. **Executes trades** via `takeReserves()` when the price meets your configured target, with MEV protection

## Quick Start

### Prerequisites

- Node.js 20+
- Foundry + `svm install 0.8.27` if you want to run the Solidity executor tests
- An Ethereum wallet with AJNA (Mainnet) or bwAJNA (Base) tokens
- RPC endpoints for Mainnet and/or Base
- Price API credentials for your chosen provider:
  `COINGECKO_API_KEY` for `pricing.provider = "coingecko"` or `"dual"`
  `ALCHEMY_API_KEY` for `pricing.provider = "alchemy"` or `"dual"`
  `RPC_PROVIDER=alchemy` + `RPC_API_KEY` can be reused for Alchemy pricing automatically

### Setup

```bash
git clone https://github.com/your-org/reserve-auction-keeper.git
cd reserve-auction-keeper
npm install
npm run build

# Copy and edit config files
cp .env.example .env
cp config.example.json config.json
```

### Configure

**`.env`** — secrets (never commit this file):
```
# Choose exactly one trading key source:
PRIVATE_KEY_FILE=./secrets/trading.key
# or:
# KEYSTORE_PATH=./secrets/trading.keystore.json
# KEYSTORE_PASSWORD_FILE=./secrets/trading.keystore.password

COINGECKO_API_KEY=your_coingecko_api_key
ALCHEMY_API_KEY=your_alchemy_price_api_key
RPC_PROVIDER=alchemy
RPC_API_KEY=your_alchemy_key

# Recommended for stable mainnet Flashbots relay identity:
FLASHBOTS_AUTH_KEY_FILE=./secrets/flashbots-auth.key
```

**`config.json`** — bot settings:
```json
{
  "chains": {
    "base": {
      "enabled": true,
      "rpcUrl": "https://base-mainnet.g.alchemy.com/v2/your_key"
    }
  },
  "pricing": {
    "provider": "coingecko"
  },
  "strategy": "funded",
  "funded": {
    "targetExitPriceUsd": 0.10,
    "autoApprove": false
  },
  "flashArb": {
    "maxSlippagePercent": 1,
    "minLiquidityUsd": 100,
    "minProfitUsd": 0,
    "routes": {
      "base": {
        "quoterAddress": "0x0000000000000000000000000000000000000000",
        "executorAddress": "0x0000000000000000000000000000000000000000",
        "flashLoanPools": {
          "USDC": "0x0000000000000000000000000000000000000000"
        },
        "quoteToAjnaPaths": {
          "USDC": "0x"
        }
      }
    }
  },
  "dryRun": true
}
```

### Run

```bash
# Dry run mode (default) — logs what it would do without executing
npm run dev

# Production
npm start

# Lint
npm run lint

# Analyze execution payouts from JSON logs
npm run analytics:executions -- ./keeper.log

# Solidity executor tests
npm run test:contracts

# Mainnet fork smoke test for canonical Uniswap V3 pool verification
npm run test:contracts:fork:mainnet
```

### Docker

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

This runs the keeper as a long-lived service with:

- `config.json` mounted read-only at `/app/config.json`
- secret paths loaded from your local `.env` via Compose `env_file`
- a named Docker volume mounted at `/app/.cache/pool-discovery` so pool auto-discovery stays warm across restarts
- the existing `/health` endpoint exposed on port `8080`

Recommended Docker secret pattern:

1. Put secret files on the host, for example under `./secrets/`.
2. In `.env`, point the bot at the in-container file paths:
   ```dotenv
   PRIVATE_KEY_FILE=/run/secrets/trading.key
   FLASHBOTS_AUTH_KEY_FILE=/run/secrets/flashbots-auth.key
   # or:
   # KEYSTORE_PATH=/run/secrets/trading.keystore.json
   # KEYSTORE_PASSWORD_FILE=/run/secrets/trading.keystore.password
   ```
3. Copy [`docker/docker-compose.secrets.example.yml`](docker/docker-compose.secrets.example.yml) to `docker/docker-compose.override.yml` and edit the host-side bind mount paths if needed.
4. Start Compose with the override:
   ```bash
   docker compose \
     -f docker/docker-compose.yml \
     -f docker/docker-compose.override.yml \
     up -d --build
   ```

`docker/docker-compose.override.yml` is ignored by git so each operator can keep machine-specific secret paths locally.

### systemd

For a Linux box that should start the Dockerized keeper on boot, use the sample unit in [`deploy/systemd/reserve-auction-keeper-compose.service`](deploy/systemd/reserve-auction-keeper-compose.service).

Assuming the repo lives at `/opt/reserve-auction-keeper`:

```bash
sudo cp deploy/systemd/reserve-auction-keeper-compose.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now reserve-auction-keeper-compose.service
sudo systemctl status reserve-auction-keeper-compose.service
```

If your checkout path is not `/opt/reserve-auction-keeper`, edit the unit's `WorkingDirectory` first.

Useful commands:

```bash
sudo systemctl restart reserve-auction-keeper-compose.service
sudo journalctl -u reserve-auction-keeper-compose.service -f
docker compose -f /opt/reserve-auction-keeper/docker/docker-compose.yml logs -f keeper
```

## Configuration

### Strategy: Funded (Passive Accumulator)

For AJNA holders who want to exit their position into quote tokens at a specific price.

- Set `targetExitPriceUsd` to your minimum acceptable value per AJNA spent (in USD worth of quote tokens)
- The bot will call `takeReserves()` when the auction price decays enough that each AJNA spent buys at least your target amount of quote tokens
- Pre-approve your AJNA tokens for each pool, or set `autoApprove: true`
- In live mode, `autoApprove` uses the same MEV/private submission path as the trade instead of a public approval transaction
- In `dryRun`, missing allowance is surfaced as a warning/error; the bot will not mutate state to auto-approve

### Strategy: Flash-Arb

Flash-arb borrows AJNA or bwAJNA from a configured Uniswap V3 pool, calls `takeReserves()`, swaps the received quote token back to AJNA, repays the flash loan, and keeps the spread.

- `strategy: "flash-arb"` now uses the on-chain `FlashArbExecutor` contract path
- `flashArb.maxSlippagePercent`, `flashArb.minLiquidityUsd`, and `flashArb.minProfitUsd` gate candidate selection before execution
- `flashArb.routes.<chain>.quoterAddress` and `quoteToAjnaPaths` provide executable Uniswap V3 quote-token → AJNA routes
- `flashArb.routes.<chain>.flashLoanPools.<symbol>` selects the Uniswap V3 pool used for the AJNA flash borrow
- `flashArb.routes.<chain>.executorAddress` or top-level `flashArb.executorAddress` must point at a deployed `FlashArbExecutor`
- The runtime path is live, but you should still treat it as advanced/operator-only until fork tests exist for your target chains

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `dryRun` | `true` | Log opportunities without executing. **Start here.** |
| `pricing.provider` | `coingecko` | Price source: `coingecko`, `alchemy`, or strict `dual` agreement mode |
| `funded.targetExitPriceUsd` | `0.10` | Minimum USD value of quote tokens received per AJNA spent |
| `funded.autoApprove` | `false` | Auto-approve AJNA spending for pools |
| `flashArb.maxSlippagePercent` | `1` | Slippage tolerance applied to quoted AJNA output before execution |
| `flashArb.minLiquidityUsd` | `100` | Minimum quote-token liquidity required before evaluating a flash-arb |
| `flashArb.minProfitUsd` | `0` | Minimum conservative USD profit after flash fee + slippage floor |
| `flashArb.executorAddress` | unset | Optional default executor address used when a chain route does not override it |
| `flashArb.routes.<chain>.quoterAddress` | unset | Uniswap V3 quoter used for executable route quotes |
| `flashArb.routes.<chain>.executorAddress` | unset | Chain-specific deployed `FlashArbExecutor` |
| `flashArb.routes.<chain>.flashLoanPools.<symbol>` | unset | Uniswap V3 pool used to flash-borrow AJNA for that quote token |
| `flashArb.routes.<chain>.quoteToAjnaPaths.<symbol>` | unset | Hex-encoded Uniswap V3 path from quote token to AJNA/bwAJNA |
| `profitMarginPercent` | `5` | Required profit margin above gas costs |
| `gasPriceCeilingGwei` | `100` | Skip execution if gas exceeds this |
| `polling.idleIntervalMs` | `60000` | Poll interval when no auction is near profitability |
| `polling.activeIntervalMs` | `10000` | Poll interval when an auction is approaching target |
| `polling.profitabilityThreshold` | `0.2` | Switch to active polling when projected profit is within 20% of the gas-adjusted target |
| `alertWebhookUrl` | unset | Optional webhook for `alert` and `fatal` events |

## Safety

- **Dry run by default.** The bot will not execute any transactions until you set `dryRun: false`.
- **Use a dedicated hot wallet.** Never use your main wallet. Fund it with only the AJNA you're willing to trade.
- **`dual` pricing is strict by design.** The keeper pauses execution if CoinGecko and Alchemy disagree beyond the configured divergence threshold or if either feed is unavailable.
- **Prefer file or keystore secret inputs.** `PRIVATE_KEY_FILE` or `KEYSTORE_PATH` + `KEYSTORE_PASSWORD_FILE` keeps raw trading keys out of your shell environment.
- **Mainnet live mode uses single-tx Flashbots bundles.** The keeper prepares, signs, simulates, and submits a raw bundle, then retries across up to 3 target blocks.
- **Persist the Flashbots auth key.** `FLASHBOTS_AUTH_KEY_FILE` keeps a stable relay identity across restarts instead of generating a fresh one every boot.
- **Base and other `private-rpc` chains fail closed without a private RPC URL.** Live submission is disabled instead of silently degrading to public mempool.
- **Flash-arb requires a deployed executor contract.** The keeper will refuse live flash-arb mode if the chain route or executor address is missing.
- **Flash-arb callback verification is factory-hardened.** The executor checks the callback sender against the configured Uniswap V3 factory and pool init code hash before repaying any flash loan.
- **Gas ceiling.** The bot skips execution during gas spikes.
- **Health check.** HTTP endpoint at `/health` (default port 8080) for monitoring.
- **Pool discovery is cached locally.** Auto-discovered pool lists are persisted under `.cache/pool-discovery` to make restarts and periodic rediscovery cheaper.

## Analytics

Keeper logs are structured JSON lines. `npm run analytics:executions -- <log-file...>` reads those logs and summarizes execution payouts by strategy, chain, submission mode, price source, and pool.

Successful live executions now include both:

- estimated P&L from the pre-trade strategy decision
- realized P&L from post-receipt wallet balance deltas plus gas spent

If you pipe logs from Docker or systemd, send them through the script directly:

```bash
docker compose -f docker/docker-compose.yml logs keeper | npm run analytics:executions --
```

## Architecture

```
src/
  index.ts              — CLI entry point
  config.ts             — Config loading + Zod validation
  keeper.ts             — Main loop (per-chain, concurrent, error-isolated)
  auction/
    discovery.ts        — Pool auto-discovery via PoolFactory + reserve state
    auction-price.ts    — On-chain auction price from PoolInfoUtils
  pricing/
    coingecko.ts        — Coingecko Pro API client with caching
    oracle.ts           — Price oracle with cross-check support
  strategies/
    interface.ts        — ExecutionStrategy interface (pluggable)
    funded.ts           — Passive accumulator strategy
    flash-arb.ts        — Executor-backed flash-arb strategy
  execution/
    mev-submitter.ts    — MEV/private orderflow submitter interface
    flashbots.ts        — Single-tx Flashbots bundle submitter
    private-rpc.ts      — Private RPC submission for L2
    gas.ts              — Gas checks + profitability
  contracts/
    FlashArbExecutor.sol — Uniswap V3 flash-loan executor
  chains/
    index.ts            — Chain configs (Mainnet + Base)
  contracts/abis/       — Ajna contract ABIs
  utils/
    logger.ts           — Structured JSON logging
    health.ts           — Health check HTTP server
```

## License

MIT
