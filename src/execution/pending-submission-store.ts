import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address } from "viem";
import type { PendingSubmission } from "./mev-submitter.js";
import { logger } from "../utils/logger.js";

export interface PendingSubmissionRecord extends PendingSubmission {
  operation: "execution" | "reserve-auction kick";
  pool: Address;
}

interface PendingSubmissionSnapshot {
  version: number;
  chain: string;
  pendingSubmission: {
    txHash: string;
    label: string;
    mode?: string;
    bundleHash?: string;
    targetBlock?: string;
    privateSubmission?: boolean;
    account?: string;
    nonce?: string;
    submittedAtMs?: number;
    operation: "execution" | "reserve-auction kick";
    pool: string;
  };
}

const PENDING_SUBMISSION_CACHE_VERSION = 1;
const DEFAULT_PENDING_SUBMISSION_CACHE_DIR = join(
  process.cwd(),
  ".cache",
  "pending-submissions",
);

function getPendingSubmissionCachePath(
  chainName: string,
  cacheDir: string = DEFAULT_PENDING_SUBMISSION_CACHE_DIR,
): string {
  return join(cacheDir, `${chainName}.json`);
}

export async function loadPendingSubmission(
  chainName: string,
  cacheDir: string = DEFAULT_PENDING_SUBMISSION_CACHE_DIR,
): Promise<PendingSubmissionRecord | null> {
  const cachePath = getPendingSubmissionCachePath(chainName, cacheDir);

  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PendingSubmissionSnapshot>;

    if (parsed.version !== PENDING_SUBMISSION_CACHE_VERSION) return null;
    if (parsed.chain !== chainName) return null;
    if (!parsed.pendingSubmission) return null;

    const pending = parsed.pendingSubmission;
    if (
      typeof pending.txHash !== "string" ||
      typeof pending.label !== "string" ||
      typeof pending.operation !== "string" ||
      typeof pending.pool !== "string"
    ) {
      return null;
    }

    return {
      txHash: pending.txHash as `0x${string}`,
      label: pending.label,
      mode:
        pending.mode === "flashbots" || pending.mode === "private-rpc"
          ? pending.mode
          : undefined,
      bundleHash: typeof pending.bundleHash === "string" ? pending.bundleHash : undefined,
      targetBlock:
        typeof pending.targetBlock === "string" ? BigInt(pending.targetBlock) : undefined,
      privateSubmission:
        typeof pending.privateSubmission === "boolean" ? pending.privateSubmission : undefined,
      account: typeof pending.account === "string" ? pending.account as Address : undefined,
      nonce: typeof pending.nonce === "string" ? BigInt(pending.nonce) : undefined,
      submittedAtMs:
        typeof pending.submittedAtMs === "number" ? pending.submittedAtMs : undefined,
      operation: pending.operation,
      pool: pending.pool as Address,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }

    logger.warn("Ignoring unreadable pending submission cache", {
      chain: chainName,
      cachePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function savePendingSubmission(
  chainName: string,
  pendingSubmission: PendingSubmissionRecord,
  cacheDir: string = DEFAULT_PENDING_SUBMISSION_CACHE_DIR,
): Promise<void> {
  const cachePath = getPendingSubmissionCachePath(chainName, cacheDir);
  const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;

  const snapshot: PendingSubmissionSnapshot = {
    version: PENDING_SUBMISSION_CACHE_VERSION,
    chain: chainName,
    pendingSubmission: {
      txHash: pendingSubmission.txHash,
      label: pendingSubmission.label,
      mode: pendingSubmission.mode,
      bundleHash: pendingSubmission.bundleHash,
      targetBlock: pendingSubmission.targetBlock?.toString(),
      privateSubmission: pendingSubmission.privateSubmission,
      account: pendingSubmission.account,
      nonce: pendingSubmission.nonce?.toString(),
      submittedAtMs: pendingSubmission.submittedAtMs,
      operation: pendingSubmission.operation,
      pool: pendingSubmission.pool,
    },
  };

  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(tempPath, JSON.stringify(snapshot, null, 2));
    await rename(tempPath, cachePath);
  } catch (error) {
    logger.warn("Failed to persist pending submission cache", {
      chain: chainName,
      cachePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearPendingSubmission(
  chainName: string,
  cacheDir: string = DEFAULT_PENDING_SUBMISSION_CACHE_DIR,
): Promise<void> {
  const cachePath = getPendingSubmissionCachePath(chainName, cacheDir);

  try {
    await rm(cachePath, { force: true });
  } catch (error) {
    logger.warn("Failed to clear pending submission cache", {
      chain: chainName,
      cachePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
