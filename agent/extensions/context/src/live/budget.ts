import { getCurrentSystemMessage, type Model } from "@earendil-works/pi-ai";
import { estimateTokens, SettingsManager, type ExtensionContext, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { effectiveMaxTokens, readCompactionMaxSettings } from "../compact/max-tokens.ts";

/** Estimate current projected text, not provider usage measured before a history edit. */
export function liveTokens(projection: SessionProjection, systemPrompt: string): number {
  const system = getCurrentSystemMessage(projection.messages.filter((message) => message.role === "system"));
  const effectiveSystem = { ...system, role: "system" as const, content: systemPrompt, sections: undefined, timestamp: system?.timestamp ?? 0 };
  return Math.max(system ? estimateTokens(system) : 0, estimateTokens(effectiveSystem)) +
    projection.messages.reduce((tokens, message) => tokens + (message.role === "system" ? 0 : estimateTokens(message)), 0);
}

export function liveBudget(ctx: ExtensionContext, model: Model<any> | undefined = ctx.model): number {
  if (!model) throw new Error("Live context needs a selected model to validate the token budget.");
  const trusted = ctx.isProjectTrusted();
  const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: trusted });
  const max = readCompactionMaxSettings(ctx.cwd, trusted);
  const window = effectiveMaxTokens(model.contextWindow, max.overrideMaxTokens);
  const limit = window - settings.getCompactionReserveTokens(model);
  if (limit <= 0) throw new Error("Compaction reserve leaves no input budget for live context.");
  return limit;
}

/** Two reminders per pressure cycle; shrinking below 60% re-arms them. */
export function pressureLevel(tokens: number, budget: number, previous: number): number {
  const ratio = tokens / budget;
  if (ratio < 0.6) return 0;
  return Math.max(previous, ratio >= 0.85 ? 2 : ratio >= 0.7 ? 1 : 0);
}
