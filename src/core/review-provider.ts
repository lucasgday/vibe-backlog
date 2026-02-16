import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";

type ExecaFn = typeof execa;

export const REVIEW_AGENT_PROVIDER_VALUES = ["auto", "codex", "claude", "gemini", "command"] as const;
export type ReviewAgentProviderOption = (typeof REVIEW_AGENT_PROVIDER_VALUES)[number];
export type ReviewAgentProvider = Exclude<ReviewAgentProviderOption, "auto" | "command">;

const PROVIDER_PRIORITY: readonly ReviewAgentProvider[] = ["codex", "claude", "gemini"];
const PROVIDER_RUNTIME_FILE = path.join(".vibe", "runtime", "review-agent-provider.json");

const PersistedProviderSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["codex", "claude", "gemini"]),
  source: z.enum(["runtime", "host", "bin", "env"]),
  detected_at: z.string().min(1),
  last_ok_at: z.string().nullable(),
});

export type PersistedReviewProvider = z.infer<typeof PersistedProviderSchema>;

type ProviderBootstrap = {
  provider: ReviewAgentProvider;
  available: boolean;
  source: "env" | "bin" | null;
  commandOverride: string | null;
  binary: string | null;
};

export type ReviewAgentExecutionPlan =
  | {
      mode: "command";
      provider: "command";
      source: "flag" | "env";
      command: string;
      runtimePath: string;
      autoMode: false;
      resumeThreadId: null;
      healedFromRuntime: null;
    }
  | {
      mode: "provider";
      provider: ReviewAgentProvider;
      source: "flag" | "runtime" | "host" | "bin" | "env";
      providerBinary: string | null;
      providerCommandOverride: string | null;
      runtimePath: string;
      autoMode: boolean;
      resumeThreadId: string | null;
      healedFromRuntime: ReviewAgentProvider | null;
    };

export type ResolveReviewProviderPlanParams = {
  execaFn: ExecaFn;
  agentCmdOption: string | null | undefined;
  agentProviderOption: string | null | undefined;
  env?: NodeJS.ProcessEnv;
};

function normalizeProviderOption(value: string | null | undefined): ReviewAgentProviderOption | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return REVIEW_AGENT_PROVIDER_VALUES.includes(normalized as ReviewAgentProviderOption)
    ? (normalized as ReviewAgentProviderOption)
    : null;
}

function commandFromEnv(env: NodeJS.ProcessEnv): string | null {
  const command = env.VIBE_REVIEW_AGENT_CMD?.trim();
  return command || null;
}

function providerCommandOverride(provider: ReviewAgentProvider, env: NodeJS.ProcessEnv): string | null {
  if (provider === "codex") {
    return env.VIBE_REVIEW_CODEX_CMD?.trim() || null;
  }
  if (provider === "claude") {
    return env.VIBE_REVIEW_CLAUDE_CMD?.trim() || null;
  }
  if (provider === "gemini") {
    return env.VIBE_REVIEW_GEMINI_CMD?.trim() || null;
  }
  return null;
}

function getRuntimePath(): string {
  return path.resolve(process.cwd(), PROVIDER_RUNTIME_FILE);
}

function hasAnyEnvKey(env: NodeJS.ProcessEnv, prefixes: string[]): boolean {
  return Object.keys(env).some((key) => prefixes.some((prefix) => key.toUpperCase().startsWith(prefix)));
}

export function detectHostProvider(env: NodeJS.ProcessEnv = process.env): ReviewAgentProvider | null {
  const bundleId = env.__CFBundleIdentifier?.trim().toLowerCase() ?? "";
  if (
    bundleId === "com.openai.codex" ||
    Boolean(env.CODEX_THREAD_ID) ||
    Boolean(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) ||
    Boolean(env.CODEX_CI)
  ) {
    return "codex";
  }

  if (Boolean(env.CLAUDE_CODE) || Boolean(env.CLAUDE_SESSION_ID) || hasAnyEnvKey(env, ["CLAUDE_", "ANTHROPIC_"])) {
    return "claude";
  }

  if (hasAnyEnvKey(env, ["GEMINI_", "GOOGLE_GENAI_"])) {
    return "gemini";
  }

  return null;
}

async function commandExists(execaFn: ExecaFn, command: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) return false;
  const probe = await execaFn("zsh", ["-lc", `command -v ${command}`], {
    stdio: "pipe",
    reject: false,
  });
  const exitCode = typeof probe.exitCode === "number" ? probe.exitCode : 1;
  return exitCode === 0;
}

async function resolveProviderBootstrap(
  execaFn: ExecaFn,
  provider: ReviewAgentProvider,
  env: NodeJS.ProcessEnv,
): Promise<ProviderBootstrap> {
  const override = providerCommandOverride(provider, env);
  if (override) {
    return {
      provider,
      available: true,
      source: "env",
      commandOverride: override,
      binary: null,
    };
  }

  if (provider === "codex") {
    const available = await commandExists(execaFn, "codex");
    return {
      provider,
      available,
      source: available ? "bin" : null,
      commandOverride: null,
      binary: available ? "codex" : null,
    };
  }

  if (provider === "claude") {
    const hasClaude = await commandExists(execaFn, "claude");
    if (hasClaude) {
      return {
        provider,
        available: true,
        source: "bin",
        commandOverride: null,
        binary: "claude",
      };
    }

    const hasClaudeCode = await commandExists(execaFn, "claude-code");
    return {
      provider,
      available: hasClaudeCode,
      source: hasClaudeCode ? "bin" : null,
      commandOverride: null,
      binary: hasClaudeCode ? "claude-code" : null,
    };
  }

  const hasGemini = await commandExists(execaFn, "gemini");
  return {
    provider,
    available: hasGemini,
    source: hasGemini ? "bin" : null,
    commandOverride: null,
    binary: hasGemini ? "gemini" : null,
  };
}

