import { afterEach, describe, expect, it } from "vitest";
import { createRestrictedChildEnv } from "../../scripts/child-process-env.mjs";

describe("child-process env helper", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("only forwards explicitly requested secret env keys", () => {
    process.env.PATH = "/usr/bin";
    process.env.ETHERSCAN_API_KEY = "etherscan-secret";
    process.env.RPC_API_KEY = "rpc-secret";

    const env = createRestrictedChildEnv({}, ["ETHERSCAN_API_KEY"]);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.ETHERSCAN_API_KEY).toBe("etherscan-secret");
    expect(env.RPC_API_KEY).toBeUndefined();
  });
});
