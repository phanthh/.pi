/** Strict parsing/validation for OM worker JSON replies. */
import { contentKey, RELEVANCE_WEIGHT, stripSourceLabels, type Relevance } from "./memory.ts";

export const MAX_CONTENT_CHARS = 500;
export const MAX_OBSERVATIONS = 12;
export const MAX_REFLECTIONS = 12;

export interface ParsedObservation { content: string; relevance: Relevance; sourceIds: string[] }
export interface ParsedReflection { content: string; supportingObservationIds: string[] }
export interface ParseResult { observations: ParsedObservation[]; rejected: number }
export interface ReflectionParseResult { reflections: ParsedReflection[]; rejected: number }

const isRelevance = (value: unknown): value is Relevance =>
  typeof value === "string" && Object.hasOwn(RELEVANCE_WEIGHT, value);
const field = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  return Reflect.get(value, key);
};

const parseObject = (raw: string): Record<string, unknown> | null => {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
};

const cleanContent = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const content = value.trim();
  return content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}…` : content;
};

export const parseObservations = (raw: string, validSourceIds: Set<string>): ParseResult => {
  const parsed = parseObject(raw);
  const list = parsed?.observations;
  if (!Array.isArray(list)) return { observations: [], rejected: 0 };
  const observations: ParsedObservation[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const item of list) {
    if (observations.length >= MAX_OBSERVATIONS) { rejected++; continue; }
    const rawContent = field(item, "content");
    const withoutCitations = typeof rawContent === "string" ? stripSourceLabels(rawContent) : rawContent;
    const content = cleanContent(withoutCitations);
    const rawIds = field(item, "sourceIds");
    const sourceIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.filter((id): id is string => typeof id === "string" && validSourceIds.has(id)))]
      : [];
    const key = contentKey(content);
    if (!content || sourceIds.length === 0 || seen.has(key)) { rejected++; continue; }
    seen.add(key);
    const relevance = field(item, "relevance");
    observations.push({ content, relevance: isRelevance(relevance) ? relevance : "medium", sourceIds });
  }
  return { observations, rejected };
};

/** Any unknown support id rejects the whole reflection: false coverage can cause unsafe drops. */
export const parseReflections = (raw: string, validObservationIds: Set<string>): ReflectionParseResult => {
  const parsed = parseObject(raw);
  const list = parsed?.reflections;
  if (!Array.isArray(list)) return { reflections: [], rejected: 0 };
  const reflections: ParsedReflection[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const item of list) {
    if (reflections.length >= MAX_REFLECTIONS) { rejected++; continue; }
    const content = cleanContent(field(item, "content"));
    const rawIds = field(item, "supportingObservationIds");
    const ids = Array.isArray(rawIds) && rawIds.every((id): id is string => typeof id === "string")
      ? [...new Set(rawIds)]
      : [];
    const key = contentKey(content);
    if (!content || /[\r\n]/.test(content) || ids.length === 0 || ids.some((id) => !validObservationIds.has(id)) || seen.has(key)) {
      rejected++;
      continue;
    }
    seen.add(key);
    reflections.push({ content, supportingObservationIds: ids });
  }
  return { reflections, rejected };
};

export const parseDropIds = (raw: string, validObservationIds: Set<string>): string[] => {
  const parsed = parseObject(raw);
  const ids = parsed?.ids;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && validObservationIds.has(id)))];
};
