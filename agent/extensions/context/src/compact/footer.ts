import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { effectiveMaxTokens, providerContextWindow, readCompactionMaxSettings } from "./max-tokens.ts";

export const formatTokens = (count: number): string => {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
};

export const formatContextUsage = (
  tokens: number | null | undefined,
  effectiveWindow: number,
  modelWindow: number,
  autoCompactEnabled: boolean,
): { text: string; percent: number } => {
  const percent = tokens == null ? 0 : tokens / effectiveWindow * 100;
  const usage = tokens == null ? "?" : `${percent.toFixed(1)}%`;
  const actual = effectiveWindow < modelWindow ? ` (${formatTokens(modelWindow)})` : "";
  const auto = autoCompactEnabled ? " (auto)" : "";
  return { text: `${usage}/${formatTokens(effectiveWindow)}${actual}${auto}`, percent };
};

const cwdForFooter = (cwd: string): string => {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const relativeToHome = relative(resolve(home), resolvedCwd);
  const insideHome = relativeToHome === "" || (
    relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome)
  );
  return insideHome ? (relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`) : cwd;
};

const sanitizeStatus = (text: string): string => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

/** Replace Pi's footer only when a configured cap changes its context denominator. */
export const registerOverrideFooter = (pi: ExtensionAPI): void => {
  let installed = false;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    let settings;
    try {
      settings = readCompactionMaxSettings(ctx.cwd, ctx.isProjectTrusted());
    } catch {
      return;
    }
    if (settings.overrideMaxTokens === undefined) return;

    installed = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const modelWindow = providerContextWindow(ctx.model) ?? 0;
          const effectiveWindow = modelWindow > 0
            ? effectiveMaxTokens(modelWindow, settings.overrideMaxTokens)
            : 0;
          const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          let latestCacheHitRate: number | undefined;

          for (const entry of ctx.sessionManager.getEntries()) {
            const usage = entry.type === "message"
              ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
              : (entry.type === "branch_summary" || entry.type === "compaction" ? entry.usage : undefined);
            if (!usage) continue;
            totals.input += usage.input;
            totals.output += usage.output;
            totals.cacheRead += usage.cacheRead;
            totals.cacheWrite += usage.cacheWrite;
            totals.cost += usage.cost.total;
            if (entry.type === "message" && entry.message.role === "assistant") {
              const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
              latestCacheHitRate = promptTokens > 0 ? usage.cacheRead / promptTokens * 100 : undefined;
            }
          }

          let pwd = cwdForFooter(ctx.sessionManager.getCwd());
          const branch = footerData.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd += ` • ${sessionName}`;

          const parts: string[] = [];
          if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
          if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) {
            parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
          }
          const usingSubscription = ctx.model?.provider === "kimi-coding";
          if (totals.cost || usingSubscription) {
            parts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
          }

          const context = effectiveWindow > 0
            ? formatContextUsage(ctx.getContextUsage()?.tokens, effectiveWindow, modelWindow, settings.enabled)
            : { text: "?/0", percent: 0 };
          parts.push(context.percent > 90
            ? theme.fg("error", context.text)
            : context.percent > 70
              ? theme.fg("warning", context.text)
              : context.text);

          let left = parts.join(" ");
          if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
          const modelName = ctx.model?.id || "no-model";
          const thinkingLevel = ctx.thinkingLevel || "off";
          let right = ctx.model?.reasoning
            ? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
            : modelName;
          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${right}`;
            if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
          }
          const available = Math.max(0, width - visibleWidth(left) - 2);
          right = truncateToWidth(right, available, "");
          const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
          const lines = [
            truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
            theme.fg("dim", left) + theme.fg("dim", padding + right),
          ];

          const statuses = [...footerData.getExtensionStatuses().entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatus(text));
          if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
          return lines;
        },
      };
    });
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    if (!installed || ctx.mode !== "tui") return;
    installed = false;
    ctx.ui.setFooter(undefined);
  });
};