function buildProviderPlan(params: {
  provider: ReviewAgentProvider;
  source: "flag" | "runtime" | "host" | "bin" | "env";
  bootstrap: ProviderBootstrap;
  runtimePath: string;
  autoMode: boolean;
  healedFromRuntime: ReviewAgentProvider | null;
  env: NodeJS.ProcessEnv;
}): ReviewAgentExecutionPlan {
  const resumeThreadId = params.provider === "codex" ? params.env.CODEX_THREAD_ID?.trim() || null : null;
  return {
    mode: "provider",
    provider: params.provider,
    source: params.source,
    providerBinary: params.bootstrap.binary,
    providerCommandOverride: params.bootstrap.commandOverride,
    runtimePath: params.runtimePath,
    autoMode: params.autoMode,
    resumeThreadId,
    healedFromRuntime: params.healedFromRuntime,
  };
}

export async function readPersistedReviewProvider(runtimePath = getRuntimePath()): Promise<PersistedReviewProvider | null> {
  try {
    const raw = await readFile(runtimePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = PersistedProviderSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function persistReviewProviderSelection(plan: ReviewAgentExecutionPlan): Promise<string | null> {
  if (plan.mode !== "provider" || !plan.autoMode) return null;
  const runtimePath = plan.runtimePath;
  const existing = await readPersistedReviewProvider(runtimePath);
  const now = new Date().toISOString();
  const next: PersistedReviewProvider = {
    version: 1,
    provider: plan.provider,
    source: plan.source === "runtime" ? "runtime" : plan.source === "host" ? "host" : plan.source === "env" ? "env" : "bin",
    detected_at: existing?.provider === plan.provider && existing.source === plan.source ? existing.detected_at : now,
    last_ok_at: now,
  };

  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return runtimePath;
}

export async function resolveReviewAgentExecutionPlan(
  params: ResolveReviewProviderPlanParams,
): Promise<ReviewAgentExecutionPlan> {
  const env = params.env ?? process.env;
  const runtimePath = getRuntimePath();

  const directCommand = params.agentCmdOption?.trim();
  if (directCommand) {
    return {
      mode: "command",
      provider: "command",
      source: "flag",
      command: directCommand,
      runtimePath,
      autoMode: false,
      resumeThreadId: null,
      healedFromRuntime: null,
    };
  }

  const envCommand = commandFromEnv(env);
  if (envCommand) {
    return {
      mode: "command",
      provider: "command",
      source: "env",
      command: envCommand,
      runtimePath,
      autoMode: false,
      resumeThreadId: null,
      healedFromRuntime: null,
    };
  }

  const rawProviderOption = params.agentProviderOption?.trim() ?? "";
  const normalizedProviderOption = normalizeProviderOption(rawProviderOption);
  if (rawProviderOption && !normalizedProviderOption) {
    throw new Error(`review: invalid --agent-provider. Use one of: ${REVIEW_AGENT_PROVIDER_VALUES.join(", ")}`);
  }
  const providerOption = normalizedProviderOption ?? "auto";

  const bootstrapCache = new Map<ReviewAgentProvider, Promise<ProviderBootstrap>>();
  const getBootstrap = (provider: ReviewAgentProvider): Promise<ProviderBootstrap> => {
    if (!bootstrapCache.has(provider)) {
      bootstrapCache.set(provider, resolveProviderBootstrap(params.execaFn, provider, env));
    }
    return bootstrapCache.get(provider)!;
  };

  if (providerOption === "command") {
    throw new Error("review: --agent-provider=command requires --agent-cmd or VIBE_REVIEW_AGENT_CMD.");
  }

  if (providerOption === "codex" || providerOption === "claude" || providerOption === "gemini") {
    const bootstrap = await getBootstrap(providerOption);
    if (!bootstrap.available) {
      throw new Error(`review: provider '${providerOption}' is not available in current environment.`);
    }
    return buildProviderPlan({
      provider: providerOption,
      source: "flag",
      bootstrap,
      runtimePath,
      autoMode: false,
      healedFromRuntime: null,
      env,
    });
  }

  const persisted = await readPersistedReviewProvider(runtimePath);
  let healedFromRuntime: ReviewAgentProvider | null = null;

  if (persisted) {
    const persistedBootstrap = await getBootstrap(persisted.provider);
    if (persistedBootstrap.available) {
      return buildProviderPlan({
        provider: persisted.provider,
        source: "runtime",
        bootstrap: persistedBootstrap,
        runtimePath,
        autoMode: true,
        healedFromRuntime: null,
        env,
      });
    }
    healedFromRuntime = persisted.provider;
  }

  const hostProvider = detectHostProvider(env);
  if (hostProvider) {
    const hostBootstrap = await getBootstrap(hostProvider);
    if (hostBootstrap.available) {
      return buildProviderPlan({
        provider: hostProvider,
        source: "host",
        bootstrap: hostBootstrap,
        runtimePath,
        autoMode: true,
        healedFromRuntime,
        env,
      });
    }
  }

  for (const provider of PROVIDER_PRIORITY) {
    const bootstrap = await getBootstrap(provider);
    if (!bootstrap.available) continue;
    return buildProviderPlan({
      provider,
      source: bootstrap.source === "env" ? "env" : "bin",
      bootstrap,
      runtimePath,
      autoMode: true,
      healedFromRuntime,
      env,
    });
  }

  throw new Error(
    "review: no agent provider available. Configure --agent-cmd / VIBE_REVIEW_AGENT_CMD or install codex/claude/gemini CLI.",
  );
}

export function getReviewProviderRuntimePath(): string {
  return getRuntimePath();
}
