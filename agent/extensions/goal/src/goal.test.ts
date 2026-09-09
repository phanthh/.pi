import { strict as assert } from "node:assert";
import { parseGoalArgs, turnTokens } from "./index.ts";

assert.deepEqual(parseGoalArgs("fix the parser"), { objective: "fix the parser" });
assert.deepEqual(parseGoalArgs("--budget 500k fix the parser"), { objective: "fix the parser", budget: 500_000 });
assert.deepEqual(parseGoalArgs("--budget=2M ship it"), { objective: "ship it", budget: 2_000_000 });
assert.deepEqual(parseGoalArgs("--budget 1200 x"), { objective: "x", budget: 1200 });
assert.deepEqual(parseGoalArgs("--budget alone"), { objective: "--budget alone" });

assert.equal(turnTokens(undefined), 0);
assert.equal(turnTokens({ input: 10, output: 5, cacheWrite: 100 }), 115); // cacheRead excluded

console.log("goal self-check ok");
