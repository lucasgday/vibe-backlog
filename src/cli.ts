#!/usr/bin/env node
import { runCli } from "./cli-program";

void runCli().catch((error) => {
  console.error("cli: ERROR");
  console.error(error);
  process.exitCode = 1;
});
