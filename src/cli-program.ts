import { Command } from "commander";
import { execa } from "execa";
import {
  appendIssueAutocloseReference,
  buildTrackerCommands,
  collectLinkedPrNumbers,
  normalizeGitHubIssueId,
  PostflightSchemaV1,
} from "./core/postflight";

type ExecaFn = typeof execa;

function printGhCommand(args: string[]): void {
  console.log("$ " + ["gh", ...args].join(" "));
}

type PrBodySyncParams = {
  execaFn: ExecaFn;
  issueId: string;
  prNumbers: number[];
  dryRun: boolean;
};

async function syncPrBodiesWithIssueReference(params: PrBodySyncParams): Promise<void> {
  const { execaFn, issueId, prNumbers, dryRun } = params;

  for (const prNumber of prNumbers) {
    const pr = String(prNumber);

    if (dryRun) {
      printGhCommand(["pr", "view", pr, "--json", "body,url"]);
      printGhCommand(["pr", "edit", pr, "--body", `<existing-body>\\n\\nFixes #${issueId}`]);
      continue;
    }

    const viewArgs = ["pr", "view", pr, "--json", "body,url"];
    printGhCommand(viewArgs);
    const prView = await execaFn("gh", viewArgs, { stdio: "pipe" });

    let currentBody = "";
    if (prView.stdout.trim()) {
      const parsed = JSON.parse(prView.stdout) as { body?: unknown };
      if (typeof parsed.body === "string") {
        currentBody = parsed.body;
      }
    }

    const nextBody = appendIssueAutocloseReference(currentBody, issueId);
    if (nextBody === currentBody) {
      console.log(`PR #${pr} already references issue #${issueId}.`);
      continue;
    }

    const editArgs = ["pr", "edit", pr, "--body", nextBody];
    printGhCommand(editArgs);
    await execaFn("gh", editArgs, { stdio: "inherit" });
  }
}

export function createProgram(execaFn: ExecaFn = execa): Command {
  const program = new Command();

  program.name("vibe").description("Vibe-backlog CLI (MVP)").version("0.1.0");

  program
    .command("preflight")
    .description("Show git + GitHub issue snapshot")
    .action(async () => {
      try {
        const git = await execaFn("git", ["status", "-sb"], { stdio: "pipe" });
        console.log(git.stdout);
      } catch {
        console.log("git status: (not available)");
      }

      try {
        const issues = await execaFn("gh", ["issue", "list", "-L", "10"], { stdio: "pipe" });
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
        const issueId = normalizeGitHubIssueId(issueIdRaw);

        if (!issueId) {
          console.error("postflight --apply: work.issue_id debe ser el número de issue de GitHub (ej: 1, 42).");
          process.exitCode = 1;
          return;
        }

        const updates = parsed.data.tracker_updates ?? [];
        const cmds = buildTrackerCommands(issueId, updates);
        const linkedPrNumbers = collectLinkedPrNumbers(updates);

        if (!cmds.length && !linkedPrNumbers.length) {
          console.log("postflight --apply: no hay tracker_updates aplicables.");
          return;
        }

        console.log("\nApplying updates:");
        for (const c of cmds) {
          printGhCommand(c.args);
          if (!opts.dryRun) {
            await execaFn(c.cmd, c.args, { stdio: "inherit" });
          }
        }

        await syncPrBodiesWithIssueReference({
          execaFn,
          issueId,
          prNumbers: linkedPrNumbers,
          dryRun: Boolean(opts.dryRun),
        });

        console.log("\npostflight --apply: DONE");
      } catch (e) {
        console.error("postflight: ERROR");
        console.error(e);
        process.exitCode = 1;
      }
    });

  return program;
}

export async function runCli(argv: string[] = process.argv, execaFn: ExecaFn = execa): Promise<void> {
  const program = createProgram(execaFn);
  await program.parseAsync(argv);
}
