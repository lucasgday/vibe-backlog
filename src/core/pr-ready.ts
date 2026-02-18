import { execa } from "execa";
import { runGhWithRetry } from "./gh-retry";
import { hasReviewForHead, PR_OPEN_REVIEW_GATE_POLICY_KEY, resolveRepoNameWithOwner } from "./review-pr";

type ExecaFn = typeof execa;
type JsonRecord = Record<string, unknown>;

const DEFAULT_POLL_INTERVAL_MS = 2000;
export const PR_READY_REMEDIATION_WAIT_SECONDS = 30;
export const PR_READY_FREEZE_GUIDANCE =
  "Freeze branch now: do not run `vibe review`, `vibe pr open`, or push commits before merge.";

export type PrReadyCommandOptions = {
  prNumber: number | null;
  branchOverride: string | null;
  refresh: boolean;
  waitSeconds: number;
};

export type PrReadyCheckStatus = "pass" | "fail" | "skip";

export type PrReadyCheck = {
  id: "target-pr" | "pr-open" | "pr-not-draft" | "merge-state-clean" | "head-sync" | "review-marker";
  label: string;
  status: PrReadyCheckStatus;
  detail: string;
};

export type PrReadyResult = {
  ready: boolean;
  exitCode: 0 | 1;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  mergeStateStatus: string | null;
  checks: PrReadyCheck[];
  remediationCommand: string | null;
  freezeGuidance: string;
};

type PrReadyRuntimeOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
};

type OpenPrResolution =
  | {
      state: "resolved";
      prNumber: number;
      prUrl: string | null;
    }
  | {
      state: "none";
      detail: string;
    }
  | {
      state: "multiple";
      detail: string;
    };

type PrSnapshot = {
  number: number;
  url: string | null;
  state: string | null;
  isDraft: boolean;
  headRefName: string | null;
  headRefOid: string | null;
  baseRefName: string | null;
  mergeStateStatus: string | null;
};

type ClockRuntime = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
};

function parseJsonArray(stdout: string, context: string): JsonRecord[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected array response`);
  }
  return parsed.filter((value): value is JsonRecord => typeof value === "object" && value !== null);
}

function parseJsonObject(stdout: string, context: string): JsonRecord {
  const parsed = JSON.parse(stdout) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${context}: expected object response`);
  }
  return parsed as JsonRecord;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function parsePositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeWaitSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value);
  return normalized < 0 ? 0 : normalized;
}

function buildRuntime(options?: PrReadyRuntimeOptions): ClockRuntime {
  return {
    now: options?.now ?? (() => Date.now()),
    sleep:
      options?.sleep ??
      ((ms: number) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        })),
    pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  };
}

function buildRemediationCommand(prNumber: number): string {
  return `node dist/cli.cjs pr ready --pr ${prNumber} --refresh --wait-seconds ${PR_READY_REMEDIATION_WAIT_SECONDS}`;
}

async function resolveCurrentBranch(execaFn: ExecaFn): Promise<string> {
  const response = await execaFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" });
  const branch = response.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("pr ready: unable to resolve current git branch");
  }
  return branch;
}

async function resolveOpenPrByBranch(execaFn: ExecaFn, branch: string): Promise<OpenPrResolution> {
  const response = await runGhWithRetry(
    execaFn,
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"],
    { stdio: "pipe" },
  );
  const rows = parseJsonArray(response.stdout, "gh pr list");
  const prs = rows
    .map((row) => {
      const number = parsePositiveInt(row.number);
      if (!number) return null;
      return {
        number,
        url: parseNullableString(row.url),
      };
    })
    .filter((entry): entry is { number: number; url: string | null } => entry !== null);

  if (!prs.length) {
    return {
      state: "none",
      detail: `no open PR found for branch '${branch}'`,
    };
  }

  if (prs.length > 1) {
    const summary = prs.map((entry) => `#${entry.number}`).join(", ");
    return {
      state: "multiple",
      detail: `multiple open PRs found for branch '${branch}': ${summary}`,
    };
  }

  return {
    state: "resolved",
    prNumber: prs[0].number,
    prUrl: prs[0].url,
  };
}

