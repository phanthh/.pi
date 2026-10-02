import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import type { SessionProjection } from "@earendil-works/pi-coding-agent";

export const LIVE_CONTEXT_SKILL_PATH = fileURLToPath(new URL("../../../../skills/live_context/SKILL.md", import.meta.url));

type ProjectedEntry = SessionProjection["entries"][number];
type AgentMessage = SessionProjection["messages"][number];

interface DocumentMessage {
  id: string;
  source: ProjectedEntry;
  message: AgentMessage;
  header: string;
  footer: string;
  text: string;
}

export interface LiveDocument {
  text: string;
  revision: string;
  sessionId: string;
  leafId: string | null;
  delimiter: string;
  header: string;
  footer: string;
  messages: DocumentMessage[];
  original: SessionProjection;
}

export interface LiveEdits {
  projection: SessionProjection;
  entries: SessionProjection["entries"];
  messages: AgentMessage[];
  edits: number;
  changed: boolean;
}

interface EditedMessage {
  message: AgentMessage;
  source?: ProjectedEntry;
  id?: string;
}

const HIDDEN_DISPLAY_FIELDS: Record<string, true> = {
  thinkingSignature: true, textSignature: true, thoughtSignature: true,
  metadata: true, $metadata: true, timestamp: true,
};

function display(value: unknown): string {
  return JSON.stringify(value, function (key, item) {
    if (this === value && Object.hasOwn(HIDDEN_DISPLAY_FIELDS, key)) return undefined;
    return key === "data" && typeof item === "string"
      ? `[${item.length} characters retained in original]` : item;
  }, 2);
}

function messageText(message: AgentMessage): string {
  if ("content" in message) {
    if (typeof message.content === "string") return message.content;
    return message.content.map((block) => block.type === "text" ? block.text : display(block)).join("\n\n");
  }
  if ("summary" in message && typeof message.summary === "string") return message.summary;
  return display(message);
}

/** Original objects are retained out of band; edited bodies never reconstruct structured messages. */
export function createLiveDocument(
  projection: SessionProjection,
  options: { sessionId: string; leafId: string | null; revision: string; protectedUserId?: string },
): LiveDocument {
  const original = structuredClone(projection);
  const messages: DocumentMessage[] = [];
  const indexes = new Map<string, number>();
  for (const source of original.entries) {
    for (const message of source.messages) {
      if (message.role === "system") continue;
      const id = source.sourceEntry.id;
      const index = indexes.get(id) ?? 0;
      indexes.set(id, index + 1);
      messages.push({ id: `${id}/${index}`, source, message, header: "", footer: "", text: messageText(message) });
    }
  }
  const seed = createHash("sha256").update(options.revision).digest("hex").slice(0, 24);
  let counter = 0;
  let delimiter: string;
  do {
    delimiter = `<<<CTX:${seed}:${counter++}>>>`;
  } while (messages.some((message) => message.text.includes(delimiter)));
  const boundary = (label: string) => `${delimiter} ${label}\n`;
  const header = boundary(`document ${JSON.stringify({ sessionId: options.sessionId, leafId: options.leafId, revision: options.revision })}`) +
    `Read ${JSON.stringify(LIVE_CONTEXT_SKILL_PATH)} before inspecting or editing this mirror.\n`;
  const footer = boundary("end document");
  let text = header;
  for (const message of messages) {
    message.header = boundary(`entry ${JSON.stringify(message.id)} role ${JSON.stringify(message.message.role)}`);
    message.footer = boundary(`end entry ${JSON.stringify(message.id)}`);
    text += `${message.header}${message.text}\n${message.footer}`;
  }
  text += footer;
  return { text, revision: options.revision, sessionId: options.sessionId, leafId: options.leafId, delimiter, header, footer, messages, original };
}

function note(role: string, text: string): AgentMessage {
  return { role: "user", content: `[Context mirror role: ${JSON.stringify(role)}]\n${text}`, timestamp: 0 };
}

