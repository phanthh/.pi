// /goal <objective> pins objective into system prompt and auto-nudges the agent
// after each run until it calls goal(complete|drop). ESC halts nudging until next user msg.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface GoalState {
	objective: string;
	nudges: number;
}

const ENTRY_TYPE = "goal";
const NUDGE_TYPE = "goal-nudge";

export default function (pi: ExtensionAPI) {
	let goal: GoalState | null = null;
	let armed = true; // false after user abort until next interactive input
	let lastTurnHadTools = false;

	type Ctx = { ui: { setStatus(key: string, text: string | undefined): void } };
	const showStatus = (ctx: Ctx) =>
		ctx.ui.setStatus(
			"goal",
			goal ? `🎯 ${goal.objective.slice(0, 40)}${goal.objective.length > 40 ? "…" : ""} · nudges ${goal.nudges}` : undefined,
		);
	const persist = (ctx: Ctx) => {
		pi.appendEntry(ENTRY_TYPE, goal);
		showStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		goal = null;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "custom" && e.customType === ENTRY_TYPE) goal = (e.data as GoalState | null) ?? null;
		}
		armed = true;
		showStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!goal) return;
		return {
			systemPrompt: `${event.systemPrompt}

# Active goal

Objective: ${goal.objective}

You are in goal mode. Work autonomously toward the objective across turns. When you stop, you will be nudged to continue.
Do NOT call goal(complete) until you have verified the objective is actually met (ran tests/checks, inspected results). Budget exhaustion or fatigue is not completion.
Call goal(drop) if the objective is impossible or needs user input that blocks all progress.`,
		};
	});

	pi.on("input", async (event) => {
		if (event.source === "interactive") armed = true;
	});

	pi.on("turn_end", async (event) => {
		lastTurnHadTools = event.toolResults.length > 0;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!goal || !armed) return;
		const last = event.messages.at(-1);
		if (last?.role === "assistant" && last.stopReason === "aborted") {
			armed = false;
			return;
		}
		if (!lastTurnHadTools) return; // talk-only turn = stalled/asking → wait for user
		goal.nudges++;
		persist(ctx);
		pi.sendMessage(
			{
				customType: NUDGE_TYPE,
				content: `Goal still active: ${goal.objective}\nContinue working. Call goal(complete) only when verified done, goal(drop) if impossible.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description: "Finish goal mode. op=complete when objective verified met (requires summary); op=drop when impossible/blocked.",
		parameters: Type.Object({
			op: Type.Union([Type.Literal("complete"), Type.Literal("drop")]),
			summary: Type.Optional(Type.String({ description: "What was done and how it was verified (required for complete)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!goal) return { content: [{ type: "text", text: "No active goal." }], details: undefined };
			if (params.op === "complete" && !params.summary?.trim()) {
				return { content: [{ type: "text", text: "complete requires summary." }], details: undefined };
			}
			const obj = goal.objective;
			goal = null;
			persist(ctx);
			return {
				content: [{ type: "text", text: `Goal ${params.op === "complete" ? "completed" : "dropped"}: ${obj}` }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("goal", {
		description: "/goal <objective> | /goal (show) | /goal drop",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(goal ? `🎯 ${goal.objective} (nudges ${goal.nudges})` : "No active goal.", "info");
				return;
			}
			if (text === "drop") {
				goal = null;
				persist(ctx);
				ctx.ui.notify("Goal dropped.", "info");
				return;
			}
			goal = { objective: text, nudges: 0 };
			armed = true;
			persist(ctx);
			pi.sendMessage(
				{ customType: NUDGE_TYPE, content: `Goal set: ${text}\nStart working toward it now.`, display: true },
				{ triggerTurn: true },
			);
		},
	});
}
