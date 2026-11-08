/** Provider error text only; never scan the child's prose for refusal triggers. */
const REFUSAL_PATTERNS = [
  /flagged for possible cybersecurity risk/i,
  /\bcontent.?filter\b/i,
  /\bsafety.?(system|policy)\b/i,
  /\binvalid_prompt\b/i,
];
// Treat underscores as separators too (e.g. insufficient_quota, rate_limit_exceeded).
const NON_REFUSAL = /(?:^|[^a-z0-9])(?:unauthorized|unauthenticated|forbidden|authentication|authorization|invalid.?api.?key|invalid.?token|expired.?token|token.?expired|quota|rate.?limit(?:ed|ing)?|insufficient.?credits?|billing|timeout|timed.?out|econn\w*|enotfound|network|401|403|429|5\d\d)(?:$|[^a-z0-9])/i;

export function isProviderRefusal(error: string): boolean {
  return !NON_REFUSAL.test(error) && REFUSAL_PATTERNS.some((pattern) => pattern.test(error));
}
