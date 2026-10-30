/**
 * Windows (tabs) and sessions are only created/killed through the `tmux` and
 * `tmux_subagent` tools, which tag and scope them to their owner.
 */

const BLOCKED: Record<string, true> = {
	"new-window": true, neww: true,
	"new-session": true, new: true,
	"break-pane": true, breakp: true,
	"link-window": true, linkw: true,
	"move-window": true, movew: true,
	"kill-window": true, killw: true,
	"kill-session": true,
	"kill-server": true,
};

// tmux global flags that take an argument.
const FLAG_WITH_ARG = /^-[cfLST]$/;

const TMUX_CMD_SEP = "\u0001";
const SHELL_SEP = "\u0000";

/**
 * Returns the first window/session-level tmux subcommand found in a shell
 * command string, or undefined. Commands on an isolated server (`-L`/`-S`)
 * are allowed: they can't touch the user's windows.
 */
export function findBlockedTmuxCommand(command: string): string | undefined {
	const tokens = command
		.replace(/\\;/g, ` ${TMUX_CMD_SEP} `)
		.replace(/&&|\|\||[;&|\n()`]/g, ` ${SHELL_SEP} `)
		.split(/\s+/)
		.map((t) => t.replace(/^['"]+|['"]+$/g, ""))
		.filter(Boolean);

	let inTmux = false;
	let expectSub = false;
	let isolated = false;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === SHELL_SEP) {
			inTmux = expectSub = isolated = false;
			continue;
		}
		if (t === TMUX_CMD_SEP) {
			if (inTmux) expectSub = true;
			continue;
		}
		if (!inTmux) {
			if (/(^|\/)tmux$/.test(t)) {
				inTmux = expectSub = true;
				isolated = false;
			}
			continue;
		}
		if (!expectSub) continue;
		if (t.startsWith("-")) {
			if (/^-[LS]/.test(t)) isolated = true;
			if (FLAG_WITH_ARG.test(t)) i++;
			continue;
		}
		expectSub = false;
		if (!isolated && Object.hasOwn(BLOCKED, t)) return t;
	}
	return undefined;
}

export function blockReason(sub: string): string {
	return (
		`Blocked \`tmux ${sub}\`: agents must not create/kill tmux windows or sessions directly. ` +
		"Use the `tmux` tool (own windows; completion is always automatic) or `tmux_subagent` (delegate → new session). " +
		"For scratch tmux testing use an isolated server (`tmux -L <name> ...`)."
	);
}
