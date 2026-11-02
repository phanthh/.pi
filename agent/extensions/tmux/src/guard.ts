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
const SHELLS = /(^|\/)(ba|z|da|k)?sh$/;

interface Word {
	text: string;
	quoted: boolean;
}

/**
 * Returns the first window/session-level tmux subcommand that the shell
 * command would run on the user's server, or undefined. Commands on an
 * isolated server (`-L`/`-S`) are allowed: they can't touch the user's windows.
 *
 * Shell-aware enough to not flag data: quoted strings and heredoc bodies are
 * skipped, except when they are code (`bash -c '...'`, `eval`, `$(...)`,
 * backticks, heredoc fed to a shell).
 */
export function findBlockedTmuxCommand(src: string): string | undefined {
	let found: string | undefined;
	const nested = (code: string) => {
		found ??= findBlockedTmuxCommand(code);
	};

	let words: Word[] = [];
	let cur: Word | undefined;
	const heredocs: { delim: string; dash: boolean; cmd: Word[] }[] = [];

	const endWord = () => {
		if (cur) words.push(cur);
		cur = undefined;
	};
	const endCommand = () => {
		endWord();
		const hit = checkCommand(words, nested);
		found ??= hit;
		words = [];
	};
	const add = (s: string, quoted = false) => {
		cur ??= { text: "", quoted: false };
		cur.text += s;
		if (quoted) cur.quoted = true;
	};

	let i = 0;
	while (i < src.length && !found) {
		const c = src[i];
		if (c === " " || c === "\t") {
			endWord();
			i++;
		} else if (c === "\n") {
			endCommand();
			i++;
			// Heredoc bodies start after the line that declared them.
			while (heredocs.length) {
				const h = heredocs.shift()!;
				const lines: string[] = [];
				while (i < src.length) {
					const nl = src.indexOf("\n", i);
					const line = src.slice(i, nl < 0 ? src.length : nl);
					i = nl < 0 ? src.length : nl + 1;
					if ((h.dash ? line.replace(/^\t+/, "") : line) === h.delim) break;
					lines.push(line);
				}
				const shell = h.cmd.find((w) => !w.quoted);
				if (shell && SHELLS.test(shell.text)) nested(lines.join("\n"));
			}
		} else if (";&|()".includes(c)) {
			endCommand();
			i++;
		} else if (c === "#" && !cur) {
			while (i < src.length && src[i] !== "\n") i++;
		} else if (c === "\\") {
			if (src[i + 1] === "\n") i += 2;
			else {
				add(src[i + 1] ?? "", true);
				i += 2;
			}
		} else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			add(src.slice(i + 1, end < 0 ? src.length : end), true);
			i = end < 0 ? src.length : end + 1;
		} else if (c === '"') {
			i++;
			let text = "";
			while (i < src.length && src[i] !== '"') {
				if (src[i] === "\\") {
					text += src[i + 1] ?? "";
					i += 2;
				} else if (src.startsWith("$(", i)) {
					const end = matchParen(src, i + 1);
					nested(src.slice(i + 2, end));
					i = end + 1;
				} else if (src[i] === "`") {
					const end = closingBacktick(src, i);
					nested(src.slice(i + 1, end));
					i = end + 1;
				} else text += src[i++];
			}
			add(text, true);
			i++;
		} else if (src.startsWith("$(", i)) {
			const end = matchParen(src, i + 1);
			nested(src.slice(i + 2, end));
			add("$()");
			i = end + 1;
		} else if (c === "`") {
			const end = closingBacktick(src, i);
			nested(src.slice(i + 1, end));
			add("``");
			i = end + 1;
		} else if (src.startsWith("<<", i) && src[i + 2] !== "<") {
			endWord();
			i += 2;
			const dash = src[i] === "-";
			if (dash) i++;
			while (src[i] === " " || src[i] === "\t") i++;
			let delim = "";
			while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
				if (src[i] !== "'" && src[i] !== '"' && src[i] !== "\\") delim += src[i];
				i++;
			}
			heredocs.push({ delim, dash, cmd: words });
		} else {
			add(c);
			i++;
		}
	}
	endCommand();
	return found;
}

/** Checks one simple command's words; recurses into code-valued args (`sh -c`, `eval`). */
function checkCommand(words: Word[], nested: (code: string) => void): string | undefined {
	for (let i = 1; i < words.length; i++) {
		const prev = words[i - 1].text;
		if (prev === "eval" || /^-[a-z]*c$/.test(prev)) nested(words[i].text);
	}
	let inTmux = false;
	let expectSub = false;
	let isolated = false;
	for (let i = 0; i < words.length; i++) {
		const { text: t, quoted } = words[i];
		if (!inTmux) {
			if (!quoted && /(^|\/)tmux$/.test(t)) inTmux = expectSub = true;
			continue;
		}
		// `\;` / `';'`: tmux command separator
		if (t === ";") {
			expectSub = true;
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

/** Index of the `)` closing the `(` at open; skips quoted text. */
function matchParen(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			i = end < 0 ? src.length : end;
		}
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return src.length;
}

function closingBacktick(src: string, open: number): number {
	for (let i = open + 1; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === "`") return i;
	}
	return src.length;
}

export function blockReason(sub: string): string {
	return (
		`Blocked \`tmux ${sub}\`: agents must not create/kill tmux windows or sessions directly. ` +
		"Use the `tmux` tool (own windows; completion is always automatic) or `tmux_subagent` (delegate → new session). " +
		"For scratch tmux testing use an isolated server (`tmux -L <name> ...`)."
	);
}
