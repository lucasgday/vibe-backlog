import { execa } from "execa";

type ExecaFn = typeof execa;

function parseNameOnlyStdout(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function resolveExistingGitRef(execaFn: ExecaFn, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const ref = candidate.trim();
    if (!ref) continue;

    try {
      const response = await execaFn("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "pipe" });
      if (response.stdout.trim()) {
        return ref;
      }
    } catch {
      // Probe next candidate.
    }
  }

  return null;
}

export async function listChangedFilesForRationale(
  execaFn: ExecaFn,
  params: { baseBranch: string; branch: string },
): Promise<string[]> {
  const baseRef = await resolveExistingGitRef(execaFn, [`origin/${params.baseBranch}`, params.baseBranch]);
  const headRef = await resolveExistingGitRef(execaFn, [params.branch, "HEAD"]);

  const candidateArgs: string[][] = [];
  if (baseRef && headRef) {
    candidateArgs.push(["diff", "--name-only", `${baseRef}...${headRef}`]);
    if (headRef !== "HEAD") {
      candidateArgs.push(["diff", "--name-only", `${baseRef}...HEAD`]);
    }
  }
  candidateArgs.push(["diff", "--name-only", "--cached"]);

  for (const args of candidateArgs) {
    try {
      const response = await execaFn("git", args, { stdio: "pipe" });
      const files = parseNameOnlyStdout(response.stdout);
      if (files.length > 0) return files;
    } catch {
      // Best-effort signal extraction; callers handle fallback rationale wording.
    }
  }

  return [];
}