async function fetchPullRequestSnapshot(execaFn: ExecaFn, prNumber: number): Promise<PrSnapshot> {
  const response = await runGhWithRetry(
    execaFn,
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus",
    ],
    { stdio: "pipe" },
  );
  const row = parseJsonObject(response.stdout, "gh pr view");
  const number = parsePositiveInt(row.number) ?? prNumber;
  return {
    number,
    url: parseNullableString(row.url),
    state: parseNullableString(row.state)?.toUpperCase() ?? null,
    isDraft: Boolean(row.isDraft),
    headRefName: parseNullableString(row.headRefName),
    headRefOid: parseNullableString(row.headRefOid)?.toLowerCase() ?? null,
    baseRefName: parseNullableString(row.baseRefName),
    mergeStateStatus: parseNullableString(row.mergeStateStatus)?.toUpperCase() ?? null,
  };
}

async function waitForMergeStateClean(params: {
  execaFn: ExecaFn;
  prNumber: number;
  initial: PrSnapshot;
  waitSeconds: number;
  runtime: ClockRuntime;
}): Promise<PrSnapshot> {
  const { execaFn, prNumber, initial, waitSeconds, runtime } = params;
  if (initial.mergeStateStatus !== "UNKNOWN" || waitSeconds <= 0) {
    return initial;
  }

  const deadline = runtime.now() + waitSeconds * 1000;
  let snapshot = initial;

  while (snapshot.mergeStateStatus === "UNKNOWN" && runtime.now() < deadline) {
    const remainingMs = deadline - runtime.now();
    const sleepMs = Math.max(1, Math.min(runtime.pollIntervalMs, remainingMs));
    await runtime.sleep(sleepMs);
    snapshot = await fetchPullRequestSnapshot(execaFn, prNumber);
  }

  return snapshot;
}

async function resolveRemoteBranchHeadSha(execaFn: ExecaFn, branch: string): Promise<string | null> {
  const response = await execaFn("git", ["ls-remote", "--heads", "origin", branch], { stdio: "pipe" });
  const targetRef = `refs/heads/${branch}`;

  for (const rawLine of response.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [sha = "", ref = ""] = parts;
    if (ref !== targetRef) continue;
    if (!sha) continue;
    return sha.toLowerCase();
  }

  return null;
}

function buildSkippedChecks(detail: string): PrReadyCheck[] {
  return [
    {
      id: "pr-open",
      label: "PR state is OPEN",
      status: "skip",
      detail,
    },
    {
      id: "pr-not-draft",
      label: "PR is not draft",
      status: "skip",
      detail,
    },
    {
      id: "merge-state-clean",
      label: "mergeStateStatus is CLEAN",
      status: "skip",
      detail,
    },
    {
      id: "head-sync",
      label: "remote head matches PR headRefOid",
      status: "skip",
      detail,
    },
    {
      id: "review-marker",
      label: "review marker exists for current head/policy",
      status: "skip",
      detail,
    },
  ];
}

function evaluateReadiness(checks: PrReadyCheck[]): boolean {
  return checks.every((check) => check.status === "pass");
}

