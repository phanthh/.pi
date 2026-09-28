import type { UsageLimit, UsageReport } from "./types.ts";
import { formatDuration } from "./util.ts";

export type Paint = (color: "muted" | "dim" | "warning" | "error" | "accent", text: string) => string;

function usageColor(fraction: number): "muted" | "warning" | "error" {
	if (fraction >= 0.8) return "error";
	if (fraction >= 0.5) return "warning";
	return "muted";
}

/**
 * Windows shown in the footer: account-wide gates (shortest first) plus a
 * model-scoped weekly row when the active model belongs to its family.
 */
export function footerLimits(report: UsageReport, modelId: string | undefined): UsageLimit[] {
	const model = modelId?.toLowerCase() ?? "";
	const shared = report.limits
		.filter((limit) => limit.shared && limit.usedFraction !== undefined)
		.sort((a, b) => (a.durationMs ?? Number.MAX_SAFE_INTEGER) - (b.durationMs ?? Number.MAX_SAFE_INTEGER));
	const scoped = report.limits.filter(
		(limit) => limit.tier && limit.usedFraction !== undefined && model.includes(limit.tier),
	);
	return [...shared, ...scoped];
}

export function formatFooter(
	report: UsageReport,
	modelId: string | undefined,
	paint: Paint,
	now = Date.now(),
): string | undefined {
	const parts = footerLimits(report, modelId).map((limit) => {
		const fraction = limit.usedFraction ?? 0;
		const tag = limit.tier ? `${limit.windowTag ?? ""}·${limit.tier}` : (limit.windowTag ?? limit.label);
		const pct = paint(usageColor(fraction), `${Math.round(fraction * 100)}%`);
		const reset =
			limit.resetsAt !== undefined && limit.resetsAt > now ? paint("dim", ` ${formatDuration(limit.resetsAt - now)}`) : "";
		return `${paint("dim", tag)} ${pct}${reset}`;
	});
	if (parts.length === 0) return undefined;
	return parts.join(paint("dim", " · "));
}
