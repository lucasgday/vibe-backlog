#!/usr/bin/env node
import { Command } from "commander";
import { execa } from "execa";

const program = new Command();

program
  .name("vibe")
  .description("Vibe-backlog CLI (MVP)")
  .version("0.1.0");

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
    } catch {
      console.log("\nOpen issues: (gh issue list not available here)");
    }
  });

program
  .command("postflight")
  .description("Validate postflight artifact")
  .option("-f, --file <path>", "Path to postflight JSON", ".vibe/artifacts/postflight.json")
  .action(async (opts) => {
    const fs = await import("node:fs/promises");
    const { PostflightSchemaV1 } = await import("./core/postflight");

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
      console.log(`issue:  | branch: `);
    } catch (e) {
      console.error("postflight: ERROR");
      console.error(e);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
