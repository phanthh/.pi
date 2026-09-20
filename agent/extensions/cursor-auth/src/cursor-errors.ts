import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";

export interface CursorUpstreamError {
  code: string;
  message: string;
  retryable: boolean;
}

interface DisplayDetails {
  title?: string;
  detail?: string;
  retryable?: boolean;
  additionalInfo: Map<string, string>;
}

const RETRYABLE_CONNECT_CODES = new Set(["internal", "unavailable", "deadline_exceeded"]);
const MAX_DETAIL_BYTES = 64 * 1024;
const MAX_DETAILS = 32;
const MAX_INFO_ENTRIES = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function skip(reader: BinaryReader, wire: WireType): void {
  // These proto3 messages contain no groups; avoid recursive skipping of them.
  if (wire === WireType.StartGroup || wire === WireType.EndGroup) throw new Error("Invalid wire type");
  reader.skip(wire);
}

function readInfo(bytes: Uint8Array): [string, string] {
  const reader = new BinaryReader(bytes);
  let key = "";
  let value = "";
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (wire === WireType.LengthDelimited && field === 1) key = reader.string();
    else if (wire === WireType.LengthDelimited && field === 2) value = reader.string();
    else skip(reader, wire);
  }
  return [key, value];
}

/** The display fields of aiserver.v1.CustomErrorDetails, not an error catalog. */
function readDisplayDetails(bytes: Uint8Array, display: DisplayDetails): void {
  const reader = new BinaryReader(bytes);
  let infoEntries = 0;
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (wire === WireType.LengthDelimited && field === 1) display.title = reader.string();
    else if (wire === WireType.LengthDelimited && field === 2) display.detail = reader.string();
    else if (wire === WireType.Varint && field === 4) display.retryable = reader.bool();
    else if (wire === WireType.LengthDelimited && field === 7) {
      if (++infoEntries > MAX_INFO_ENTRIES) throw new Error("Too many display fields");
      const [key, value] = readInfo(reader.bytes());
      display.additionalInfo.set(key, value);
    } else skip(reader, wire);
  }
}

/** Cursor's direct client decodes value; debug is diagnostic data, not display text. */
function decodeDetails(detail: unknown): DisplayDetails | undefined {
  if (!isRecord(detail) || typeof detail.type !== "string" ||
    detail.type.split("/").at(-1) !== "aiserver.v1.ErrorDetails" ||
    typeof detail.value !== "string" || detail.value.length > Math.ceil(MAX_DETAIL_BYTES / 3) * 4) return;
  const base64 = detail.value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(base64)) return;
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_DETAIL_BYTES) return;
    const reader = new BinaryReader(bytes);
    const display: DisplayDetails = { additionalInfo: new Map() };
    while (reader.pos < reader.len) {
      const [field, wire] = reader.tag();
      // ErrorDetails.details is field 2. Its enum and analytics are not user text.
      if (field === 2 && wire === WireType.LengthDelimited) readDisplayDetails(reader.bytes(), display);
      else skip(reader, wire);
    }
    return display;
  } catch {
    return;
  }
}

function displayMessage(display: DisplayDetails | undefined): string | undefined {
  if (!display) return;
  const parts = [display.title, display.detail].filter((text): text is string => typeof text === "string" && text.length > 0);
  // These are the same additionalInfo entries rendered by Cursor's CLI.
  for (const [key, value] of display.additionalInfo) parts.push(`${key}: ${value}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Read Cursor's own display strings; fall back to its raw Connect message. */
export function parseCursorError(data: Uint8Array): CursorUpstreamError | null {
  if (data.length === 0) return null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(data));
    if (!isRecord(payload) || !isRecord(payload.error)) return null;
    const error = payload.error;
    const code = typeof error.code === "string" ? error.code : "unknown";
    let display: DisplayDetails | undefined;
    if (Array.isArray(error.details)) {
      for (const detail of error.details.slice(0, MAX_DETAILS)) {
        display = decodeDetails(detail);
        if (display) break;
      }
    }
    return {
      code,
      message: displayMessage(display) ?? (typeof error.message === "string" ? error.message : code),
      retryable: display?.retryable ?? RETRYABLE_CONNECT_CODES.has(code),
    };
  } catch {
    // Preserve support for the empty/non-JSON success terminators used by Cursor.
    return null;
  }
}
