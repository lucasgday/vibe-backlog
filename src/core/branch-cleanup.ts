import { execa } from "execa";

type ExecaFn = typeof execa;

export type BranchCleanupCategory = "merged" | "patch-equivalent" | "non-merged";
export type BranchCleanupStatus = "planned" | "deleted" | "skipped" | "error";

export type BranchCleanupCandidate = {
  branch: string;
  upstream: string | null;
  category: BranchCleanupCategory;
  deleteFlag: "-d" | "-D" | null;
  status: BranchCleanupStatus;
  reason: string | null;
  command: string | null;
};

export type BranchCleanupOptions = {
  dryRun: boolean;
  baseBranch?: string | null;
  forceUnmerged?: boolean;
  confirmForce?: boolean;
  fetchPrune?: boolean;
};

export type BranchCleanupResult = {
  dryRun: boolean;
  fetchPrune: boolean;
  baseRef: string;
  currentBranch: string;
  protectedBranches: string[];
  protectedSkipped: string[];
  detected: number;
  planned: number;
  deleted: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  candidates: BranchCleanupCandidate[];
  nonMergedBlocked: string[];
};

type BranchRefSnapshot = {
  branch: string;
  upstream: string | null;
  upstreamTrack: string;
};

type GitCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function runGitCommand(execaFn: ExecaFn, args: string[]): Promise<GitCommandResult> {
  const result = await execaFn("git", args, { stdio: "pipe", reject: false });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
  };
}

async function verifyGitRefExists(execaFn: ExecaFn, ref: string): Promise<boolean> {
  const verified = await runGitCommand(execaFn, ["rev-parse", "--verify", ref]);
  return verified.exitCode === 0;
}

async function resolveCurrentBranch(execaFn: ExecaFn): Promise<string> {
  const current = await runGitCommand(execaFn, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.exitCode !== 0) {
    throw new Error("branch cleanup: unable to resolve current branch.");
  }
  const branch = current.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("branch cleanup: unable to resolve current branch.");
  }
  return branch;
}

async function resolveBaseRef(execaFn: ExecaFn, baseOverride: string | null | undefined, warnings: string[]): Promise<string> {
  const normalizedOverride = typeof baseOverride === "string" ? baseOverride.trim() : "";
  if (normalizedOverride) {
    const overrideExists = await verifyGitRefExists(execaFn, normalizedOverride);
    if (!overrideExists) {
      throw new Error(`branch cleanup: base ref '${normalizedOverride}' does not exist.`);
    }
    return normalizedOverride;
  }

  const symbolic = await runGitCommand(execaFn, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic.exitCode === 0) {
    const symbolicRef = symbolic.stdout.trim();
    if (symbolicRef) {
      const symbolicExists = await verifyGitRefExists(execaFn, symbolicRef);
      if (symbolicExists) {
        return symbolicRef;
      }
      warnings.push(`branch cleanup: resolved origin/HEAD '${symbolicRef}' but the ref was not found; falling back to 'main'.`);
    }
  } else {
    const stderr = symbolic.stderr.trim();
    if (stderr) {
      warnings.push(`branch cleanup: unable to resolve origin/HEAD (${stderr}); falling back to 'main'.`);
    } else {
      warnings.push("branch cleanup: unable to resolve origin/HEAD; falling back to 'main'.");
    }
  }

  const mainExists = await verifyGitRefExists(execaFn, "main");
  if (!mainExists) {
    throw new Error("branch cleanup: unable to resolve cleanup base ref (origin/HEAD and 'main' are unavailable).");
  }
  return "main";
}

async function fetchPruneOrigin(execaFn: ExecaFn, warnings: string[]): Promise<void> {
  const fetched = await runGitCommand(execaFn, ["fetch", "--prune", "origin"]);
  if (fetched.exitCode === 0) return;

  const detail = fetched.stderr.trim() || fetched.stdout.trim();
  if (detail) {
    warnings.push(`branch cleanup: \`git fetch --prune origin\` failed; continuing with local metadata (${detail}).`);
    return;
  }
  warnings.push("branch cleanup: `git fetch --prune origin` failed; continuing with local metadata.");
}

