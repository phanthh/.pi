/**
 * Bordered list box shared by the tmux-backed widgets (subagents, tmux windows):
 *   ╭─ Title ───────── info ─╮
 *   │ left            right │
 *   ╰───────────────────────╯
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

export interface BoxRow {
  left: string;
  right: string;
}

export function formatElapsedMMSS(startTime: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const truncLeft = truncateToWidth(left, Math.max(0, contentWidth - rightVis));
  const pad = Math.max(0, contentWidth - visibleWidth(truncLeft) - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, inner - titlePart.length - infoPart.length));
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;
  return `${ACCENT}╰${"─".repeat(Math.max(0, width - 2))}╯${RST}`;
}

/**
 * Shared widget slot. pi orders widgets by last `setWidget` call, and both
 * tmux-backed widgets re-set every second, so separate keys swap places.
 * One key + fixed section order keeps the stack stable. Lower order renders
 * higher. State lives on globalThis: each extension may load its own copy of
 * this module.
 */
export const SECTION_ORDER = { tmux: 0, subagents: 1 } as const;

const STACK_WIDGET_KEY = "tmux-stack";
const STACK_STATE_KEY = Symbol.for("pi-tmux-windows/widget-stack");

type SectionRender = (width: number) => string[];
interface StackUi {
  setWidget: (key: string, content: any, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
}

function sections(): Map<string, { order: number; render: SectionRender }> {
  const g = globalThis as any;
  g[STACK_STATE_KEY] ??= new Map();
  return g[STACK_STATE_KEY];
}

/** Set (render) or clear (undefined) one section of the shared widget. May throw on stale ui. */
export function setStackSection(ui: StackUi, id: string, order: number, render: SectionRender | undefined): void {
  const map = sections();
  if (render) map.set(id, { order, render });
  else map.delete(id);
  if (map.size === 0) {
    ui.setWidget(STACK_WIDGET_KEY, undefined);
    return;
  }
  ui.setWidget(
    STACK_WIDGET_KEY,
    () => ({
      invalidate() {},
      render: (width: number) =>
        [...sections().values()].sort((a, b) => a.order - b.order).flatMap((section) => section.render(width)),
    }),
    { placement: "aboveEditor" },
  );
}

export function renderBox(title: string, info: string, rows: BoxRow[], width: number): string[] {
  return [
    borderTop(title, info, width),
    ...rows.map((row) => borderLine(row.left, row.right, width)),
    borderBottom(width),
  ];
}
