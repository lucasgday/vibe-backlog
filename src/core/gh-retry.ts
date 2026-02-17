import { execa } from "execa";

type ExecaFn = typeof execa;
type ExecaOptions = Record<string, unknown>;

export type GhCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const DEFAULT_BACKOFF_MS = [250, 750, 1500] as const;

export type GhRetryOptions = {
  attempts?: number;
  backoffMs?: number[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const execaError = error as Error & {
    stderr?: unknown;
    stdout?: unknown;
    shortMessage?: unknown;
    message?: unknown;
  };

  const parts: string[] = [];
  if (typeof execaError.message === "string" && execaError.message.trim()) parts.push(execaError.message);
  if (typeof execaError.shortMessage === "string" && execaError.shortMessage.trim()) parts.push(execaError.shortMessage);
  if (typeof execaError.stderr === "string" && execaError.stderr.trim()) parts.push(execaError.stderr);
  if (typeof execaError.stdout === "string" && execaError.stdout.trim()) parts.push(execaError.stdout);
  return parts.join("\n");
}

export function isRetryableGhError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  if (!text) return false;

  return (
    text.includes("error connecting to api.github.com") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("connection reset") ||
    text.includes("temporary failure") ||
    /\b502\b/.test(text) ||
    /\b503\b/.test(text) ||
    /\b504\b/.test(text)
  );
}

export async function runGhWithRetry(
  execaFn: ExecaFn,
  args: string[],
  execaOptions: ExecaOptions = { stdio: "pipe" },
  options: GhRetryOptions = {},
): Promise<GhCommandResult> {
  const backoff = options.backoffMs && options.backoffMs.length > 0 ? options.backoffMs : Array.from(DEFAULT_BACKOFF_MS);
  const attempts = Math.max(1, Math.trunc(options.attempts ?? backoff.length));

  let lastError: unknown;
  const invokeGh = execaFn as unknown as (
    file: string,
    args: string[],
    options?: ExecaOptions,
  ) => Promise<{ stdout?: unknown; stderr?: unknown; exitCode?: unknown }>;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await invokeGh("gh", args, execaOptions);
      return {
        stdout: typeof response.stdout === "string" ? response.stdout : "",
        stderr: typeof response.stderr === "string" ? response.stderr : "",
        exitCode: typeof response.exitCode === "number" ? response.exitCode : 0,
      };
    } catch (error) {
      lastError = error;
      const canRetry = attempt < attempts && isRetryableGhError(error);
      if (!canRetry) {
        throw error;
      }

      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("gh retry: command failed");
}
