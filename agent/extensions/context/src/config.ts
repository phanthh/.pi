/** OM config: global ~/.pi/agent/om.json plus trusted project .pi/om.json. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface OmModelRef { provider: string; id: string }

export interface OmConfig {
  enabled: boolean;
  /** Shared worker model; stage-specific models win. */
  model: OmModelRef | null;
  observerModel: OmModelRef | null;
  reflectorModel: OmModelRef | null;
  dropperModel: OmModelRef | null;
  observerFallbackModels: OmModelRef[];
  reflectorFallbackModels: OmModelRef[];
  dropperFallbackModels: OmModelRef[];
  sessionFallback: boolean;
  observeAfterTokens: number;
  reflectAfterTokens: number;
  chunkMaxTokens: number;
  observationsPoolMaxTokens: number;
  reflectionsPoolMaxTokens: number;
  reflectorInputMaxTokens: number;
  dropperInputMaxTokens: number;
  dropperPressureThreshold: number;
  dropperPoolFullnessThreshold: number;
  maxOutputTokens: number;
}

export const DEFAULT_CONFIG: OmConfig = {
  enabled: true,
  model: null,
  observerModel: null,
  reflectorModel: null,
  dropperModel: null,
  observerFallbackModels: [],
  reflectorFallbackModels: [],
  dropperFallbackModels: [],
  sessionFallback: true,
  observeAfterTokens: 15_000,
  reflectAfterTokens: 25_000,
  chunkMaxTokens: 40_000,
  observationsPoolMaxTokens: 20_000,
  reflectionsPoolMaxTokens: 8_000,
  reflectorInputMaxTokens: 80_000,
  dropperInputMaxTokens: 80_000,
  dropperPressureThreshold: 0.7,
  dropperPoolFullnessThreshold: 0.1,
  maxOutputTokens: 2_000,
};

export const CONFIG_FILE_NAME = "om.json";
export const globalConfigPath = (): string => join(getAgentDir(), CONFIG_FILE_NAME);

const INTEGER_LIMITS: Partial<Record<keyof OmConfig, readonly [number, number]>> = {
  observeAfterTokens: [2_000, 200_000],
  reflectAfterTokens: [2_000, 200_000],
  chunkMaxTokens: [2_000, 200_000],
  observationsPoolMaxTokens: [200, 100_000],
  reflectionsPoolMaxTokens: [200, 50_000],
  reflectorInputMaxTokens: [2_000, 200_000],
  dropperInputMaxTokens: [2_000, 200_000],
  maxOutputTokens: [200, 32_000],
};
const FRACTION_KEYS = ["dropperPressureThreshold", "dropperPoolFullnessThreshold"] as const;
const MODEL_KEYS = ["model", "observerModel", "reflectorModel", "dropperModel"] as const;
const FALLBACK_KEYS = ["observerFallbackModels", "reflectorFallbackModels", "dropperFallbackModels"] as const;

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
};

const readModel = (value: unknown): OmModelRef | null | undefined => {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { provider, id } = value as Record<string, unknown>;
  return typeof provider === "string" && provider && typeof id === "string" && id ? { provider, id } : undefined;
};

const readModels = (value: unknown): OmModelRef[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const model = readModel(item);
    return model ? [model] : [];
  });
};

/** Apply known valid fields; unknown/invalid fields are ignored. */
export const applyConfig = (base: OmConfig, raw: Record<string, unknown>): OmConfig => {
  const next: OmConfig = { ...base };
  if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
  if (typeof raw.sessionFallback === "boolean") next.sessionFallback = raw.sessionFallback;
  for (const key of MODEL_KEYS) {
    const model = readModel(raw[key]);
    if (model !== undefined) next[key] = model;
  }
  for (const key of FALLBACK_KEYS) {
    const models = readModels(raw[key]);
    if (models) next[key] = models;
  }
  for (const [key, limits] of Object.entries(INTEGER_LIMITS) as Array<[keyof OmConfig, readonly [number, number]]>) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    (next[key] as number) = Math.min(limits[1], Math.max(limits[0], Math.round(value)));
  }
  for (const key of FRACTION_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) next[key] = Math.min(1, value);
  }
  // Compatibility with observer-only builds.
  if (typeof raw.memoryMaxTokens === "number" && raw.observationsPoolMaxTokens === undefined) {
    next.observationsPoolMaxTokens = Math.min(100_000, Math.max(200, Math.round(raw.memoryMaxTokens)));
  }
  next.chunkMaxTokens = Math.max(next.chunkMaxTokens, next.observeAfterTokens);
  return next;
};

export const loadConfig = (cwd: string, projectTrusted: boolean): OmConfig => {
  let config = applyConfig(DEFAULT_CONFIG, readJson(globalConfigPath()) ?? {});
  if (projectTrusted) config = applyConfig(config, readJson(join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME)) ?? {});
  return config;
};

export const saveGlobalConfig = (patch: Partial<OmConfig>): void => {
  const path = globalConfigPath();
  const current = readJson(path) ?? {};
  mkdirSync(getAgentDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
};
