import { Command } from "commander";
import { execa } from "execa";
import { scaffoldVibeInit } from "./core/init";
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
import { ensureIssueReviewTemplates } from "./core/reviews";

type ExecaFn = typeof execa;
const GUARD_NO_ACTIVE_TURN_EXIT_CODE = 2;
const GUARD_INVALID_TURN_EXIT_CODE = 3;
const GUARD_REMEDIATION = "Run: node dist/cli.cjs turn start --issue <n>";
const GH_API_PAGE_SIZE = 100;

function printGhCommand(args: string[]): void {
  console.log("$ " + ["gh", ...args].join(" "));
}

function printPathList(title: string, paths: string[]): void {
  if (!paths.length) return;
  console.log(`\n${title}:`);
  for (const entry of paths) {
    console.log(`- ${entry}`);
  }
}

type JsonRecord = Record<string, unknown>;

type IssueSnapshot = {
  number: number;
  title: string;
  state: string | null;
  labels: string[];
  milestone: string | null;
  updatedAt: string | null;
  url: string | null;
};

type PullRequestSnapshot = {
  number: number;
  state: string | null;
  title: string;
  url: string | null;
};

function parseJsonArray(stdout: string, context: string): JsonRecord[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected array response`);
  }
  return parsed.filter((value): value is JsonRecord => typeof value === "object" && value !== null);
}

function parseLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "object" && entry !== null) {
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === "string") return name.trim();
      }
      return "";
    })
    .filter(Boolean);
}

function parseIssueSnapshots(stdout: string, context: string): IssueSnapshot[] {
  const rows = parseJsonArray(stdout, context);
  const snapshots: IssueSnapshot[] = [];

  for (const row of rows) {
    const number = row.number;
    const title = row.title;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (typeof title !== "string" || !title.trim()) continue;

    const milestoneRaw = row.milestone;
    const milestone =
      typeof milestoneRaw === "object" && milestoneRaw !== null && typeof milestoneRaw.title === "string"
        ? milestoneRaw.title.trim() || null
        : null;

    const state = typeof row.state === "string" ? row.state.trim() || null : null;
    const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt.trim() || null : null;
    const url = typeof row.url === "string" ? row.url.trim() || null : null;

    snapshots.push({
      number,
      title: title.trim(),
      state,
      labels: parseLabelNames(row.labels),
      milestone,
      updatedAt,
      url,
    });
  }

  return snapshots;
}

function parsePullRequestSnapshots(stdout: string, context: string): PullRequestSnapshot[] {
  const rows = parseJsonArray(stdout, context);
  const snapshots: PullRequestSnapshot[] = [];

  for (const row of rows) {
    const number = row.number;
    const title = row.title;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (typeof title !== "string" || !title.trim()) continue;

    const state = typeof row.state === "string" ? row.state.trim() || null : null;
    const url = typeof row.url === "string" ? row.url.trim() || null : null;

    snapshots.push({
      number,
      title: title.trim(),
      state,
      url,
    });
  }

  return snapshots;
}

function formatIssueSnapshot(snapshot: IssueSnapshot): string {
  const labels = snapshot.labels.length ? snapshot.labels.join(", ") : "-";
  const state = snapshot.state ?? "OPEN";
  const updatedAt = snapshot.updatedAt ?? "-";
  return `${snapshot.number}\t${state}\t${snapshot.title}\t${labels}\t${updatedAt}`;
}

function findInProgressIssues(snapshots: IssueSnapshot[]): IssueSnapshot[] {
  return snapshots.filter((issue) => issue.labels.some((label) => label.trim().toLowerCase() === "status:in-progress"));
}

function findIssuesMissingMilestone(snapshots: IssueSnapshot[]): IssueSnapshot[] {
  return snapshots.filter((issue) => !issue.milestone);
}

function findIssuesMissingModuleLabel(snapshots: IssueSnapshot[]): IssueSnapshot[] {
  return snapshots.filter((issue) => !issue.labels.some((label) => label.trim().toLowerCase().startsWith("module:")));
}

function printIssueBlock(title: string, snapshots: IssueSnapshot[], limit: number): void {
  console.log(`\n${title}:`);
  if (!snapshots.length) {
    console.log("none");
    return;
  }

  for (const snapshot of snapshots.slice(0, limit)) {
    console.log(formatIssueSnapshot(snapshot));
  }
}

function printHygieneWarnings(snapshots: IssueSnapshot[]): void {
  const missingMilestone = findIssuesMissingMilestone(snapshots);
  const missingModule = findIssuesMissingModuleLabel(snapshots);

  console.log("\nTracker hygiene warnings:");
  if (!missingMilestone.length && !missingModule.length) {
    console.log("none");
    return;
  }

  if (missingMilestone.length) {
    const ids = missingMilestone.map((issue) => `#${issue.number}`).join(", ");
    console.log(`missing milestone: ${ids}`);
  }

  if (missingModule.length) {
    const ids = missingModule.map((issue) => `#${issue.number}`).join(", ");
    console.log(`missing module label: ${ids}`);
  }
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

