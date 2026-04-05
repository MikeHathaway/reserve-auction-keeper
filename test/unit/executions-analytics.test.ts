import { describe, expect, it } from "vitest";
import {
  analyzeExecutionEvents,
  parseExecutionLogLine,
  renderExecutionAnalytics,
} from "../../src/analytics/executions.js";

describe("execution analytics", () => {
  it("parses structured success and failure log lines", () => {
    const success = parseExecutionLogLine(JSON.stringify({
      ts: "2026-03-31T00:00:00.000Z",
      msg: "Execution successful",
      chain: "base",
      pool: "0xpool",
      strategy: "funded",
      quoteTokenSymbol: "USDC",
      priceSource: "hybrid",
      submissionMode: "private-rpc",
      estimatedProfitUsd: "12.3400",
      realizedProfitUsd: "11.1200",
    }));
    const failure = parseExecutionLogLine(JSON.stringify({
      ts: "2026-03-31T00:01:00.000Z",
      msg: "Execution failed",
      chain: "base",
      pool: "0xpool",
      strategy: "flash-arb",
      quoteTokenSymbol: "USDC",
      priceSource: "alchemy",
      error: "reverted",
    }));

    expect(success).toMatchObject({
      kind: "success",
      strategy: "funded",
      priceSource: "hybrid",
      estimatedProfitUsd: 12.34,
      realizedProfitUsd: 11.12,
    });
    expect(failure).toMatchObject({
      kind: "failure",
      strategy: "flash-arb",
      error: "reverted",
    });
  });

  it("aggregates estimated profit by strategy and chain", () => {
    const events = [
      parseExecutionLogLine(JSON.stringify({
        msg: "Execution successful",
        chain: "base",
        pool: "0xpool-a",
        strategy: "funded",
        quoteTokenSymbol: "USDC",
        priceSource: "hybrid",
        submissionMode: "private-rpc",
        estimatedProfitUsd: "10.50",
        realizedProfitUsd: "9.90",
      })),
      parseExecutionLogLine(JSON.stringify({
        msg: "Execution successful",
        chain: "mainnet",
        pool: "0xpool-b",
        strategy: "flash-arb",
        quoteTokenSymbol: "WETH",
        priceSource: "alchemy",
        submissionMode: "flashbots",
        estimatedProfitUsd: "4.25",
        realizedProfitUsd: "3.75",
      })),
      parseExecutionLogLine(JSON.stringify({
        msg: "Execution failed",
        chain: "base",
        pool: "0xpool-c",
        strategy: "funded",
        quoteTokenSymbol: "USDC",
        priceSource: "hybrid",
        error: "simulation failed",
      })),
    ].filter((event): event is NonNullable<typeof event> => event !== null);

    const summary = analyzeExecutionEvents(events);

    expect(summary.totalSuccesses).toBe(2);
    expect(summary.totalFailures).toBe(1);
    expect(summary.totalEstimatedProfitUsd).toBeCloseTo(14.75, 6);
    expect(summary.totalRealizedProfitUsd).toBeCloseTo(13.65, 6);
    expect(summary.byStrategy[0]).toMatchObject({
      label: "funded",
      successes: 1,
      failures: 1,
      totalEstimatedProfitUsd: 10.5,
      totalRealizedProfitUsd: 9.9,
    });
    expect(summary.byChain.find((entry) => entry.label === "base")).toMatchObject({
      successes: 1,
      failures: 1,
    });
  });

  it("renders a human-readable report", () => {
    const summary = analyzeExecutionEvents([
      {
        kind: "success",
        chain: "base",
        pool: "0xpool-a",
        strategy: "funded",
        quoteTokenSymbol: "USDC",
        priceSource: "coingecko",
        submissionMode: "private-rpc",
        estimatedProfitUsd: 8,
        realizedProfitUsd: 7.4,
      },
    ]);

    const rendered = renderExecutionAnalytics(summary);
    expect(rendered).toContain("Execution Summary");
    expect(rendered).toContain("By Strategy");
    expect(rendered).toContain("RealizedProfitUsd");
    expect(rendered).toContain("funded");
  });
});
