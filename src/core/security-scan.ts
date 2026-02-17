import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { parse } from "yaml";

type ExecaFn = typeof execa;

const CONTRACT_PATH = path.join(".vibe", "contract.yml");
const LAST_SCAN_PATH = path.join(".vibe", "runtime", "security-scan.json");

export const SECURITY_SCAN_MODE_VALUES = ["staged", "working-tree", "history"] as const;
export type SecurityScanMode = (typeof SECURITY_SCAN_MODE_VALUES)[number];

export const SECURITY_POLICY_VALUES = ["warn", "fail"] as const;
export type SecurityPolicy = (typeof SECURITY_POLICY_VALUES)[number];

export type SecurityPolicySource = "flag" | "contract" | "default";
export type SecurityScanStatus = "pass" | "findings" | "scanner-missing" | "error" | "planned";

export type SecurityPolicyResolution = {
  policy: SecurityPolicy;
  source: SecurityPolicySource;
  warnings: string[];
  contractPath: string;
};

export type ProbeGitleaksResult = {
  available: boolean;
  location: string | null;
  detail: string | null;
};

export type SecurityScanRecord = {
  version: 1;
  scanned_at: string;
  mode: SecurityScanMode;
  policy: SecurityPolicy;
  status: Exclude<SecurityScanStatus, "planned">;
  findings_detected: boolean;
  gitleaks_available: boolean;
  command: string;
  detail: string | null;
};

export type RunSecurityScanOptions = {
  mode: SecurityScanMode;
  policyOverride?: SecurityPolicy | null;
  dryRun: boolean;
  cwd?: string;
};

export type SecurityScanResult = {
  mode: SecurityScanMode;
  policy: SecurityPolicy;
  policySource: SecurityPolicySource;
  dryRun: boolean;
  status: SecurityScanStatus;
  findingsDetected: boolean;
  gitleaksAvailable: boolean;
  gitleaksLocation: string | null;
  command: string;
  stdout: string;
  stderr: string;
  detail: string | null;
  warnings: string[];
  remediation: string[];
  exitCode: number;
  recordPath: string;
  record: SecurityScanRecord | null;
  recordWritten: boolean;
};

function resolveWorkspace(cwd?: string): string {
  return cwd ?? process.cwd();
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code?: string }).code === code
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function normalizePolicyValue(value: unknown): SecurityPolicy | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (SECURITY_POLICY_VALUES.includes(normalized as SecurityPolicy)) {
    return normalized as SecurityPolicy;
  }
  return null;
}

export function normalizeSecurityScanMode(value: string | null | undefined): SecurityScanMode | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (SECURITY_SCAN_MODE_VALUES.includes(normalized as SecurityScanMode)) {
    return normalized as SecurityScanMode;
  }
  return null;
}

export function normalizeSecurityPolicy(value: string | null | undefined): SecurityPolicy | null {
  return normalizePolicyValue(value);
}

export function getSecurityContractPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, CONTRACT_PATH);
}

export function getSecurityScanRecordPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, LAST_SCAN_PATH);
}

function resolvePolicyFromContractDocument(document: unknown): unknown {
  if (typeof document !== "object" || document === null) return undefined;
  const root = document as Record<string, unknown>;
  const security = root.security;
  if (typeof security !== "object" || security === null) return undefined;
  const gitleaks = (security as Record<string, unknown>).gitleaks;
  if (typeof gitleaks !== "object" || gitleaks === null) return undefined;
  return (gitleaks as Record<string, unknown>).policy;
}

