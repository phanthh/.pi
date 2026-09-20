import { estimateTokens } from "./memory.ts";

/** Select whole items within a token budget, preserving their original order. */
export const selectWithinBudget = <T>(
  items: readonly T[],
  budget: number,
  render: (item: T) => string,
  newestFirst = false,
): T[] => {
  const selected: T[] = [];
  let used = 0;
  const step = newestFirst ? -1 : 1;
  for (let index = newestFirst ? items.length - 1 : 0; index >= 0 && index < items.length; index += step) {
    const item = items[index];
    const cost = estimateTokens(render(item));
    if (used + cost > budget) continue;
    used += cost;
    selected.push(item);
  }
  return newestFirst ? selected.reverse() : selected;
};

/** Reserve exact fixed prompt cost, then split remaining input across stage sections. */
export const sectionBudgets = (
  inputMaxTokens: number,
  fixedText: string,
): { candidates: number; existing: number } => {
  const available = Math.max(0, inputMaxTokens - estimateTokens(fixedText));
  return {
    candidates: Math.floor(available * 0.55),
    existing: Math.floor(available * 0.15),
  };
};
