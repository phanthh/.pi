import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export interface CompactionMaxSettings {
  enabled: boolean;
  reserveTokens: number;
  overrideMaxTokens?: number;
}

const overrideValue = (settings: unknown): unknown => {
  if (!settings || typeof settings !== "object") return undefined;
  const compaction = (settings as Record<string, unknown>).compaction;
  return compaction && typeof compaction === "object"
    ? (compaction as Record<string, unknown>).overrideMaxTokens
    : undefined;
};

export const readCompactionMaxSettings = (
  cwd: string,
  projectTrusted: boolean,
): CompactionMaxSettings => {
  const settings = SettingsManager.create(cwd, undefined, { projectTrusted });
  const globalValue = overrideValue(settings.getGlobalSettings());
  const projectValue = projectTrusted ? overrideValue(settings.getProjectSettings()) : undefined;
  const value = projectValue ?? globalValue;
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`Invalid compaction.overrideMaxTokens setting: ${String(value)}. Expected a positive safe integer.`);
  }
  return {
    enabled: settings.getCompactionEnabled(),
    reserveTokens: settings.getCompactionReserveTokens(),
    ...(typeof value === "number" ? { overrideMaxTokens: value } : {}),
  };
};

/** The override is a safety cap; it never claims more context than a model supports. */
export const effectiveMaxTokens = (modelContextWindow: number, overrideMaxTokens?: number): number =>
  overrideMaxTokens === undefined
    ? modelContextWindow
    : Math.min(modelContextWindow, overrideMaxTokens);

const providerContextWindows = new Map<Model<any>, number>();

/** Provider-advertised window retained after the runtime model is capped. */
export const providerContextWindow = (model: Model<any> | undefined): number | undefined =>
  model === undefined ? undefined : (providerContextWindows.get(model) ?? model.contextWindow);

/**
 * Make Pi's native context accounting, footer, compaction, and summary budgets
 * agree on one effective window. The provider value is restored at shutdown.
 */
export const registerCompactionMax = (pi: ExtensionAPI): void => {
  let reportedError: string | undefined;

  const apply = (model: Model<any> | undefined, cwd: string, projectTrusted: boolean): void => {
    if (!model) return;
    const settings = readCompactionMaxSettings(cwd, projectTrusted);
    reportedError = undefined;
    const providerWindow = providerContextWindows.get(model) ?? model.contextWindow;
    providerContextWindows.set(model, providerWindow);
    model.contextWindow = effectiveMaxTokens(
      providerWindow,
      settings.overrideMaxTokens,
    );
  };

  const applyOrReport = (model: Model<any> | undefined, ctx: ExtensionContext) => {
    try {
      apply(model, ctx.cwd, ctx.isProjectTrusted());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== reportedError) ctx.ui.notify(message, "error");
      reportedError = message;
    }
  };

  pi.on("session_start", (_event, ctx) => applyOrReport(ctx.model, ctx));
  pi.on("model_select", (event, ctx) => applyOrReport(event.model, ctx));
  pi.on("session_shutdown", () => {
    for (const [model, contextWindow] of providerContextWindows) {
      model.contextWindow = contextWindow;
    }
    providerContextWindows.clear();
    reportedError = undefined;
  });
};
