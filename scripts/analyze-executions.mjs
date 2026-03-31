import { readFile } from "node:fs/promises";
import process from "node:process";

async function loadAnalyticsModule() {
  try {
    return await import("../dist/analytics/executions.js");
  } catch (error) {
    throw new Error(
      `analytics module is not built yet. Run 'npm run build' first. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function printUsage() {
  process.stderr.write(
    "Usage: npm run analytics:executions -- <log-file...> [--json]\n" +
    "       cat keeper.log | npm run analytics:executions --\n",
  );
}

async function main() {
  const {
    analyzeExecutionEvents,
    parseExecutionLogLine,
    renderExecutionAnalytics,
  } = await loadAnalyticsModule();

  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const fileArgs = args.filter((arg) => arg !== "--json");

  if (fileArgs.includes("--help") || fileArgs.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const contents = fileArgs.length === 0
    ? [await readStdin()]
    : await Promise.all(fileArgs.map((filePath) => readFile(filePath, "utf-8")));

  const events = contents
    .flatMap((content) => content.split(/\r?\n/))
    .map(parseExecutionLogLine)
    .filter((event) => event !== null);

  if (events.length === 0) {
    process.stderr.write("No execution events found in the provided logs.\n");
    process.exit(1);
  }

  const summary = analyzeExecutionEvents(events);

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderExecutionAnalytics(summary)}\n`);
}

void main().catch((error) => {
  process.stderr.write(
    `Failed to analyze execution logs: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
