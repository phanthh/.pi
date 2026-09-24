import assert from "node:assert/strict";
import { formatIdle } from "./index.ts";

const cases: [number, string][] = [
	[-5, "0s"],
	[999, "0s"],
	[59_999, "59s"],
	[60_000, "1m00s"],
	[3_599_000, "59m59s"],
	[3_600_000, "1h00m"],
	[86_399_000, "23h59m"],
	[86_400_000 + 3 * 3_600_000, "1d3h"],
];
for (const [ms, want] of cases) assert.equal(formatIdle(ms), want, `formatIdle(${ms})`);
console.log("ok");
