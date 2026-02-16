import { Command } from "commander";
import { execa } from "execa";
import {
  appendIssueAutocloseReference,
  buildTrackerCommands,
  collectLinkedPrNumbers,
  normalizeGitHubIssueId,
  PostflightSchemaV1,
} from "./core/postflight";
import {
  selectMissingTrackerLabels,
  selectMissingTrackerMilestones,
  shouldSuggestTrackerBootstrap,
  writeTrackerBootstrapMarker,
} from "./core/tracker";
import { buildTurnBranch, clearTurnContext, readTurnContext, validateTurnContext, writeTurnContext } from "./core/turn";

type ExecaFn = typeof execa;
const GUARD_NO_ACTIVE_TURN_EXIT_CODE = 2;
const GUARD_INVALID_TURN_EXIT_CODE = 3;
const GUARD_REMEDIATION = "Run: node dist/cli.cjs turn start --issue <n>";

function printGhCommand(args: string[]): void {
  console.log("$ " + ["gh", ...args].join(" "));
}

type JsonRecord = Record<string, unknown>;

function parseJsonArray(stdout: string, context: string): JsonRecord[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected array response`);
  }
  return parsed.filter((value): value is JsonRecord => typeof value === "object" && value !== null);
}

async function resolveRepoNameWithOwner(execaFn: ExecaFn): Promise<string> {
  const repo = await execaFn("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    stdio: "pipe",
  });
  const slug = repo.stdout.trim();
  if (!slug || !slug.includes("/")) {
    throw new Error("unable to resolve repository owner/name from gh");
  }
  return slug;
}

async function listExistingMilestoneTitles(execaFn: ExecaFn, repo: string): Promise<Set<string>> {
  const response = await execaFn("gh", ["api", `repos/${repo}/milestones?state=all`], { stdio: "pipe" });
  const parsed = parseJsonArray(response.stdout, "gh milestones");
  const titles = parsed
    .map((row) => row.title)
    .filter((value): value is string => typeof value === "string")
    .map((title) => title.trim())
    .filter(Boolean);
  return new Set(titles);
}

async function listExistingLabelNames(execaFn: ExecaFn, repo: string): Promise<Set<string>> {
  const response = await execaFn("gh", ["api", `repos/${repo}/labels?per_page=100`], { stdio: "pipe" });
  const parsed = parseJsonArray(response.stdout, "gh labels");
  const names = parsed
    .map((row) => row.name)
    .filter((value): value is string => typeof value === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  return new Set(names);
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

async function issueTitleFromGitHub(execaFn: ExecaFn, issueId: number): Promise<string> {
  try {
    const issue = await execaFn("gh", ["issue", "view", String(issueId), "--json", "title", "-q", ".title"], {
      stdio: "pipe",
    });
    const title = issue.stdout.trim();
    if (title) {
      return title;
    }
  } catch {
    // Fall through to deterministic fallback.
  }

  return `issue-${issueId}`;
}

async function checkoutOrCreateBranch(execaFn: ExecaFn, branch: string): Promise<void> {
  const probe = await execaFn("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    stdio: "pipe",
    reject: false,
  });

  if (probe.exitCode === 0) {
    await execaFn("git", ["checkout", branch], { stdio: "inherit" });
    return;
  }

  await execaFn("git", ["checkout", "-b", branch], { stdio: "inherit" });
}

export function createProgram(execaFn: ExecaFn = execa): Command {
  const program = new Command();

  program.name("vibe").description("Vibe-backlog CLI (MVP)").version("0.1.0");

  const turn = program.command("turn").description("Manage active local turn context");

  turn
    .command("start")
    .description("Start a turn from an issue number")
    .requiredOption("--issue <n>", "GitHub issue number")
    .action(async (opts) => {
      const issueRaw = String(opts.issue).trim();
      if (!/^[0-9]+$/.test(issueRaw)) {
        console.error("turn start: --issue debe ser un entero positivo.");
        process.exitCode = 1;
        return;
      }

      const issueId = Number(issueRaw);
      if (!Number.isSafeInteger(issueId) || issueId <= 0) {
        console.error("turn start: --issue debe ser un entero positivo.");
        process.exitCode = 1;
        return;
      }

      try {
        const issueTitle = await issueTitleFromGitHub(execaFn, issueId);
        const branch = buildTurnBranch(issueId, issueTitle);

        await checkoutOrCreateBranch(execaFn, branch);

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
    .command("guard")
    .description("Fail when there is no valid active turn context")
    .action(async () => {
      try {
        const activeTurn = await readTurnContext();
        if (!activeTurn) {
          console.error("guard: no active turn.");
          console.error(GUARD_REMEDIATION);
          process.exitCode = GUARD_NO_ACTIVE_TURN_EXIT_CODE;
          return;
        }

        const turnErrors = validateTurnContext(activeTurn);
        if (turnErrors.length > 0) {
          console.error(`guard: invalid active turn (missing/invalid: ${turnErrors.join(", ")}).`);
          console.error(GUARD_REMEDIATION);
          process.exitCode = GUARD_INVALID_TURN_EXIT_CODE;
          return;
        }

        console.log(
          `guard: OK issue=${activeTurn.issue_id} branch=${activeTurn.branch} base_branch=${activeTurn.base_branch}`,
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.error("guard: invalid active turn (malformed turn.json).");
          console.error(GUARD_REMEDIATION);
          process.exitCode = GUARD_INVALID_TURN_EXIT_CODE;
          return;
        }

        console.error("guard: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  const tracker = program.command("tracker").description("Manage tracker bootstrap for current repository");

  tracker
    .command("bootstrap")
    .description("Create default milestones + module labels in current GitHub repo")
    .option("--dry-run", "Print gh commands without executing them", false)
    .action(async (opts) => {
      const dryRun = Boolean(opts.dryRun);

      try {
        const repo = await resolveRepoNameWithOwner(execaFn);
        const [existingMilestones, existingLabels] = await Promise.all([
          listExistingMilestoneTitles(execaFn, repo),
          listExistingLabelNames(execaFn, repo),
        ]);
        const milestonesToCreate = selectMissingTrackerMilestones(existingMilestones);
        const labelsToCreate = selectMissingTrackerLabels(existingLabels);

        console.log(`tracker bootstrap: repo ${repo}`);
        if (!milestonesToCreate.length && !labelsToCreate.length) {
          console.log("tracker bootstrap: already configured.");
          if (!dryRun) {
            const markerPath = await writeTrackerBootstrapMarker(repo);
            console.log(`tracker bootstrap: marker updated at ${markerPath}`);
          }
          return;
        }

        if (milestonesToCreate.length > 0) {
          console.log("\nMilestones to create:");
          for (const milestone of milestonesToCreate) {
            console.log(`- ${milestone.title}`);
            const args = [
              "api",
              "--method",
              "POST",
              `repos/${repo}/milestones`,
              "-f",
              `title=${milestone.title}`,
              "-f",
              `description=${milestone.description}`,
            ];
            printGhCommand(args);
            if (!dryRun) {
              await execaFn("gh", args, { stdio: "inherit" });
            }
          }
        } else {
          console.log("Milestones: already configured.");
        }

        if (labelsToCreate.length > 0) {
          console.log("\nLabels to create:");
          for (const label of labelsToCreate) {
            console.log(`- ${label.name}`);
            const args = ["label", "create", label.name, "--color", label.color, "--description", label.description];
            printGhCommand(args);
            if (!dryRun) {
              await execaFn("gh", args, { stdio: "inherit" });
            }
          }
        } else {
          console.log("Labels: already configured.");
        }

        if (dryRun) {
          console.log("\ntracker bootstrap: dry-run complete.");
          return;
        }

        const markerPath = await writeTrackerBootstrapMarker(repo);
        console.log(`\ntracker bootstrap: DONE (${markerPath})`);
      } catch (error) {
        console.error("tracker bootstrap: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

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

      try {
        const shouldHint = await shouldSuggestTrackerBootstrap();
        if (shouldHint) {
          console.log("\nTracker bootstrap suggested:");
          console.log("Detected .vibe without tracker taxonomy marker.");
          console.log("Run: node dist/cli.cjs tracker bootstrap --dry-run");
          console.log("Then: node dist/cli.cjs tracker bootstrap");
        }
      } catch {
        // Ignore hint failures: preflight must remain resilient.
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
