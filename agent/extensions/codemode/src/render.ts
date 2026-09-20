import { keyHint, truncateToVisualLines, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

const OUTPUT_PREVIEW_LINES = 5;

export function renderCodeResult(output: string, expanded: boolean, theme: Theme): Component {
	if (!output) return new Text("", 0, 0);
	const styled = output
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	if (expanded) return new Text(`\n${styled}`, 0, 0);

	return {
		render(width) {
			const preview = truncateToVisualLines(styled, OUTPUT_PREVIEW_LINES, width);
			if (preview.skippedCount === 0) return ["", ...preview.visualLines];
			const hint =
				theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) +
				` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			return ["", truncateToWidth(hint, width, "..."), ...preview.visualLines];
		},
		invalidate() {},
	};
}
