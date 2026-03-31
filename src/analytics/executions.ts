export interface ParsedExecutionEvent {
  ts?: string;
  chain: string;
  pool: string;
  strategy: string;
  quoteTokenSymbol: string;
  priceSource: string;
  kind: "success" | "failure";
  submissionMode?: string;
  estimatedProfitUsd?: number;
  realizedProfitUsd?: number;
  error?: string;
}

export interface ExecutionBreakdown {
  label: string;
  successes: number;
  failures: number;
  totalEstimatedProfitUsd: number;
  avgEstimatedProfitUsd: number;
  realizedSamples: number;
  totalRealizedProfitUsd: number;
  avgRealizedProfitUsd: number;
}

export interface ExecutionAnalyticsSummary {
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  totalEstimatedProfitUsd: number;
  avgEstimatedProfitUsd: number;
  minEstimatedProfitUsd: number | null;
  maxEstimatedProfitUsd: number | null;
  totalRealizedProfitUsd: number;
  avgRealizedProfitUsd: number | null;
  minRealizedProfitUsd: number | null;
  maxRealizedProfitUsd: number | null;
  realizedSamples: number;
  byStrategy: ExecutionBreakdown[];
  byChain: ExecutionBreakdown[];
  bySubmissionMode: ExecutionBreakdown[];
  byPriceSource: ExecutionBreakdown[];
  topPools: ExecutionBreakdown[];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function createBreakdown(label: string): ExecutionBreakdown {
  return {
    label,
    successes: 0,
    failures: 0,
    totalEstimatedProfitUsd: 0,
    avgEstimatedProfitUsd: 0,
    realizedSamples: 0,
    totalRealizedProfitUsd: 0,
    avgRealizedProfitUsd: 0,
  };
}

function updateBreakdown(
  groups: Map<string, ExecutionBreakdown>,
  label: string,
  event: ParsedExecutionEvent,
) {
  const group = groups.get(label) ?? createBreakdown(label);

  if (event.kind === "success") {
    group.successes += 1;
    group.totalEstimatedProfitUsd += event.estimatedProfitUsd ?? 0;
    group.avgEstimatedProfitUsd = group.successes === 0
      ? 0
      : group.totalEstimatedProfitUsd / group.successes;

    if (event.realizedProfitUsd != null) {
      group.realizedSamples += 1;
      group.totalRealizedProfitUsd += event.realizedProfitUsd;
      group.avgRealizedProfitUsd = group.realizedSamples === 0
        ? 0
        : group.totalRealizedProfitUsd / group.realizedSamples;
    }
  } else {
    group.failures += 1;
  }

  groups.set(label, group);
}

function sortBreakdowns(groups: Map<string, ExecutionBreakdown>): ExecutionBreakdown[] {
  return Array.from(groups.values()).sort((a, b) => {
    if (b.totalRealizedProfitUsd !== a.totalRealizedProfitUsd) {
      return b.totalRealizedProfitUsd - a.totalRealizedProfitUsd;
    }
    if (b.totalEstimatedProfitUsd !== a.totalEstimatedProfitUsd) {
      return b.totalEstimatedProfitUsd - a.totalEstimatedProfitUsd;
    }
    if (b.successes !== a.successes) {
      return b.successes - a.successes;
    }
    return a.label.localeCompare(b.label);
  });
}

export function parseExecutionLogLine(line: string): ParsedExecutionEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const message = parsed.msg;
  if (message !== "Execution successful" && message !== "Execution failed") {
    return null;
  }

  const chain = typeof parsed.chain === "string" ? parsed.chain : null;
  const pool = typeof parsed.pool === "string" ? parsed.pool : null;
  if (!chain || !pool) return null;

  return {
    ts: typeof parsed.ts === "string" ? parsed.ts : undefined,
    chain,
    pool,
    strategy: typeof parsed.strategy === "string" ? parsed.strategy : "unknown",
    quoteTokenSymbol:
      typeof parsed.quoteTokenSymbol === "string" ? parsed.quoteTokenSymbol : "unknown",
    priceSource: typeof parsed.priceSource === "string" ? parsed.priceSource : "unknown",
    kind: message === "Execution successful" ? "success" : "failure",
    submissionMode:
      typeof parsed.submissionMode === "string" ? parsed.submissionMode : undefined,
    estimatedProfitUsd:
      toNumber(parsed.estimatedProfitUsd) ?? toNumber(parsed.profitUsd) ?? undefined,
    realizedProfitUsd: toNumber(parsed.realizedProfitUsd) ?? undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
  };
}

