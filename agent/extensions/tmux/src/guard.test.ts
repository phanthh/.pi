import assert from "node:assert/strict";
import { test } from "node:test";
import { findBlockedTmuxCommand } from "./guard.ts";

test("blocks window/session commands on the user's server", () => {
	const cases: Array<[string, string | undefined]> = [
		["tmux new-window", "new-window"],
		["/usr/bin/tmux -f x.conf neww -d", "neww"],
		["echo hi && tmux kill-session -t main", "kill-session"],
		["tmux split-window \\; break-pane", "break-pane"],
		["tmux split-window -h", undefined],
		["tmux -L scratch new-session -d", undefined],
		["tmux -Sscratch.sock kill-server", undefined],
		["tmux -L scratch ls; tmux new -d", "new"],
		["echo new-window", undefined],
	];
	for (const [command, expected] of cases) assert.equal(findBlockedTmuxCommand(command), expected, command);
});