function parseBranchSnapshots(stdout: string): BranchRefSnapshot[] {
  const rows: BranchRefSnapshot[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [branchRaw = "", upstreamRaw = "", trackRaw = ""] = line.split("\t");
    const branch = branchRaw.trim();
    if (!branch) continue;
    const upstream = upstreamRaw.trim() || null;
    const upstreamTrack = trackRaw.trim();
    rows.push({ branch, upstream, upstreamTrack });
  }

  return rows;
}

function toCommandString(args: string[]): string {
  return ["git", ...args].join(" ");
}

function isNotFullyMergedDeleteError(detail: string): boolean {
  return /\bnot fully merged\b/i.test(detail);
}

async function isMergedIntoBase(execaFn: ExecaFn, branch: string, baseRef: string): Promise<boolean> {
  const merged = await runGitCommand(execaFn, ["merge-base", "--is-ancestor", branch, baseRef]);
  if (merged.exitCode === 0) return true;
  if (merged.exitCode === 1) return false;
  throw new Error(`branch cleanup: unable to compare merge ancestry for '${branch}' against '${baseRef}'.`);
}

async function isPatchEquivalent(execaFn: ExecaFn, branch: string, baseRef: string): Promise<boolean> {
  const cherry = await runGitCommand(execaFn, ["cherry", baseRef, branch]);
  if (cherry.exitCode !== 0) {
    throw new Error(`branch cleanup: unable to compare patch equivalence for '${branch}' against '${baseRef}'.`);
  }

  const lines = cherry.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasPlus = lines.some((line) => line.startsWith("+"));
  return !hasPlus;
}

function resolveProtectedBranches(currentBranch: string, baseRef: string): string[] {
  const protectedSet = new Set<string>(["main", currentBranch, baseRef]);
  if (baseRef.startsWith("origin/")) {
    const localBase = baseRef.slice("origin/".length).trim();
    if (localBase) {
      protectedSet.add(localBase);
    }
  }
  return Array.from(protectedSet).filter(Boolean).sort((left, right) => left.localeCompare(right));
}

