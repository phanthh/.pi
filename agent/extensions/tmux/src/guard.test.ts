import assert from "node:assert/strict";
import { test } from "node:test";
import { blockReason, findBlockedTmuxCommand } from "./guard.ts";

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
		// quoted/heredoc data is not a command
		[`printf '%s\\n' "- tmux new-window blocked" >> complains.md`, undefined],
		["git commit -m 'avoid tmux kill-session'", undefined],
		["python3 - <<'EOF'\nsrc = 'tmux new-window'\nEOF\necho ok", undefined],
		["cat <<-EOF > f\n\ttmux kill-server\n\tEOF\ntmux new -d", "new"],
		["# tmux new-window\nls", undefined],
		// ...unless it is code
		['bash -c "tmux new-window"', "new-window"],
		["sh -lc 'tmux -L x ls; tmux kill-window'", "kill-window"],
		['echo "$(tmux new-window -P)"', "new-window"],
		["x=`tmux neww`", "neww"],
		["eval 'tmux new-session'", "new-session"],
		["bash <<EOF\ntmux new-window\nEOF", "new-window"],
		["sudo tmux kill-server", "kill-server"],
		["tmux split-window ';' kill-window", "kill-window"],
		["tmux display -p '#S' 2>&1", undefined],
	];
	for (const [command, expected] of cases) assert.equal(findBlockedTmuxCommand(command), expected, command);
});

test("block reason points at the scoped tools", () => {
	assert.match(blockReason("new-window"), /`tmux` tool .*`tmux_subagent` \(delegate → new session\)/);
});
