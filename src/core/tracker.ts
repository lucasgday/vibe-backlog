import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type TrackerMilestoneDefinition = {
  title: string;
  description: string;
};

export type TrackerLabelDefinition = {
  name: string;
  color: string;
  description: string;
};

export const TRACKER_BOOTSTRAP_MILESTONES: readonly TrackerMilestoneDefinition[] = [
  {
    title: "CLI usable (repos con .vibe)",
    description:
      "CLI MVP usable across external repos that install .vibe: preflight/guard/status/pr-open/postflight + docs scaffolding.",
  },
  {
    title: "UI MVP (local cockpit)",
    description: "UI surface for local project cockpit: dashboard, actions, logs, and safe run/deploy controls.",
  },
];

export const TRACKER_BOOTSTRAP_LABELS: readonly TrackerLabelDefinition[] = [
  {
    name: "module:cli",
    color: "0052CC",
    description: "CLI commands and terminal UX",
  },
  {
    name: "module:ui",
    color: "5319E7",
    description: "UI app and frontend workflows",
  },
  {
    name: "module:docs",
    color: "1D76DB",
    description: "Documentation and guides",
  },
  {
    name: "module:tracker",
    color: "B60205",
    description: "GitHub issue/PR tracker synchronization",
  },
  {
    name: "module:turn",
    color: "0E8A16",
    description: "Turn context lifecycle and guardrails",
  },
  {
    name: "module:templates",
    color: "FBCA04",
    description: "Generated templates/scaffolds and marker-safe files",
  },
];

const TRACKER_BOOTSTRAP_MARKER = path.join(".vibe", "runtime", "tracker-bootstrap.json");

export function getTrackerBootstrapMarkerPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, TRACKER_BOOTSTRAP_MARKER);
}

function normalizeTrackerLabelName(value: string): string {
  return value.trim().toLowerCase();
}

export function selectMissingTrackerMilestones(existingTitles: Iterable<string>): TrackerMilestoneDefinition[] {
  const existing = new Set(
    Array.from(existingTitles)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return TRACKER_BOOTSTRAP_MILESTONES.filter((milestone) => !existing.has(milestone.title));
}

export function selectMissingTrackerLabels(existingNames: Iterable<string>): TrackerLabelDefinition[] {
  const existing = new Set(
    Array.from(existingNames)
      .map(normalizeTrackerLabelName)
      .filter(Boolean),
  );
  return TRACKER_BOOTSTRAP_LABELS.filter((label) => !existing.has(normalizeTrackerLabelName(label.name)));
}

export async function shouldSuggestTrackerBootstrap(cwd: string = process.cwd()): Promise<boolean> {
  const vibePath = path.resolve(cwd, ".vibe");

  try {
    const vibeStat = await stat(vibePath);
    if (!vibeStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    await stat(getTrackerBootstrapMarkerPath(cwd));
    return false;
  } catch {
    return true;
  }
}

export async function writeTrackerBootstrapMarker(nameWithOwner: string, cwd: string = process.cwd()): Promise<string> {
  const markerPath = getTrackerBootstrapMarkerPath(cwd);

  await mkdir(path.dirname(markerPath), { recursive: true });
  const payload = {
    version: 1,
    configured_at: new Date().toISOString(),
    repository: nameWithOwner,
    milestones: TRACKER_BOOTSTRAP_MILESTONES.map((milestone) => milestone.title),
    labels: TRACKER_BOOTSTRAP_LABELS.map((label) => label.name),
  };

  await writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return markerPath;
}