export async function runBranchCleanup(
  options: BranchCleanupOptions,
  execaFn: ExecaFn = execa,
): Promise<BranchCleanupResult> {
  const dryRun = Boolean(options.dryRun);
  const forceUnmerged = Boolean(options.forceUnmerged);
  const confirmForce = Boolean(options.confirmForce);
  const shouldFetchPrune = options.fetchPrune !== false && !dryRun;

  if (forceUnmerged && !confirmForce) {
    throw new Error("branch cleanup: --force-unmerged requires --yes.");
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: BranchCleanupCandidate[] = [];
  const nonMergedBlocked: string[] = [];
  const protectedSkipped: string[] = [];

  const currentBranch = await resolveCurrentBranch(execaFn);
  const baseRef = await resolveBaseRef(execaFn, options.baseBranch, warnings);
  const protectedBranches = resolveProtectedBranches(currentBranch, baseRef);
  const protectedBranchSet = new Set(protectedBranches);

  if (shouldFetchPrune) {
    await fetchPruneOrigin(execaFn, warnings);
  }

  const listed = await runGitCommand(execaFn, [
    "for-each-ref",
    "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
    "refs/heads",
  ]);
  if (listed.exitCode !== 0) {
    throw new Error("branch cleanup: unable to list local branches.");
  }

  const snapshots = parseBranchSnapshots(listed.stdout);
  const goneSnapshots = snapshots.filter((snapshot) => /\bgone\b/i.test(snapshot.upstreamTrack));

  for (const snapshot of goneSnapshots) {
    if (protectedBranchSet.has(snapshot.branch)) {
      protectedSkipped.push(snapshot.branch);
      continue;
    }

    let category: BranchCleanupCategory = "non-merged";
    try {
      const merged = await isMergedIntoBase(execaFn, snapshot.branch, baseRef);
      if (merged) {
        category = "merged";
      } else {
        const patchEquivalent = await isPatchEquivalent(execaFn, snapshot.branch, baseRef);
        category = patchEquivalent ? "patch-equivalent" : "non-merged";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      candidates.push({
        branch: snapshot.branch,
        upstream: snapshot.upstream,
        category,
        deleteFlag: null,
        status: "error",
        reason: message,
        command: null,
      });
      continue;
    }

    let deleteFlag: "-d" | "-D" | null = null;
    if (category === "merged") {
      deleteFlag = "-d";
    } else if (category === "patch-equivalent") {
      deleteFlag = "-D";
    } else if (forceUnmerged) {
      deleteFlag = "-D";
    } else {
      const reason = "requires --force-unmerged --yes";
      nonMergedBlocked.push(snapshot.branch);
      candidates.push({
        branch: snapshot.branch,
        upstream: snapshot.upstream,
        category,
        deleteFlag: null,
        status: "skipped",
        reason,
        command: null,
      });
      continue;
    }

    const deleteArgs = ["branch", deleteFlag, snapshot.branch];
    const command = toCommandString(deleteArgs);

    if (dryRun) {
      candidates.push({
        branch: snapshot.branch,
        upstream: snapshot.upstream,
        category,
        deleteFlag,
        status: "planned",
        reason: null,
        command,
      });
      continue;
    }

    const deleted = await runGitCommand(execaFn, deleteArgs);
    if (deleted.exitCode === 0) {
      candidates.push({
        branch: snapshot.branch,
        upstream: snapshot.upstream,
        category,
        deleteFlag,
        status: "deleted",
        reason: null,
        command,
      });
      continue;
    }

    const deleteDetail = deleted.stderr.trim() || deleted.stdout.trim() || "unknown git error";
    if (category === "merged" && deleteFlag === "-d" && isNotFullyMergedDeleteError(deleteDetail)) {
      const forceDeleteArgs = ["branch", "-D", snapshot.branch];
      const forceDeleted = await runGitCommand(execaFn, forceDeleteArgs);
      if (forceDeleted.exitCode === 0) {
        candidates.push({
          branch: snapshot.branch,
          upstream: snapshot.upstream,
          category,
          deleteFlag: "-D",
          status: "deleted",
          reason: null,
          command: toCommandString(forceDeleteArgs),
        });
        continue;
      }

      const forceDetail = forceDeleted.stderr.trim() || forceDeleted.stdout.trim() || "unknown git error";
      const reason = `delete failed: ${forceDetail}`;
      errors.push(`branch cleanup: unable to delete '${snapshot.branch}' (${forceDetail}).`);
      candidates.push({
        branch: snapshot.branch,
        upstream: snapshot.upstream,
        category,
        deleteFlag: "-D",
        status: "error",
        reason,
        command: toCommandString(forceDeleteArgs),
      });
      continue;
    }

    const detail = deleteDetail;
    const reason = `delete failed: ${detail}`;
    errors.push(`branch cleanup: unable to delete '${snapshot.branch}' (${detail}).`);
    candidates.push({
      branch: snapshot.branch,
      upstream: snapshot.upstream,
      category,
      deleteFlag,
      status: "error",
      reason,
      command,
    });
  }

  const planned = candidates.filter((candidate) => candidate.status === "planned").length;
  const deleted = candidates.filter((candidate) => candidate.status === "deleted").length;
  const skipped = candidates.filter((candidate) => candidate.status === "skipped").length + protectedSkipped.length;

  return {
    dryRun,
    fetchPrune: shouldFetchPrune,
    baseRef,
    currentBranch,
    protectedBranches,
    protectedSkipped: protectedSkipped.sort((left, right) => left.localeCompare(right)),
    detected: candidates.length,
    planned,
    deleted,
    skipped,
    errors,
    warnings,
    candidates,
    nonMergedBlocked: nonMergedBlocked.sort((left, right) => left.localeCompare(right)),
  };
}
