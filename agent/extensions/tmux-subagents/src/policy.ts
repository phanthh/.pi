/**
 * Spawn policy: what a child may do, and how that survives nesting and resume.
 *
 * - Denied tools accumulate down the tree: child denies = role denies ∪ every ancestor's.
 * - A role's `spawns:` list limits which agents it may launch or resume (env PI_SUBAGENT_SPAWNS).
 * - Each launch persists its resolved spec beside the session, so resume re-applies the role.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function csv(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Tools gated by `spawning: false`. */
export const SPAWNING_TOOLS = ["tmux_subagent"] as const;

export function resolveDenyTools(
  role: { denyTools?: string; spawning?: boolean } | null,
  inherited: string[] = csv(process.env.PI_DENY_TOOLS),
): string[] {
  const denied = new Set(inherited);
  if (role?.spawning === false) for (const tool of SPAWNING_TOOLS) denied.add(tool);
  for (const tool of csv(role?.denyTools)) denied.add(tool);
  return [...denied];
}

/** A caller `tools` override may only narrow a role's own allowlist, never widen it. */
export function resolveToolAllowlist(roleTools: string | undefined, requested: string | undefined): string | undefined {
  if (!requested) return roleTools;
  if (!roleTools) return requested;
  const role = new Set(csv(roleTools));
  const kept = csv(requested).filter((tool) => role.has(tool));
  // Empty would mean "no --tools" = default tools, a widening.
  if (kept.length === 0) throw new Error(`None of tools "${requested}" are in the role allowlist (${roleTools}).`);
  return kept.join(",");
}

/** null = unrestricted. Empty set = may launch nothing. */
export function allowedSpawns(raw: string | undefined = process.env.PI_SUBAGENT_SPAWNS): Set<string> | null {
  return raw === undefined ? null : new Set(csv(raw));
}

export function spawnRefusal(agent: string | undefined, allowed: Set<string> | null): string | null {
  if (!allowed || (agent && allowed.has(agent))) return null;
  const list = allowed.size > 0 ? [...allowed].join(", ") : "nothing";
  const what = agent ? `agent "${agent}"` : "a child without a known agent";
  return `This role may launch only: ${list}. Refused ${what}. Do this work yourself or ask your caller.`;
}

export interface LaunchSpec {
  version: 1;
  name: string;
  agent?: string;
  /** `provider/model[:thinking]` passed to `--model`. */
  model?: string;
  systemPrompt?: { mode: "append" | "replace"; text: string };
  /** Final `--tools` value, control tools included. */
  tools?: string;
  denyTools: string[];
  /** Undefined = unrestricted. */
  spawns?: string[];
  autoExit: boolean;
  cwd?: string;
  agentDir?: string;
}

export function launchSpecFile(sessionFile: string): string {
  return `${sessionFile}.launch.json`;
}

export function writeLaunchSpec(sessionFile: string, spec: LaunchSpec): void {
  writeFileSync(launchSpecFile(sessionFile), JSON.stringify(spec, null, 2), "utf8");
}

export function readLaunchSpec(sessionFile: string): LaunchSpec | null {
  const file = launchSpecFile(sessionFile);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data?.version === 1 && Array.isArray(data.denyTools) ? (data as LaunchSpec) : null;
  } catch {
    return null;
  }
}
