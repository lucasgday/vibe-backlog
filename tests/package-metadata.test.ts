import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type PackageJsonShape = {
  private?: boolean;
  license?: string;
};

describe("package metadata policy", () => {
  it("keeps npm publish disabled until release workflow is explicit", () => {
    const currentFilePath = fileURLToPath(import.meta.url);
    const packageJsonPath = path.resolve(path.dirname(currentFilePath), "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJsonShape;

    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe("MIT");
  });
});
