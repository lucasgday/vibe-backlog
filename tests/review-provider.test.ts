import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getReviewProviderRuntimePath,
  persistReviewProviderSelection,
  readPersistedReviewProvider,
  resolveReviewAgentExecutionPlan,
} from "../src/core/review-provider";

type ProbeBinary = "codex" | "claude" | "claude-code" | "gemini";

type ProbeAvailability = Partial<Record<ProbeBinary, boolean>>;

function createProbeExecaMock(availability: ProbeAvailability) {
  return vi.fn(async (cmd: string, args: string[]) => {
    if (cmd !== "zsh") {
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    }

    const commandLine = String(args[1] ?? "");
    const match = /command -v ([a-zA-Z0-9_-]+)/.exec(commandLine);
    const binary = (match?.[1] ?? "") as ProbeBinary;
    const ok = Boolean(binary && availability[binary]);
    return {
      stdout: ok ? `/usr/bin/${binary}\n` : "",
      exitCode: ok ? 0 : 1,
    };
  });
}

describe.sequential("review provider resolution", () => {
  const originalCwd = process.cwd();
  let tempDir = "";

  const envKeys = [
    "VIBE_REVIEW_AGENT_CMD",
    "VIBE_REVIEW_CODEX_CMD",
    "VIBE_REVIEW_CLAUDE_CMD",
    "VIBE_REVIEW_GEMINI_CMD",
    "CODEX_THREAD_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CODEX_CI",
    "CLAUDE_CODE",
    "CLAUDE_SESSION_ID",
    "__CFBundleIdentifier",
  ] as const;

  let originalEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "vibe-review-provider-test-"));
    process.chdir(tempDir);

    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;

    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses --agent-cmd over any provider setting", async () => {
    const execaMock = createProbeExecaMock({ codex: true, claude: true, gemini: true });
    const plan = await resolveReviewAgentExecutionPlan({
      execaFn: execaMock as never,
      agentCmdOption: "custom-agent --json",
      agentProviderOption: "auto",
      env: {
        ...process.env,
        VIBE_REVIEW_AGENT_CMD: "env-agent",
      },
    });

    expect(plan.mode).toBe("command");
    expect(plan.provider).toBe("command");
    expect(plan.source).toBe("flag");
    if (plan.mode === "command") {
      expect(plan.command).toBe("custom-agent --json");
    }
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("uses VIBE_REVIEW_AGENT_CMD before provider auto-detect", async () => {
    const execaMock = createProbeExecaMock({ codex: true });
    const plan = await resolveReviewAgentExecutionPlan({
      execaFn: execaMock as never,
      agentCmdOption: null,
      agentProviderOption: "auto",
      env: {
        ...process.env,
        VIBE_REVIEW_AGENT_CMD: "cat",
      },
    });

    expect(plan.mode).toBe("command");
    expect(plan.source).toBe("env");
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("forces explicit provider with --agent-provider", async () => {
    const execaMock = createProbeExecaMock({ codex: true });
    const plan = await resolveReviewAgentExecutionPlan({
      execaFn: execaMock as never,
      agentCmdOption: null,
      agentProviderOption: "codex",
      env: process.env,
    });

    expect(plan.mode).toBe("provider");
    if (plan.mode === "provider") {
      expect(plan.provider).toBe("codex");
      expect(plan.source).toBe("flag");
      expect(plan.providerBinary).toBe("codex");
    }
  });

  it("in auto mode uses persisted provider when bootstrap is valid", async () => {
    const runtimePath = getReviewProviderRuntimePath();
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      JSON.stringify(
        {
          version: 1,
          provider: "gemini",
          source: "runtime",
          detected_at: "2026-02-16T00:00:00.000Z",
          last_ok_at: "2026-02-16T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = createProbeExecaMock({ gemini: true });
    const plan = await resolveReviewAgentExecutionPlan({
      execaFn: execaMock as never,
      agentCmdOption: null,
      agentProviderOption: "auto",
      env: process.env,
    });

    expect(plan.mode).toBe("provider");
    if (plan.mode === "provider") {
      expect(plan.provider).toBe("gemini");
      expect(plan.source).toBe("runtime");
      expect(plan.autoMode).toBe(true);
      expect(plan.healedFromRuntime).toBeNull();
    }
  });

  it("auto-heals persisted provider when bootstrap fails", async () => {
    const runtimePath = getReviewProviderRuntimePath();
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      JSON.stringify(
        {
          version: 1,
          provider: "codex",
          source: "runtime",
          detected_at: "2026-02-16T00:00:00.000Z",
          last_ok_at: "2026-02-16T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const execaMock = createProbeExecaMock({ claude: true });
    const plan = await resolveReviewAgentExecutionPlan({
      execaFn: execaMock as never,
      agentCmdOption: null,
      agentProviderOption: "auto",
      env: process.env,
    });

    expect(plan.mode).toBe("provider");
    if (plan.mode === "provider") {
      expect(plan.provider).toBe("claude");
      expect(plan.source).toBe("bin");
      expect(plan.healedFromRuntime).toBe("codex");
    }

    await persistReviewProviderSelection(plan);
    const persisted = await readPersistedReviewProvider(runtimePath);
    expect(persisted?.provider).toBe("claude");
  });

  it("detects gemini via VIBE_REVIEW_GEMINI_CMD without gemini binary", async () => {
    const execaMock = createProbeExecaMock({});
    const plan = await resolveReviewAgentExecutionPlan({
      execaFn: execaMock as never,
      agentCmdOption: null,
      agentProviderOption: "auto",
      env: {
        ...process.env,
        VIBE_REVIEW_GEMINI_CMD: "custom-gemini --json",
      },
    });

    expect(plan.mode).toBe("provider");
    if (plan.mode === "provider") {
      expect(plan.provider).toBe("gemini");
      expect(plan.source).toBe("env");
      expect(plan.providerCommandOverride).toBe("custom-gemini --json");
    }
  });

  it("detects gemini via binary when available", async () => {
    const execaMock = createProbeExecaMock({ gemini: true });
    const plan = await resolveReviewAgentExecutionPlan({
      execaFn: execaMock as never,
      agentCmdOption: null,
      agentProviderOption: "auto",
      env: process.env,
    });

    expect(plan.mode).toBe("provider");
    if (plan.mode === "provider") {
      expect(plan.provider).toBe("gemini");
      expect(plan.source).toBe("bin");
      expect(plan.providerBinary).toBe("gemini");
    }
  });
});