export async function resolveSecurityPolicy(params: {
  cwd?: string;
  override?: SecurityPolicy | null;
}): Promise<SecurityPolicyResolution> {
  const cwd = resolveWorkspace(params.cwd);
  const contractPath = getSecurityContractPath(cwd);
  const warnings: string[] = [];

  if (params.override) {
    return {
      policy: params.override,
      source: "flag",
      warnings,
      contractPath,
    };
  }

  let rawContract = "";
  try {
    rawContract = await readFile(contractPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return {
        policy: "warn",
        source: "default",
        warnings,
        contractPath,
      };
    }
    warnings.push(`security scan: unable to read '${contractPath}' (${toErrorMessage(error)}). Using policy=warn.`);
    return {
      policy: "warn",
      source: "default",
      warnings,
      contractPath,
    };
  }

  let parsedContract: unknown;
  try {
    parsedContract = parse(rawContract);
  } catch (error) {
    warnings.push(`security scan: unable to parse '${contractPath}' (${toErrorMessage(error)}). Using policy=warn.`);
    return {
      policy: "warn",
      source: "default",
      warnings,
      contractPath,
    };
  }

  const contractPolicyRaw = resolvePolicyFromContractDocument(parsedContract);
  const contractPolicy = normalizePolicyValue(contractPolicyRaw);
  if (contractPolicy) {
    return {
      policy: contractPolicy,
      source: "contract",
      warnings,
      contractPath,
    };
  }

  if (typeof contractPolicyRaw === "string" && contractPolicyRaw.trim()) {
    warnings.push(
      `security scan: invalid policy '${contractPolicyRaw}' in '${contractPath}'. Expected warn|fail. Using policy=warn.`,
    );
  }

  return {
    policy: "warn",
    source: "default",
    warnings,
    contractPath,
  };
}

export function buildGitleaksArgs(mode: SecurityScanMode): string[] {
  if (mode === "staged") {
    return ["git", "--staged", "--no-banner", "--redact"];
  }
  if (mode === "working-tree") {
    return ["dir", ".", "--no-banner", "--redact"];
  }
  return ["git", "--no-banner", "--redact"];
}

function toCommandString(args: string[]): string {
  return ["gitleaks", ...args].join(" ");
}

export async function probeGitleaksAvailability(execaFn: ExecaFn = execa): Promise<ProbeGitleaksResult> {
  try {
    const probe = await execaFn("gitleaks", ["version"], { stdio: "pipe", reject: false });
    const exitCode = typeof probe.exitCode === "number" ? probe.exitCode : 1;
    const stdout = typeof probe.stdout === "string" ? probe.stdout.trim() : "";
    const stderr = typeof probe.stderr === "string" ? probe.stderr.trim() : "";
    if (exitCode === 0) {
      return {
        available: true,
        location: null,
        detail: null,
      };
    }
    return {
      available: false,
      location: null,
      detail: stderr || stdout || null,
    };
  } catch (error) {
    return {
      available: false,
      location: null,
      detail: toErrorMessage(error),
    };
  }
}

function parseSecurityScanRecord(input: unknown): SecurityScanRecord | null {
  if (typeof input !== "object" || input === null) return null;
  const row = input as Record<string, unknown>;

  if (row.version !== 1) return null;

  const scannedAt = row.scanned_at;
  const mode = row.mode;
  const policy = row.policy;
  const status = row.status;
  const findingsDetected = row.findings_detected;
  const available = row.gitleaks_available;
  const command = row.command;
  const detail = row.detail;

  if (typeof scannedAt !== "string" || !scannedAt.trim()) return null;
  if (typeof mode !== "string" || !SECURITY_SCAN_MODE_VALUES.includes(mode as SecurityScanMode)) return null;
  if (typeof policy !== "string" || !SECURITY_POLICY_VALUES.includes(policy as SecurityPolicy)) return null;
  if (typeof status !== "string" || !["pass", "findings", "scanner-missing", "error"].includes(status)) return null;
  if (typeof findingsDetected !== "boolean") return null;
  if (typeof available !== "boolean") return null;
  if (typeof command !== "string" || !command.trim()) return null;
  if (detail !== null && typeof detail !== "string") return null;

  return {
    version: 1,
    scanned_at: scannedAt,
    mode: mode as SecurityScanMode,
    policy: policy as SecurityPolicy,
    status: status as Exclude<SecurityScanStatus, "planned">,
    findings_detected: findingsDetected,
    gitleaks_available: available,
    command: command.trim(),
    detail,
  };
}

