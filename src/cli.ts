#!/usr/bin/env node
import { Command } from "commander";
import { execa } from "execa";
import { PostflightSchemaV1 } from "./core/postflight";
import { buildTurnBranch, clearTurnContext, readTurnContext, writeTurnContext } from "./core/turn";

const program = new Command();

program.name("vibe").description("Vibe-backlog CLI (MVP)").version("0.1.0");

async function issueTitleFromGitHub(issueId: number): Promise<string> {
  try {
    const issue = await execa("gh", ["issue", "view", String(issueId), "--json", "title", "-q", ".title"], {
      stdio: "pipe",
    });
    const title = issue.stdout.trim();
    if (title) {
      return title;
    }
  } catch {
    // Fall back below when gh is unavailable or issue doesn't exist.
  }

  return `issue-${issueId}`;
}

async function checkoutOrCreateBranch(branch: string): Promise<void> {
  const probe = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    stdio: "pipe",
    reject: false,
  });

  if (probe.exitCode === 0) {
    await execa("git", ["checkout", branch], { stdio: "inherit" });
    return;
  }

  await execa("git", ["checkout", "-b", branch], { stdio: "inherit" });
}

const turn = program.command("turn").description("Manage active local turn context");

turn
  .command("start")
  .description("Start a turn from an issue number")
  .requiredOption("--issue <n>", "GitHub issue number")
  .action(async (opts) => {
    const issueId = Number.parseInt(String(opts.issue), 10);

    if (!Number.isInteger(issueId) || issueId <= 0) {
      console.error("turn start: --issue debe ser un entero positivo.");
      process.exitCode = 1;
      return;
    }

    try {
      const issueTitle = await issueTitleFromGitHub(issueId);
      const branch = buildTurnBranch(issueId, issueTitle);

      await checkoutOrCreateBranch(branch);

      const turnContext = {
        issue_id: issueId,
        branch,
        base_branch: "main",
        started_at: new Date().toISOString(),
        issue_title: issueTitle,
      };

      await writeTurnContext(turnContext);
      console.log(JSON.stringify(turnContext, null, 2));
    } catch (error) {
      console.error("turn start: ERROR");
      console.error(error);
      process.exitCode = 1;
    }
  });

turn
  .command("show")
  .description("Show active turn context")
  .action(async () => {
    try {
      const activeTurn = await readTurnContext();
      if (!activeTurn) {
        console.log("no active turn");
        return;
      }

      console.log(JSON.stringify(activeTurn, null, 2));
    } catch (error) {
      console.error("turn show: ERROR");
      console.error(error);
      process.exitCode = 1;
    }
  });

turn
  .command("end")
  .description("End active turn context")
  .action(async () => {
    try {
      const deleted = await clearTurnContext();
      if (!deleted) {
        console.log("no active turn");
        return;
      }

      console.log("turn ended");
    } catch (error) {
      console.error("turn end: ERROR");
      console.error(error);
      process.exitCode = 1;
    }
  });

program
  .command("preflight")
  .description("Show git + GitHub issue snapshot")
  .action(async () => {
    try {
      const git = await execa("git", ["status", "-sb"], { stdio: "pipe" });
      console.log(git.stdout);
    } catch {
      console.log("git status: (not available)");
    }

    try {
      const issues = await execa("gh", ["issue", "list", "-L", "10"], { stdio: "pipe" });
      console.log("\nOpen issues (top 10):");
      console.log(issues.stdout);
    } catch (e) {
      console.log("\nOpen issues: (gh issue list not available here)");
      if (e instanceof Error) console.log(String(e.message || e));
    }
  });

program
  .command("postflight")
  .description("Validate postflight artifact")
  .option("-f, --file <path>", "Path to postflight JSON", ".vibe/artifacts/postflight.json")
  .option("--apply", "Apply tracker updates using gh", false)
  .option("--dry-run", "Print gh commands without executing them", false)
  .action(async (opts) => {
    const fs = await import("node:fs/promises");

    try {
      const raw = await fs.readFile(opts.file, "utf8");
      const json = JSON.parse(raw);

      if (opts.apply) {
        const activeTurn = await readTurnContext();
        if (activeTurn) {
          const work =
            typeof json.work === "object" && json.work !== null ? (json.work as Record<string, unknown>) : {};
          json.work = work;

          const issueIdCandidate = work.issue_id;
          if (issueIdCandidate === undefined || issueIdCandidate === null || issueIdCandidate === "") {
            work.issue_id = activeTurn.issue_id;
          }

          const branchCandidate = work.branch;
          if (typeof branchCandidate !== "string" || !branchCandidate.trim()) {
            work.branch = activeTurn.branch;
          }
        }
      }

      const parsed = PostflightSchemaV1.safeParse(json);

      if (!parsed.success) {
        console.error("postflight: INVALID");
        console.error(parsed.error.format());
        process.exitCode = 1;
        return;
      }

      console.log("postflight: OK");
      console.log(`issue: ${parsed.data.work.issue_id} | branch: ${parsed.data.work.branch}`);

      if (!opts.apply) return;

      const issueIdRaw = parsed.data.work.issue_id;
      const issueId = typeof issueIdRaw === "number" ? String(issueIdRaw) : String(issueIdRaw);

      if (!/^[0-9]+$/.test(issueId)) {
        console.error("postflight --apply: work.issue_id debe ser el número de issue de GitHub (ej: 1, 42).");
        process.exitCode = 1;
        return;
      }

      const updates = parsed.data.tracker_updates ?? [];
      const cmds: Array<{ cmd: string; args: string[] }> = [];

      for (const u of updates) {
        if (u.type === "comment_append") {
          const body = u.body ?? "";
          if (body.trim()) cmds.push({ cmd: "gh", args: ["issue", "comment", issueId, "--body", body] });
        }

        if (u.type === "label_add") {
          const label = u.label ?? "";
          if (label.trim()) cmds.push({ cmd: "gh", args: ["issue", "edit", issueId, "--add-label", label] });
        }

        if (u.type === "label_remove") {
          const label = u.label ?? "";
          if (label.trim()) cmds.push({ cmd: "gh", args: ["issue", "edit", issueId, "--remove-label", label] });
        }

        if (u.type === "status") {
          const to = u.to ?? "";
          if (to.trim()) cmds.push({ cmd: "gh", args: ["issue", "edit", issueId, "--add-label", to] });
        }

        if (u.type === "link_pr") {
          const n = u.pr_number ?? null;
          if (n) cmds.push({ cmd: "gh", args: ["issue", "comment", issueId, "--body", `Linked PR: #${n}`] });
        }
      }

      if (!cmds.length) {
        console.log("postflight --apply: no hay tracker_updates aplicables.");
        return;
      }

      console.log("\nApplying updates:");
      for (const c of cmds) {
        console.log("$ " + [c.cmd, ...c.args].join(" "));
        if (!opts.dryRun) {
          await execa(c.cmd, c.args, { stdio: "inherit" });
        }
      }

      console.log("\npostflight --apply: DONE");
    } catch (e) {
      console.error("postflight: ERROR");
      console.error(e);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
