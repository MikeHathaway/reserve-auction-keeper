import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateServer,
  mockListen,
  mockClose,
  mockOn,
  serverHandlerRef,
  serverEventHandlersRef,
} = vi.hoisted(() => {
  const serverHandlerRef: { current: ((req: { url?: string }, res: {
    writeHead: (status: number, headers?: Record<string, string>) => void;
    end: (body?: string) => void;
  }) => void) | null } = { current: null };
  const serverEventHandlersRef: {
    current: Partial<Record<string, (error?: Error) => void>>;
  } = { current: {} };
  const mockListen = vi.fn((_: number, callback?: () => void) => callback?.());
  const mockClose = vi.fn((callback?: () => void) => {
    callback?.();
    serverEventHandlersRef.current.close?.();
  });
  const mockOn = vi.fn((event: string, handler: (error?: Error) => void) => {
    serverEventHandlersRef.current[event] = handler;
    return mockServer;
  });
  const mockOnce = vi.fn((event: string, handler: (error?: Error) => void) => {
    serverEventHandlersRef.current[event] = handler;
    return mockServer;
  });
  const mockOff = vi.fn((event: string) => {
    delete serverEventHandlersRef.current[event];
    return mockServer;
  });
  const mockServer = {
    listen: mockListen,
    close: mockClose,
    on: mockOn,
    once: mockOnce,
    off: mockOff,
  };
  const mockCreateServer = vi.fn((handler: typeof serverHandlerRef.current) => {
    serverHandlerRef.current = handler;
    serverEventHandlersRef.current = {};
    return mockServer;
  });

  return {
    mockCreateServer,
    mockListen,
    mockClose,
    mockOn,
    serverHandlerRef,
    serverEventHandlersRef,
  };
});

vi.mock("node:http", () => ({
  createServer: mockCreateServer,
}));

import { setHealthy, startHealthCheck, stopHealthCheck } from "../../src/utils/health.js";
import {
  clearAllHealthDependencies,
  setHealthDependency,
} from "../../src/utils/health.js";

describe("health check", () => {
  afterEach(async () => {
    setHealthy(true);
    clearAllHealthDependencies();
    serverHandlerRef.current = null;
    serverEventHandlersRef.current = {};
    vi.clearAllMocks();
    await stopHealthCheck();
  });

  it("reports degraded once keeper health is flipped false", async () => {
    await startHealthCheck(8080);

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledWith(8080, expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("close", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));

    const writes: Array<{ status: number; headers?: Record<string, string> }> = [];
    const bodies: string[] = [];
    const response = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        writes.push({ status, headers });
      },
      end: (body?: string) => {
        bodies.push(body ?? "");
      },
    };

    serverHandlerRef.current?.({ url: "/health" }, response);
    expect(writes[0]?.status).toBe(200);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ status: "ok" });

    setHealthy(false);

    serverHandlerRef.current?.({ url: "/health" }, response);
    expect(writes[1]?.status).toBe(503);
    expect(JSON.parse(bodies[1] ?? "{}")).toMatchObject({ status: "degraded" });
  });

  it("reports degraded when a submission dependency is unhealthy", async () => {
    await startHealthCheck(8080);
    setHealthDependency("submitter:base:private-rpc", false, "submission endpoint unavailable");

    const writes: Array<{ status: number; headers?: Record<string, string> }> = [];
    const bodies: string[] = [];
    const response = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        writes.push({ status, headers });
      },
      end: (body?: string) => {
        bodies.push(body ?? "");
      },
    };

    serverHandlerRef.current?.({ url: "/health" }, response);

    expect(writes[0]?.status).toBe(503);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      status: "degraded",
      unhealthyDependencies: ["submitter:base:private-rpc"],
    });
  });

  it("closes the health-check server when requested", async () => {
    await startHealthCheck(8080);

    await stopHealthCheck();

    expect(mockClose).toHaveBeenCalled();
  });

  it("can start a fresh health-check server after stop", async () => {
    await startHealthCheck(8080);
    await stopHealthCheck();

    await startHealthCheck(8081);

    expect(mockCreateServer).toHaveBeenCalledTimes(2);
    expect(mockListen).toHaveBeenLastCalledWith(8081, expect.any(Function));
  });
});
