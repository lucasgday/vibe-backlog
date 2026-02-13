import { z } from "zod";

export const PostflightSchemaV1 = z.object({
  version: z.literal(1),
  meta: z.object({
    timestamp: z.string().min(1),
    actor: z.enum(["user", "agent"]),
    mode: z.enum(["ui-byok", "external-llm", "cli", "codex-app", "claude-code"])
  }),
  work: z
    .object({
      issue_id: z.union([z.number().int().positive(), z.string().min(1)]),
      branch: z.string().min(1),
      base_branch: z.string().min(1)
    })
    .passthrough(),
  checks: z
    .object({
      tests: z.object({
        ran: z.boolean(),
        command: z.string().nullable().optional(),
        result: z.enum(["pass", "fail", "skipped"])
      })
    })
    .passthrough(),
  tracker_updates: z
    .array(
      z.object({
        type: z.enum(["status", "comment_append", "label_add", "label_remove", "link_pr", "issue_close"]),
        to: z.string().nullable().optional(),
        body: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
        pr_number: z.number().int().positive().nullable().optional()
      })
    )
    .min(1),
  next_actions: z.array(z.string().min(3)).min(1),
  risks: z.object({
    summary: z.string().min(3),
    rollback_plan: z.string().min(3)
  })
});

export type PostflightV1 = z.infer<typeof PostflightSchemaV1>;

export type GhCommand = {
  cmd: "gh";
  args: string[];
};

export function normalizeGitHubIssueId(value: string | number): string | null {
  const issueId = typeof value === "number" ? String(value) : String(value).trim();
  return /^[0-9]+$/.test(issueId) ? issueId : null;
}

export function buildTrackerCommands(issueId: string, updates: PostflightV1["tracker_updates"]): GhCommand[] {
  const cmds: GhCommand[] = [];

  for (const update of updates) {
    if (update.type === "comment_append") {
      const body = update.body ?? "";
      if (body.trim()) cmds.push({ cmd: "gh", args: ["issue", "comment", issueId, "--body", body] });
    }

    if (update.type === "label_add") {
      const label = update.label ?? "";
      if (label.trim()) cmds.push({ cmd: "gh", args: ["issue", "edit", issueId, "--add-label", label] });
    }

    if (update.type === "label_remove") {
      const label = update.label ?? "";
      if (label.trim()) cmds.push({ cmd: "gh", args: ["issue", "edit", issueId, "--remove-label", label] });
    }

    if (update.type === "status") {
      const to = update.to ?? "";
      if (to.trim()) cmds.push({ cmd: "gh", args: ["issue", "edit", issueId, "--add-label", to] });
    }

    if (update.type === "link_pr") {
      const prNumber = update.pr_number ?? null;
      if (prNumber) cmds.push({ cmd: "gh", args: ["issue", "comment", issueId, "--body", `Linked PR: #${prNumber}`] });
    }

    if (update.type === "issue_close") {
      const closeComment = update.body?.trim();
      if (closeComment) {
        cmds.push({ cmd: "gh", args: ["issue", "close", issueId, "--comment", closeComment] });
      } else {
        cmds.push({ cmd: "gh", args: ["issue", "close", issueId] });
      }
    }
  }

  return cmds;
}