export async function readLastSecurityScan(cwd: string = process.cwd()): Promise<SecurityScanRecord | null> {
  const recordPath = getSecurityScanRecordPath(cwd);
  let raw = "";
  try {
    raw = await readFile(recordPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseSecurityScanRecord(parsed);
  } catch {
    return null;
  }
}

export async function writeLastSecurityScan(record: SecurityScanRecord, cwd: string = process.cwd()): Promise<string> {
  const recordPath = getSecurityScanRecordPath(cwd);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordPath;
}

function resolveScanExitCode(status: SecurityScanStatus, policy: SecurityPolicy): number {
  if (status === "planned" || status === "pass") return 0;
  if (status === "findings" || status === "scanner-missing") {
    return policy === "fail" ? 1 : 0;
  }
  return 1;
}

function buildRemediation(status: SecurityScanStatus): string[] {
  if (status === "scanner-missing") {
    return [
      "Install gitleaks: https://github.com/gitleaks/gitleaks#installing",
      "Then run: node dist/cli.cjs security scan --mode staged",
    ];
  }
  if (status === "findings") {
    return [
      "Review flagged secrets and rotate compromised credentials.",
      "Re-run: node dist/cli.cjs security scan --mode staged",
    ];
  }
  if (status === "error") {
    return ["Inspect gitleaks error output and retry the scan."];
  }
  return [];
}

export async function runSecurityScan(
  options: RunSecurityScanOptions,
  execaFn: ExecaFn = execa,
): Promise<SecurityScanResult> {
  const cwd = resolveWorkspace(options.cwd);
  const policyResolution = await resolveSecurityPolicy({
    cwd,
    override: options.policyOverride ?? null,
  });
  const gitleaksProbe = await probeGitleaksAvailability(execaFn);
  const gitleaksArgs = buildGitleaksArgs(options.mode);
  const command = toCommandString(gitleaksArgs);
  const warnings = [...policyResolution.warnings];
  const recordPath = getSecurityScanRecordPath(cwd);

  if (options.dryRun) {
    return {
      mode: options.mode,
      policy: policyResolution.policy,
      policySource: policyResolution.source,
      dryRun: true,
      status: "planned",
      findingsDetected: false,
      gitleaksAvailable: gitleaksProbe.available,
      gitleaksLocation: gitleaksProbe.location,
      command,
      stdout: "",
      stderr: "",
      detail: null,
      warnings,
      remediation: [],
      exitCode: 0,
      recordPath,
      record: null,
      recordWritten: false,
    };
  }

  let status: Exclude<SecurityScanStatus, "planned"> = "pass";
  let stdout = "";
  let stderr = "";
  let detail: string | null = null;

  if (!gitleaksProbe.available) {
    status = "scanner-missing";
    detail = gitleaksProbe.detail ?? "gitleaks binary was not found in PATH.";
  } else {
    try {
      const scanned = await execaFn("gitleaks", gitleaksArgs, { stdio: "pipe", reject: false });
      stdout = typeof scanned.stdout === "string" ? scanned.stdout : "";
      stderr = typeof scanned.stderr === "string" ? scanned.stderr : "";
      const scanExitCode = typeof scanned.exitCode === "number" ? scanned.exitCode : 0;
      if (scanExitCode === 0) {
        status = "pass";
      } else if (scanExitCode === 1) {
        status = "findings";
      } else {
        status = "error";
      }
      detail = stderr.trim() || stdout.trim() || null;
    } catch (error) {
      status = "error";
      detail = toErrorMessage(error);
    }
  }

  const findingsDetected = status === "findings";
  const exitCode = resolveScanExitCode(status, policyResolution.policy);
  const remediation = buildRemediation(status);
  const record: SecurityScanRecord = {
    version: 1,
    scanned_at: new Date().toISOString(),
    mode: options.mode,
    policy: policyResolution.policy,
    status,
    findings_detected: findingsDetected,
    gitleaks_available: gitleaksProbe.available,
    command,
    detail,
  };

  await writeLastSecurityScan(record, cwd);

  return {
    mode: options.mode,
    policy: policyResolution.policy,
    policySource: policyResolution.source,
    dryRun: false,
    status,
    findingsDetected,
    gitleaksAvailable: gitleaksProbe.available,
    gitleaksLocation: gitleaksProbe.location,
    command,
    stdout,
    stderr,
    detail,
    warnings,
    remediation,
    exitCode,
    recordPath,
    record,
    recordWritten: true,
  };
}
