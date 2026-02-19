import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { runGhWithRetry } from "./gh-retry";

type ExecaFn = typeof execa;

export type CreateIssueWithBodyFileParams = {
  execaFn: ExecaFn;
  title: string;
  body: string;
  labels?: string[];
  milestoneTitle?: string | null;
};

export async function createIssueWithBodyFile(params: CreateIssueWithBodyFileParams) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vibe-issue-body-"));
  const bodyFilePath = path.join(tempDir, "body.md");

  try {
    await writeFile(bodyFilePath, params.body, "utf8");

    const args = ["issue", "create", "--title", params.title, "--body-file", bodyFilePath];
    for (const label of params.labels ?? []) {
      args.push("--label", label);
    }
    if (params.milestoneTitle) {
      args.push("--milestone", params.milestoneTitle);
    }

    return await runGhWithRetry(params.execaFn, args, { stdio: "pipe" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