async function listPaginatedGhApiRecords(execaFn: ExecaFn, endpoint: string, context: string): Promise<JsonRecord[]> {
  const all: JsonRecord[] = [];

  for (let page = 1; ; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const paginatedEndpoint = `${endpoint}${separator}per_page=${GH_API_PAGE_SIZE}&page=${page}`;
    const response = await execaFn("gh", ["api", paginatedEndpoint], { stdio: "pipe" });
    const parsed = parseJsonArray(response.stdout, context);
    all.push(...parsed);
    if (parsed.length < GH_API_PAGE_SIZE) {
      break;
    }
  }

  return all;
}

async function listExistingMilestoneTitles(execaFn: ExecaFn, repo: string): Promise<Set<string>> {
  const parsed = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/milestones?state=all`, "gh milestones");
  const titles = parsed
    .map((row) => row.title)
    .filter((value): value is string => typeof value === "string")
    .map((title) => title.trim())
    .filter(Boolean);
  return new Set(titles);
}

async function listExistingLabelNames(execaFn: ExecaFn, repo: string): Promise<Set<string>> {
  const parsed = await listPaginatedGhApiRecords(execaFn, `repos/${repo}/labels`, "gh labels");
  const names = parsed
    .map((row) => row.name)
    .filter((value): value is string => typeof value === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  return new Set(names);
}

async function listOpenIssueSnapshots(execaFn: ExecaFn, limit: number): Promise<IssueSnapshot[]> {
  const response = await execaFn(
    "gh",
    ["issue", "list", "--state", "open", "-L", String(limit), "--json", "number,title,state,labels,milestone,updatedAt,url"],
    { stdio: "pipe" },
  );
  return parseIssueSnapshots(response.stdout, "gh issue list");
}

async function fetchIssueSnapshotByNumber(execaFn: ExecaFn, issueId: number): Promise<IssueSnapshot | null> {
  const response = await execaFn(
    "gh",
    ["issue", "view", String(issueId), "--json", "number,title,state,labels,milestone,updatedAt,url"],
    {
      stdio: "pipe",
    },
  );
  const parsed = parseIssueSnapshots(`[${response.stdout}]`, "gh issue view");
  return parsed[0] ?? null;
}

async function listBranchPullRequestSnapshots(execaFn: ExecaFn, branch: string): Promise<PullRequestSnapshot[]> {
  const response = await execaFn("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,title,state,url"], {
    stdio: "pipe",
  });
  return parsePullRequestSnapshots(response.stdout, "gh pr list");
}

function parseCurrentBranchFromStatus(statusOutput: string): string | null {
  const firstLine = statusOutput.split(/\r?\n/)[0]?.trim() ?? "";
  const match = /^##\s+(.+)$/.exec(firstLine);
  if (!match) return null;

  const branchInfo = match[1].trim();
  if (!branchInfo) return null;

  if (branchInfo.startsWith("HEAD ")) return null;

  const noCommitsPrefix = "No commits yet on ";
  if (branchInfo.startsWith(noCommitsPrefix)) {
    const branch = branchInfo.slice(noCommitsPrefix.length).trim();
    return branch || null;
  }

  const branch = branchInfo.split("...")[0]?.trim() ?? "";
  const [branchName = ""] = branch.split(/\s+/);
  return branchName || null;
}

async function runTrackerBootstrap(execaFn: ExecaFn, dryRun: boolean): Promise<void> {
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
        const reviewTemplates = await ensureIssueReviewTemplates(issueId);
        if (reviewTemplates.created.length) {
          console.log(`review templates: created ${reviewTemplates.created.length} file(s) at ${reviewTemplates.directory}`);
        } else {
          console.log(`review templates: already present at ${reviewTemplates.directory}`);
        }
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
        await runTrackerBootstrap(execaFn, dryRun);
      } catch (error) {
        console.error("tracker bootstrap: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  program
    .command("init")
    .description("Initialize agent-first .vibe scaffolding in current repository")
    .option("--dry-run", "Print planned changes without writing files", false)
    .option("--skip-tracker", "Skip tracker bootstrap gh operations", false)
    .action(async (opts) => {
      const dryRun = Boolean(opts.dryRun);
      const skipTracker = Boolean(opts.skipTracker);

      try {
        console.log(`init: ${dryRun ? "dry-run" : "apply"} mode`);
        const scaffoldResult = await scaffoldVibeInit({ dryRun });
        printPathList("Created", scaffoldResult.created);
        printPathList("Updated", scaffoldResult.updated);

        if (!skipTracker) {
          console.log("\ninit: tracker bootstrap");
          await runTrackerBootstrap(execaFn, dryRun);
        } else {
          console.log("\ninit: tracker bootstrap skipped (--skip-tracker).");
        }

        if (dryRun) {
          console.log("\ninit: dry-run complete.");
        } else {
          console.log("\ninit: DONE");
        }
      } catch (error) {
        console.error("init: ERROR");
        console.error(error);
        process.exitCode = 1;
      }
    });

  program
    .command("status")
    .description("Show active turn + tracker snapshot")
    .action(async () => {
      let gitStatusOutput = "";
      let currentBranch: string | null = null;

      try {
        const git = await execaFn("git", ["status", "-sb"], { stdio: "pipe" });
        gitStatusOutput = git.stdout;
        console.log(gitStatusOutput);
        currentBranch = parseCurrentBranchFromStatus(gitStatusOutput);
      } catch {
        console.log("git status: (not available)");
      }

      let activeTurnIssueId: number | null = null;
      try {
        const activeTurn = await readTurnContext();
        if (!activeTurn) {
          console.log("\nActive turn: none");
        } else {
          const errors = validateTurnContext(activeTurn);
          if (errors.length) {
            console.log(`\nActive turn: invalid (${errors.join(", ")})`);
          } else {
            activeTurnIssueId = activeTurn.issue_id;
            console.log(
              `\nActive turn: issue=${activeTurn.issue_id} branch=${activeTurn.branch} started_at=${activeTurn.started_at ?? "-"}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.log("\nActive turn: invalid (malformed turn.json)");
        } else {
          console.log("\nActive turn: unavailable");
        }
      }

      let openIssues: IssueSnapshot[] = [];
      let ghAvailable = false;
      try {
        openIssues = await listOpenIssueSnapshots(execaFn, 100);
        ghAvailable = true;
      } catch (error) {
        console.log("\nTracker snapshot: unavailable (gh issue list failed)");
        if (error instanceof Error) {
          console.log(String(error.message || error));
        }
      }

      if (ghAvailable) {
        printIssueBlock("In-progress issues", findInProgressIssues(openIssues), 10);
        printHygieneWarnings(openIssues);
      }

      if (ghAvailable && activeTurnIssueId) {
        try {
          const issue = await fetchIssueSnapshotByNumber(execaFn, activeTurnIssueId);
          if (issue) {
            const labels = issue.labels.length ? issue.labels.join(", ") : "-";
            console.log(`\nActive issue: #${issue.number} ${issue.state ?? "OPEN"} ${issue.title}`);
            console.log(`Active issue labels: ${labels}`);
            console.log(`Active issue milestone: ${issue.milestone ?? "-"}`);
          }
        } catch {
          console.log("\nActive issue: unavailable from gh");
        }
      }

      if (ghAvailable && currentBranch) {
        try {
          const prs = await listBranchPullRequestSnapshots(execaFn, currentBranch);
          console.log("\nBranch PRs:");
          if (!prs.length) {
            console.log("none");
          } else {
            for (const pr of prs) {
              console.log(`#${pr.number} ${pr.state ?? "-"} ${pr.title}${pr.url ? ` (${pr.url})` : ""}`);
            }
          }
        } catch {
          console.log("\nBranch PRs: unavailable");
        }
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

      let snapshots: IssueSnapshot[] = [];
      let ghIssueQueryOk = false;
      try {
        snapshots = await listOpenIssueSnapshots(execaFn, 100);
        ghIssueQueryOk = true;
        printIssueBlock("Open issues (top 10)", snapshots, 10);
      } catch (e) {
        console.log("\nOpen issues: (gh issue list not available here)");
        if (e instanceof Error) console.log(String(e.message || e));
      }

      if (ghIssueQueryOk) {
        printIssueBlock("In-progress issues", findInProgressIssues(snapshots), 10);
        printHygieneWarnings(snapshots);
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
