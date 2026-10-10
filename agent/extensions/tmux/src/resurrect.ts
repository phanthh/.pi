import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Publish session identity without adding entries to the conversation. */
export function registerResurrect(pi: ExtensionAPI): void {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	let resume: (() => Promise<void>) | undefined;
	let publishing = Promise.resolve();
	function detachResume() {
		if (resume) process.removeListener("SIGCONT", resume);
		resume = undefined;
	}
	pi.on("session_shutdown", async () => {
		detachResume();
		await publishing;
	});

	pi.on("session_start", async (_event, ctx) => {
		detachResume();
		await publishing;
		// Print/RPC processes can inherit TMUX_PANE from a running interactive Pi.
		if (ctx.mode !== "tui") return;
		const metadata = JSON.stringify({
			pid: process.pid,
			file: ctx.sessionManager.getSessionFile() ?? null,
		});
		const publish = async () => {
			const operation = publishing.then(() => pi.exec("tmux", [
				"set-option", "-p", "-t", pane, "@pi_resurrect", metadata,
			], { timeout: 2000 }));
			publishing = operation.then(() => {}, () => {});
			const result = await operation;
			if (result.code !== 0) {
				throw new Error(result.stderr || `tmux exited with ${result.code}`);
			}
		};
		const onResume = async () => {
			try {
				const result = await pi.exec("ps", ["-p", String(process.pid), "-o", "pgid=,tpgid="], { timeout: 2000 });
				if (result.code !== 0) throw new Error(result.stderr || "Could not check foreground process group");
				const [group, foreground] = result.stdout.trim().split(/\s+/).map(Number);
				// `bg` also sends SIGCONT; only `fg` should reclaim pane metadata.
				if (resume === onResume && group > 0 && group === foreground) await publish();
			} catch (error) {
				if (resume === onResume) {
					ctx.ui.notify(`Could not publish Pi session for tmux-resurrect: ${String(error)}`, "warning");
				}
			}
		};
		resume = onResume;
		process.on("SIGCONT", onResume);
		try {
			await publish();
		} catch (error) {
			ctx.ui.notify(`Could not publish Pi session for tmux-resurrect: ${String(error)}`, "warning");
		}
		// Tags survive reload; the save hook rejects dead/background/wrong-pane PIDs.
	});
}
