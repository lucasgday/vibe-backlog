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
  .description("Validate postflight artifact (stub for now)")
  .action(async () => {
    console.log("postflight: TODO (schema validation + apply tracker updates)");
    console.log("Expected artifact: .vibe/artifacts/postflight.json");
  });

program.parse(process.argv);