export async function runPrReadyCommand(
  options: PrReadyCommandOptions,
  execaFn: ExecaFn = execa,
  runtimeOptions: PrReadyRuntimeOptions = {},
): Promise<PrReadyResult> {
  const runtime = buildRuntime(runtimeOptions);
  const waitSeconds = normalizeWaitSeconds(options.waitSeconds);
  const checks: PrReadyCheck[] = [];

  if (options.refresh) {
    await execaFn("git", ["fetch", "origin"], { stdio: "pipe" });
  }

  let prNumber = options.prNumber;
  let branchFromLookup: string | null = null;
  let prUrl: string | null = null;

  if (!prNumber) {
    const branch = options.branchOverride?.trim() ? options.branchOverride.trim() : await resolveCurrentBranch(execaFn);
    branchFromLookup = branch;
    const resolved = await resolveOpenPrByBranch(execaFn, branch);
    if (resolved.state !== "resolved") {
      checks.push({
        id: "target-pr",
        label: "target PR resolves to exactly one OPEN PR",
        status: "fail",
        detail: resolved.detail,
      });
      checks.push(...buildSkippedChecks("target PR did not resolve"));
      return {
        ready: false,
        exitCode: 1,
        prNumber: null,
        prUrl: null,
        branch: branchFromLookup,
        baseBranch: null,
        headSha: null,
        mergeStateStatus: null,
        checks,
        remediationCommand: null,
        freezeGuidance: PR_READY_FREEZE_GUIDANCE,
      };
    }

    prNumber = resolved.prNumber;
    prUrl = resolved.prUrl;
    checks.push({
      id: "target-pr",
      label: "target PR resolves to exactly one OPEN PR",
      status: "pass",
      detail: `resolved to #${resolved.prNumber}${resolved.prUrl ? ` (${resolved.prUrl})` : ""}`,
    });
  } else {
    checks.push({
      id: "target-pr",
      label: "target PR resolves to exactly one OPEN PR",
      status: "pass",
      detail: `using --pr #${prNumber}`,
    });
  }

  const snapshot = await fetchPullRequestSnapshot(execaFn, prNumber);
  prUrl = snapshot.url ?? prUrl;

  checks.push({
    id: "pr-open",
    label: "PR state is OPEN",
    status: snapshot.state === "OPEN" ? "pass" : "fail",
    detail: `state=${snapshot.state ?? "UNKNOWN"}`,
  });

  checks.push({
    id: "pr-not-draft",
    label: "PR is not draft",
    status: snapshot.isDraft ? "fail" : "pass",
    detail: snapshot.isDraft ? "isDraft=true" : "isDraft=false",
  });

  const snapshotAfterWait = await waitForMergeStateClean({
    execaFn,
    prNumber,
    initial: snapshot,
    waitSeconds,
    runtime,
  });

  const mergeStateStatus = snapshotAfterWait.mergeStateStatus;
  checks.push({
    id: "merge-state-clean",
    label: "mergeStateStatus is CLEAN",
    status: mergeStateStatus === "CLEAN" ? "pass" : "fail",
    detail:
      mergeStateStatus === "CLEAN"
        ? "mergeStateStatus=CLEAN"
        : `mergeStateStatus=${mergeStateStatus ?? "UNKNOWN"}${waitSeconds > 0 ? ` after waiting ${waitSeconds}s` : ""}`,
  });

  const headRefName = snapshotAfterWait.headRefName;
  const headRefOid = snapshotAfterWait.headRefOid;
  let headSyncFailed = false;
  if (!headRefName || !headRefOid) {
    headSyncFailed = true;
    checks.push({
      id: "head-sync",
      label: "remote head matches PR headRefOid",
      status: "fail",
      detail: "missing headRefName/headRefOid on PR snapshot",
    });
  } else {
    const remoteHead = await resolveRemoteBranchHeadSha(execaFn, headRefName);
    if (!remoteHead) {
      headSyncFailed = true;
      checks.push({
        id: "head-sync",
        label: "remote head matches PR headRefOid",
        status: "fail",
        detail: `remote branch origin/${headRefName} not found`,
      });
    } else if (remoteHead !== headRefOid) {
      headSyncFailed = true;
      checks.push({
        id: "head-sync",
        label: "remote head matches PR headRefOid",
        status: "fail",
        detail: `head mismatch: pr=${headRefOid.slice(0, 12)} remote=${remoteHead.slice(0, 12)}`,
      });
    } else {
      checks.push({
        id: "head-sync",
        label: "remote head matches PR headRefOid",
        status: "pass",
        detail: `headRefOid=${headRefOid.slice(0, 12)}`,
      });
    }
  }

  if (!headRefOid) {
    checks.push({
      id: "review-marker",
      label: "review marker exists for current head/policy",
      status: "fail",
      detail: "missing headRefOid for review marker verification",
    });
  } else {
    const repo = await resolveRepoNameWithOwner(execaFn);
    const reviewGateSatisfied = await hasReviewForHead(execaFn, repo, prNumber, headRefOid, {
      policyKey: PR_OPEN_REVIEW_GATE_POLICY_KEY,
    });
    if (reviewGateSatisfied) {
      checks.push({
        id: "review-marker",
        label: "review marker exists for current head/policy",
        status: "pass",
        detail: `review marker found for HEAD ${headRefOid.slice(0, 12)}`,
      });
    } else {
      checks.push({
        id: "review-marker",
        label: "review marker exists for current head/policy",
        status: "fail",
        detail: `review marker missing for HEAD ${headRefOid.slice(0, 12)} policy=${PR_OPEN_REVIEW_GATE_POLICY_KEY}`,
      });
    }
  }

  const ready = evaluateReadiness(checks);
  const staleOrUnknownOrDesyncFailure =
    checks.some((check) => check.id === "merge-state-clean" && check.status === "fail") || headSyncFailed;
  const remediationCommand =
    !ready && staleOrUnknownOrDesyncFailure && prNumber ? buildRemediationCommand(prNumber) : null;

  return {
    ready,
    exitCode: ready ? 0 : 1,
    prNumber,
    prUrl,
    branch: snapshotAfterWait.headRefName ?? branchFromLookup,
    baseBranch: snapshotAfterWait.baseRefName,
    headSha: headRefOid,
    mergeStateStatus: snapshotAfterWait.mergeStateStatus,
    checks,
    remediationCommand,
    freezeGuidance: PR_READY_FREEZE_GUIDANCE,
  };
}