function flattenBrokenTools(entries: ProjectedEntry[]): { entries: ProjectedEntry[]; edits: number } {
  const messages = entries.flatMap((entry) => entry.messages);
  const owners = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  const groups = new Map<number, string[]>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      const ids = message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
      if (ids.length) groups.set(index, ids);
      for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), index]);
    } else if (message.role === "toolResult") {
      results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), index]);
    }
  }
  const broken = new Set<number>();
  for (const [owner, ids] of groups) {
    const remaining = new Set(ids);
    let valid = remaining.size === ids.length && ids.every((id) => owners.get(id)!.length === 1 && results.get(id)?.length === 1);
    for (let offset = 1; offset <= ids.length; offset++) {
      const result = messages[owner + offset];
      if (result?.role !== "toolResult" || !remaining.delete(result.toolCallId)) valid = false;
    }
    if (!valid || remaining.size) {
      broken.add(owner);
      for (const id of ids) for (const result of results.get(id) ?? []) broken.add(result);
    }
  }
  for (const [id, indexes] of results) {
    if (!owners.has(id)) for (const index of indexes) broken.add(index);
  }
  let index = 0;
  const normalized = entries.map((entry) => {
    let changed = false;
    const content = entry.messages.map((message) => {
      if (!broken.has(index++)) return message;
      changed = true;
      return note(message.role, messageText(message));
    });
    if (!changed) return entry;
    const sourceEntry = content[0]?.role === "user" ? {
      type: "message" as const, id: entry.sourceEntry.id, parentId: entry.sourceEntry.parentId,
      timestamp: entry.sourceEntry.timestamp, message: content[0],
    } : entry.sourceEntry;
    return { sourceEntry, messages: content };
  });
  return { entries: normalized, edits: broken.size };
}