export function analyzeExecutionEvents(
  events: ParsedExecutionEvent[],
): ExecutionAnalyticsSummary {
  const byStrategy = new Map<string, ExecutionBreakdown>();
  const byChain = new Map<string, ExecutionBreakdown>();
  const bySubmissionMode = new Map<string, ExecutionBreakdown>();
  const byPriceSource = new Map<string, ExecutionBreakdown>();
  const byPool = new Map<string, ExecutionBreakdown>();

  const successfulEstimatedProfits: number[] = [];
  const successfulRealizedProfits: number[] = [];
  let totalSuccesses = 0;
  let totalFailures = 0;

  for (const event of events) {
    updateBreakdown(byStrategy, event.strategy, event);
    updateBreakdown(byChain, event.chain, event);
    updateBreakdown(byPriceSource, event.priceSource, event);
    updateBreakdown(byPool, `${event.chain}:${event.pool}`, event);

    if (event.kind === "success") {
      totalSuccesses += 1;
      if (event.submissionMode) {
        updateBreakdown(bySubmissionMode, event.submissionMode, event);
      }
      successfulEstimatedProfits.push(event.estimatedProfitUsd ?? 0);
      if (event.realizedProfitUsd != null) {
        successfulRealizedProfits.push(event.realizedProfitUsd);
      }
    } else {
      totalFailures += 1;
    }
  }

  const totalEstimatedProfitUsd = successfulEstimatedProfits.reduce((sum, value) => sum + value, 0);
  const totalRealizedProfitUsd = successfulRealizedProfits.reduce((sum, value) => sum + value, 0);
  return {
    totalSuccesses,
    totalFailures,
    successRate: totalSuccesses + totalFailures === 0
      ? 0
      : totalSuccesses / (totalSuccesses + totalFailures),
    totalEstimatedProfitUsd,
    avgEstimatedProfitUsd: totalSuccesses === 0 ? 0 : totalEstimatedProfitUsd / totalSuccesses,
    minEstimatedProfitUsd: successfulEstimatedProfits.length === 0
      ? null
      : Math.min(...successfulEstimatedProfits),
    maxEstimatedProfitUsd: successfulEstimatedProfits.length === 0
      ? null
      : Math.max(...successfulEstimatedProfits),
    totalRealizedProfitUsd,
    avgRealizedProfitUsd: successfulRealizedProfits.length === 0
      ? null
      : totalRealizedProfitUsd / successfulRealizedProfits.length,
    minRealizedProfitUsd: successfulRealizedProfits.length === 0
      ? null
      : Math.min(...successfulRealizedProfits),
    maxRealizedProfitUsd: successfulRealizedProfits.length === 0
      ? null
      : Math.max(...successfulRealizedProfits),
    realizedSamples: successfulRealizedProfits.length,
    byStrategy: sortBreakdowns(byStrategy),
    byChain: sortBreakdowns(byChain),
    bySubmissionMode: sortBreakdowns(bySubmissionMode),
    byPriceSource: sortBreakdowns(byPriceSource),
    topPools: sortBreakdowns(byPool).slice(0, 10),
  };
}

function formatCurrency(value: number | null): string {
  if (value == null) return "n/a";
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderBreakdownTable(title: string, rows: ExecutionBreakdown[]): string {
  if (rows.length === 0) return `${title}\n(no data)`;

  const header = "Label                           Success  Fail  EstUsd       RealUsd     Realized";
  const separator = "------------------------------ ------- ----- ------------ ------------ --------";
  const body = rows.map((row) => {
    const label = row.label.padEnd(30);
    const successes = String(row.successes).padStart(7);
    const failures = String(row.failures).padStart(5);
    const totalEstimatedProfit = row.totalEstimatedProfitUsd.toFixed(2).padStart(12);
    const totalRealizedProfit = row.totalRealizedProfitUsd.toFixed(2).padStart(12);
    const realizedSamples = String(row.realizedSamples).padStart(8);
    return `${label} ${successes} ${failures} ${totalEstimatedProfit} ${totalRealizedProfit} ${realizedSamples}`;
  });

  return [title, header, separator, ...body].join("\n");
}

export function renderExecutionAnalytics(summary: ExecutionAnalyticsSummary): string {
  const sections = [
    [
      "Execution Summary",
      `Successes: ${summary.totalSuccesses}`,
      `Failures: ${summary.totalFailures}`,
      `SuccessRate: ${formatPercent(summary.successRate)}`,
      `EstimatedProfitUsd: ${formatCurrency(summary.totalEstimatedProfitUsd)}`,
      `AvgEstimatedProfitUsd: ${formatCurrency(summary.avgEstimatedProfitUsd)}`,
      `MinEstimatedProfitUsd: ${formatCurrency(summary.minEstimatedProfitUsd)}`,
      `MaxEstimatedProfitUsd: ${formatCurrency(summary.maxEstimatedProfitUsd)}`,
      `RealizedSamples: ${summary.realizedSamples}`,
      `RealizedProfitUsd: ${formatCurrency(summary.totalRealizedProfitUsd)}`,
      `AvgRealizedProfitUsd: ${formatCurrency(summary.avgRealizedProfitUsd)}`,
      `MinRealizedProfitUsd: ${formatCurrency(summary.minRealizedProfitUsd)}`,
      `MaxRealizedProfitUsd: ${formatCurrency(summary.maxRealizedProfitUsd)}`,
    ].join("\n"),
    renderBreakdownTable("By Strategy", summary.byStrategy),
    renderBreakdownTable("By Chain", summary.byChain),
    renderBreakdownTable("By Submission Mode", summary.bySubmissionMode),
    renderBreakdownTable("By Price Source", summary.byPriceSource),
    renderBreakdownTable("Top Pools", summary.topPools),
  ];

  return sections.join("\n\n");
}
