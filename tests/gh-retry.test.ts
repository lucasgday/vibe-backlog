import { describe, expect, it, vi } from "vitest";

import { isIdempotentGhCommand, isRetryableGhError, runGhWithRetry } from "../src/core/gh-retry";

function transientError(message: string): Error {
  const error = new Error(message) as Error & { stderr?: string };
  error.stderr = message;
  return error;
}

describe("gh retry", () => {
  it("retries transient GitHub errors and then succeeds", async () => {
    let attempts = 0;
    const execaMock = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw transientError("error connecting to api.github.com");
      }
      return { stdout: "ok" };
    });

    const result = await runGhWithRetry(execaMock as never, ["issue", "list"], { stdio: "pipe" }, { backoffMs: [0, 0, 0] });
    expect(result.stdout).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;
    const execaMock = vi.fn(async () => {
      attempts += 1;
      throw transientError("GraphQL: Resource not accessible by integration");
    });

    await expect(
      runGhWithRetry(execaMock as never, ["issue", "list"], { stdio: "pipe" }, { backoffMs: [0, 0, 0] }),
    ).rejects.toThrow("Resource not accessible");
    expect(attempts).toBe(1);
  });

  it("stops at configured attempt limit", async () => {
    let attempts = 0;
    const execaMock = vi.fn(async () => {
      attempts += 1;
      throw transientError("timeout");
    });

    await expect(
      runGhWithRetry(execaMock as never, ["pr", "list"], { stdio: "pipe" }, { attempts: 2, backoffMs: [0, 0, 0] }),
    ).rejects.toThrow("timeout");
    expect(attempts).toBe(2);
  });

  it("does not retry non-idempotent commands by default", async () => {
    let attempts = 0;
    const execaMock = vi.fn(async () => {
      attempts += 1;
      throw transientError("error connecting to api.github.com");
    });

    await expect(
      runGhWithRetry(execaMock as never, ["issue", "create", "--title", "x"], { stdio: "pipe" }, { attempts: 3, backoffMs: [0, 0, 0] }),
    ).rejects.toThrow("api.github.com");
    expect(attempts).toBe(1);
  });

  it("detects retryable patterns", () => {
    expect(isRetryableGhError(transientError("502 Bad Gateway"))).toBe(true);
    expect(isRetryableGhError(transientError("connection reset by peer"))).toBe(true);
    expect(isRetryableGhError(transientError("validation failed"))).toBe(false);
  });

  it("classifies idempotent gh commands", () => {
    expect(isIdempotentGhCommand(["issue", "list"])).toBe(true);
    expect(isIdempotentGhCommand(["pr", "view", "12"])).toBe(true);
    expect(isIdempotentGhCommand(["api", "repos/acme/demo/issues"])).toBe(true);
    expect(isIdempotentGhCommand(["api", "--method", "POST", "repos/acme/demo/issues"])).toBe(false);
    expect(isIdempotentGhCommand(["issue", "create", "--title", "x"])).toBe(false);
  });
});
