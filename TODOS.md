# TODOS

## v1.x: MEV Hardening + Flash-Arb Scaffolding

**What:** Close the gap between the current funded keeper scaffold and the architecture the project claims to have.

**Why:** The funded keeper now has a real Mainnet bundle path, MEV-routed approvals, and an executor-backed flash-arb path with factory-hardened callback checks, but fork-tested end-to-end execution still is not built.

**Items:**
- [x] Refactor submission results to support tx-hash and bundle-hash style outcomes
- [x] Add a `flash-arb` strategy scaffold with explicit non-production behavior
- [x] Implement real Flashbots bundle signing, simulation, relay submission, and inclusion tracking
- [x] Add DEX quote + slippage + liquidity checks for flash-arb viability
- [x] Build and test a real flash-arb executor contract path
- [x] Harden flash callback verification against the canonical Uniswap V3 factory / CREATE2 pool address
- [ ] Add fork tests for Mainnet private submission and flash-arb execution
- [ ] Add end-to-end fork tests that exercise a real reserve-auction flash-arb path, not just canonical pool verification smoke checks

## v2: Flash-Arb Strategy

**What:** Add flash-arb execution strategy using Uniswap V3 flash swaps for zero-capital reserve auction participation.

**Why:** The funded strategy requires AJNA inventory. Flash-arb lets operators participate with zero capital by borrowing AJNA via flash swap, calling takeReserves, swapping the received quote tokens back to AJNA, and repaying the loan. Profit is kept by the operator.

**Gate:** Before starting, verify AJNA/bwAJNA Uniswap V3 pool depth on both Mainnet and Base. At AJNA price ~$0.003, liquidity may be too thin for profitable flash swaps.

**Context:**
- Architecture already supports this via the `ExecutionStrategy` interface in `src/strategies/interface.ts`
- Needs `FlashArbExecutor.sol` Solidity contract (Uniswap V3 flash swap, callback access control via CREATE2 pool address verification, multi-hop swap support for Base bwAJNA routing)
- Pricing must use executable on-chain Uniswap quotes at trade size, not Coingecko spot prices
- Breakeven formula must include: DEX fees (0.3% per hop), price impact, flash swap fee, gas, Ajna rounding behavior
- One contract with constructor params (ajnaToken, uniswapFactory), deployed per chain
- Strategic consideration: open-sourcing flash-arb compresses the arbitrage edge. May be better as a private strategy.

**Depends on:** v1 shipped and running, AJNA DEX liquidity verification.

---

## v2: Keeper Hub Integration

**What:** Integrate with Ajna Keeper Hub for secure key management and gas replenishment.

**Why:** v1 uses env-var private keys and encrypted keystores. Keeper Hub (referenced in the original spec) may provide a more secure and ops-friendly key management solution.

**Context:**
- The `ExecutionStrategy` interface accepts wallet/signer abstractions that can be swapped
- Need to clarify what Keeper Hub actually provides (may be an Ajna ecosystem tool not yet built)
- `Signer` abstraction in the strategy layer was designed with this swap-in in mind

**Depends on:** Keeper Hub API/documentation availability.