/** Project a complete edit without mutating session history or trusting editor-supplied authority. */
export function parseLiveEdits(text: string, baseline: LiveDocument, current: SessionProjection): LiveEdits {
  const bySourceId = (projection: SessionProjection): Map<string, ProjectedEntry[]> => {
    const result = new Map<string, ProjectedEntry[]>();
    for (const entry of projection.entries) {
      const id = entry.sourceEntry.id;
      const group = result.get(id) ?? [];
      group.push(entry);
      result.set(id, group);
    }
    return result;
  };
  const currentById = bySourceId(current);
  const originalById = bySourceId(baseline.original);
  const originalIds = new Set(originalById.keys());
  for (const [id, entries] of originalById) {
    if (!isDeepStrictEqual(currentById.get(id), entries)) throw new Error(`Stale live context target ${id}`);
  }
  const appended = current.entries.filter((entry) => !originalIds.has(entry.sourceEntry.id));
  const synthetic = (id: string, message: AgentMessage): ProjectedEntry => ({
    sourceEntry: { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message },
    messages: [message],
  });
  const freshId = (label: string, occupied: Set<string>): string => {
    const seed = createHash("sha256").update(`${baseline.revision}/${label}`).digest("hex").slice(0, 16);
    let id = `new-${label}-${seed}`;
    let counter = 0;
    while (occupied.has(id)) id = `new-${label}-${seed}-${++counter}`;
    return id;
  };
  const result = (projection: SessionProjection, edits: number, changed: boolean): LiveEdits => {
    const snapshot = structuredClone(projection);
    return { projection: snapshot, entries: snapshot.entries, messages: snapshot.messages, edits, changed };
  };
  const finish = (edited: EditedMessage[], edits: number): LiveEdits => {
    if (!edits) return result(current, 0, false);
    const entries: ProjectedEntry[] = baseline.original.entries
      .map((entry) => ({ ...entry, messages: entry.messages.filter((message) => message.role === "system") }))
      .filter((entry) => entry.messages.length || !originalById.get(entry.sourceEntry.id)!.some((source) => source.messages.length));
    const occupied = new Set([...currentById.keys(), ...edited.flatMap((item) => item.id ? [item.id] : [])]);
    const emitted = new Set<ProjectedEntry>();
    const sourceByEntry = new Map<ProjectedEntry, ProjectedEntry>();
    let previousSource: ProjectedEntry | undefined;
    for (const item of edited) {
      if (item.source && item.source === previousSource) {
        entries.at(-1)!.messages.push(item.message);
      } else if (item.source && !emitted.has(item.source)) {
        const entry = { ...item.source, messages: [item.message] };
        entries.push(entry);
        sourceByEntry.set(entry, item.source);
        emitted.add(item.source);
      } else {
        const generatedId = item.id ?? freshId("split", occupied);
        occupied.add(generatedId);
        entries.push(synthetic(generatedId, item.message));
      }
      previousSource = item.source;
    }
    for (const entry of entries) {
      const source = sourceByEntry.get(entry);
      if (source && entry.messages.length && entry.messages[0].role === "user" &&
        !isDeepStrictEqual(entry.messages, source.messages.filter((message) => message.role !== "system"))) {
        entry.sourceEntry = {
          type: "message", id: entry.sourceEntry.id, parentId: entry.sourceEntry.parentId,
          timestamp: entry.sourceEntry.timestamp, message: entry.messages[0],
        };
      }
    }
    entries.push(...appended);
    const normalized = flattenBrokenTools(entries);
    const projection = { ...current, entries: normalized.entries, messages: normalized.entries.flatMap((entry) => entry.messages) };
    const changed = !isDeepStrictEqual(projection, current);
    return result(changed ? projection : current, changed ? edits + normalized.edits : 0, changed);
  };
  if (!text.includes(baseline.delimiter)) {
    if (/<<<(?:CTX|CLM):/.test(text)) throw new Error("Stale or malformed live context delimiter");
    const edited = text.trim() ? [{ message: note("note", text), id: freshId("rewrite", new Set(currentById.keys())) }] : [];
    return finish(edited, baseline.messages.length + (text.trim() ? 1 : 0));
  }
  if (!text.startsWith(baseline.header) || !text.endsWith(baseline.footer)) {
    throw new Error("Live context document metadata or boundaries changed");
  }
  const byId = new Map(baseline.messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const retainedIds: string[] = [];
  const messages: EditedMessage[] = [];
  let edits = 0;
  let position = baseline.header.length;
  const end = text.length - baseline.footer.length;
  const jsonString = '"(?:[^"\\\\\r\n]|\\\\[^\r\n])*"';
  const entryPattern = new RegExp(`^entry (${jsonString}) role (${jsonString})$`);
  while (position < end) {
    const lineEnd = text.indexOf("\n", position);
    if (lineEnd < 0 || lineEnd >= end || !text.startsWith(`${baseline.delimiter} `, position)) {
      throw new Error("Live context entry header missing");
    }
    const match = entryPattern.exec(text.slice(position + baseline.delimiter.length + 1, lineEnd));
    if (!match) throw new Error("Malformed live context entry header");
    const id: string = JSON.parse(match[1]);
    const role: string = JSON.parse(match[2]);
    if (!role.trim() || /[\r\n]/.test(role)) throw new Error("Invalid live context role label");
    if (seen.has(id)) throw new Error(`Duplicate live context ID ${id}`);
    seen.add(id);
    const original = byId.get(id);
    if (!original && (!/^new-[\w.-]+$/.test(id) || currentById.has(id))) {
      throw new Error(`Unknown, duplicate, or stale live context ID ${id}; new entries need unique new-* IDs`);
    }
    const bodyStart = lineEnd + 1;
    const bodyEnd = text.indexOf(`\n${baseline.delimiter}`, bodyStart);
    if (bodyEnd < 0 || bodyEnd >= end) throw new Error("Live context entry boundary missing");
    const body = text.slice(bodyStart, bodyEnd);
    if (body.includes(baseline.delimiter)) throw new Error("Live context delimiter appears inside a body");
    const footer = `${baseline.delimiter} end entry ${JSON.stringify(id)}\n`;
    position = bodyEnd + 1;
    if (!text.startsWith(footer, position)) throw new Error("Live context entry end ID or boundary changed");
    position += footer.length;
    if (original) retainedIds.push(id);
    if (original && role === original.message.role && body === original.text) {
      messages.push({ message: original.message, source: original.source });
    } else {
      messages.push({ message: note(role, body), source: original?.source, id: original ? undefined : id });
      edits++;
    }
  }
  if (position !== end) throw new Error("Unexpected live context trailing data");
  edits += baseline.messages.filter((message) => !seen.has(message.id)).length;
  const retainedOrder = baseline.messages.filter((message) => seen.has(message.id)).map((message) => message.id);
  if (!isDeepStrictEqual(retainedIds, retainedOrder)) edits++;
  return finish(messages, edits);
}
