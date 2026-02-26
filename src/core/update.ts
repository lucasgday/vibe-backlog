type ExecaLike = (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

export type ToolUpdateCheckStatus = "update-available" | "up-to-date" | "unavailable";

export type ToolUpdateCheckResult = {
  status: ToolUpdateCheckStatus;
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  command: string[];
  reason: string;
};

export type ToolSelfUpdateRunResult = {
  check: ToolUpdateCheckResult;
  dryRun: boolean;
  checkOnly: boolean;
  executed: boolean;
};

function buildSelfUpdateArgs(packageName: string): string[] {
  return ["install", "-g", `${packageName}@latest`];
}

function parseNpmViewVersion(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed.trim();
    }
    if (Array.isArray(parsed)) {
      const last = [...parsed].reverse().find((item) => typeof item === "string" && item.trim());
      return typeof last === "string" ? last.trim() : null;
    }
  } catch {
    // Fall back to plain text parsing.
  }

  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken ? firstToken.trim() : null;
}

function parseSemver(input: string): ParsedSemver | null {
  const trimmed = input.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(trimmed);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;

  return {
    major,
    minor,
    patch,
    prerelease: match[4] ?? null,
  };
}

function compareSemver(a: string, b: string): number | null {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return null;

  if (parsedA.major !== parsedB.major) return parsedA.major > parsedB.major ? 1 : -1;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor > parsedB.minor ? 1 : -1;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch > parsedB.patch ? 1 : -1;

  if (parsedA.prerelease === parsedB.prerelease) return 0;
  if (parsedA.prerelease === null) return 1;
  if (parsedB.prerelease === null) return -1;
  return parsedA.prerelease > parsedB.prerelease ? 1 : parsedA.prerelease < parsedB.prerelease ? -1 : 0;
}

export async function checkToolUpdate(
  options: { packageName: string; currentVersion: string; timeoutMs?: number | null },
  execaFn: ExecaLike,
): Promise<ToolUpdateCheckResult> {
  const command = ["npm", ...buildSelfUpdateArgs(options.packageName)];
  const execaOptions: Record<string, unknown> = { stdio: "pipe" };
  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    execaOptions.timeout = Math.trunc(options.timeoutMs);
  }

  try {
    const response = await execaFn("npm", ["view", options.packageName, "version", "--json"], execaOptions);
    const latestVersion = parseNpmViewVersion(String(response.stdout ?? ""));
    if (!latestVersion) {
      return {
        status: "unavailable",
        packageName: options.packageName,
        currentVersion: options.currentVersion,
        latestVersion: null,
        command,
        reason: "Version registry response was empty or unparseable.",
      };
    }

    const comparison = compareSemver(latestVersion, options.currentVersion);
    if (comparison === null) {
      return {
        status: "unavailable",
        packageName: options.packageName,
        currentVersion: options.currentVersion,
        latestVersion,
        command,
        reason: `Could not compare versions (${options.currentVersion} vs ${latestVersion}).`,
      };
    }

    if (comparison > 0) {
      return {
        status: "update-available",
        packageName: options.packageName,
        currentVersion: options.currentVersion,
        latestVersion,
        command,
        reason: `Newer version available: ${options.currentVersion} -> ${latestVersion}.`,
      };
    }

    return {
      status: "up-to-date",
      packageName: options.packageName,
      currentVersion: options.currentVersion,
      latestVersion,
      command,
      reason: `Current version ${options.currentVersion} is up to date.`,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : "Version check failed.";
    return {
      status: "unavailable",
      packageName: options.packageName,
      currentVersion: options.currentVersion,
      latestVersion: null,
      command,
      reason,
    };
  }
}

export async function runToolSelfUpdate(
  options: {
    packageName: string;
    currentVersion: string;
    dryRun: boolean;
    checkOnly: boolean;
    execStdio?: "inherit" | "pipe";
    checkTimeoutMs?: number | null;
  },
  execaFn: ExecaLike,
): Promise<ToolSelfUpdateRunResult> {
  const check = await checkToolUpdate(
    {
      packageName: options.packageName,
      currentVersion: options.currentVersion,
      timeoutMs: options.checkTimeoutMs ?? null,
    },
    execaFn,
  );

  const shouldExecute =
    !options.checkOnly && !options.dryRun && check.status === "update-available" && check.command.length >= 2;

  if (shouldExecute) {
    await execaFn(check.command[0]!, check.command.slice(1), { stdio: options.execStdio ?? "inherit" });
  }

  return {
    check,
    dryRun: options.dryRun,
    checkOnly: options.checkOnly,
    executed: shouldExecute,
  };
}
