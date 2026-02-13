import { z } from "zod";

export const PostflightSchemaV1 = z.object({
  version: z.literal(1),
  meta: z.object({
    timestamp: z.string().min(1),
    actor: z.enum(["user", "agent"]),
    mode: z.enum(["ui-byok", "external-llm", "cli", "codex-app", "claude-code"])
  }),
  work: z.object({
    issue_id: z.union([z.number().int().positive(), z.string().min(1)]),
    branch: z.string().min(1),
    base_branch: z.string().min(1),
    pr: z
      .object({
        created: z.boolean(),
        number: z.number().int().positive().nullable().optional(),
        url: z.string().url().nullable().optional()
      })
      .optional(),
    changes: z
      .array(
        z.object({
          file: z.string().min(1),
          summary: z.string().min(3)
        })
      )
      .optional()
  }),
  checks: z.object({
    git_status_clean: z.boolean().optional(),
    tests: z.object({
      ran: z.boolean(),
      command: z.string().nullable().optional(),
      result: z.enum(["pass", "fail", "skipped"])
    }),
    lint: z
      .object({
        ran: z.boolean(),
        command: z.string().nullable().optional(),
        result: z.enum(["pass", "fail", "skipped"])
      })
      .optional()
  }),
  tracker_updates: z.array(
    z.object({
      type: z.enum(["status", "comment_append", "label_add", "label_remove", "link_pr"]),
      to: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
      pr_number: z.number().int().positive().nullable().optional()
    })
  ).min(1),
  next_actions: z.array(z.string().min(3)).min(1),
  risks: z.object({
    summary: z.string().min(3),
    rollback_plan: z.string().min(3)
  })
});

export type PostflightV1 = z.infer<typeof PostflightSchemaV1>;
