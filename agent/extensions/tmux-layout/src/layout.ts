/** Pure tmux layout codec and sizing. No tmux processes or pane options. */
export interface Rect {
  width: number;
  height: number;
  left: number;
  top: number;
}

export type PaneCell = Rect & { paneId: string };
export type LayoutCell = PaneCell | (Rect & {
  axis: "horizontal" | "vertical";
  children: LayoutCell[];
});

/** tmux format: checksum,WxH,x,y{columns} / [rows]. */
export function parseLayout(layout: string): LayoutCell {
  let offset = layout.indexOf(",") + 1;
  function parse(): LayoutCell {
    const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(layout.slice(offset));
    if (!match) throw new Error(`Invalid tmux layout: ${layout}`);
    offset += match[0].length;
    const rect: Rect = { width: +match[1], height: +match[2], left: +match[3], top: +match[4] };
    const delimiter = layout[offset];
    if (delimiter !== "{" && delimiter !== "[") {
      const pane = /^,(\d+)/.exec(layout.slice(offset));
      if (!pane) throw new Error(`Missing pane in tmux layout: ${layout}`);
      offset += pane[0].length;
      return { ...rect, paneId: `%${pane[1]}` };
    }
    offset++;
    const children: LayoutCell[] = [];
    do {
      children.push(parse());
      if (layout[offset] !== ",") break;
      offset++;
    } while (true);
    if (layout[offset++] !== (delimiter === "{" ? "}" : "]")) throw new Error(`Invalid tmux layout: ${layout}`);
    return { ...rect, axis: delimiter === "{" ? "horizontal" : "vertical", children };
  }
  return parse();
}

export function leaves(cell: LayoutCell): PaneCell[] {
  return "paneId" in cell ? [cell] : cell.children.flatMap(leaves);
}

/** Keep the user's split tree, removing only tagged worker leaves. */
export function userRegion(cell: LayoutCell, workers: Set<string>): LayoutCell | undefined {
  if ("paneId" in cell) return workers.has(cell.paneId) ? undefined : cell;
  const children = cell.children.map((child) => userRegion(child, workers)).filter((child) => child !== undefined);
  return children.length === 0 ? undefined : children.length === 1 ? children[0] : { ...cell, children };
}

export function formatLayout(cell: LayoutCell): string {
  function serialize(cell: LayoutCell): string {
    const rect = `${cell.width}x${cell.height},${cell.left},${cell.top}`;
    if ("paneId" in cell) return `${rect},${cell.paneId.slice(1)}`;
    const [open, close] = cell.axis === "horizontal" ? ["{", "}"] : ["[", "]"];
    return `${rect}${open}${cell.children.map(serialize).join(",")}${close}`;
  }
  const body = serialize(cell);
  let checksum = 0;
  for (const char of body) checksum = (((checksum >> 1) | ((checksum & 1) << 15)) + char.charCodeAt(0)) & 0xffff;
  return `${checksum.toString(16).padStart(4, "0")},${body}`;
}

function minimum(cell: LayoutCell, horizontal: boolean): number {
  if ("paneId" in cell) return 1;
  const sizes = cell.children.map((child) => minimum(child, horizontal));
  return (cell.axis === "horizontal") === horizontal
    ? sizes.reduce((sum, size) => sum + size, sizes.length - 1)
    : Math.max(...sizes);
}

/** Reserve subtree minimums, then scale remaining space proportionally. */
function fit(cell: LayoutCell, rect: Rect): LayoutCell {
  if (rect.width < 1 || rect.height < 1) throw new Error("Tmux window too small for depth columns.");
  if ("paneId" in cell) return { ...rect, paneId: cell.paneId };
  const horizontal = cell.axis === "horizontal";
  const size = horizontal ? "width" : "height";
  const position = horizontal ? "left" : "top";
  const minimums = cell.children.map((child) => minimum(child, horizontal));
  const extra = rect[size] - cell.children.length + 1 - minimums.reduce((sum, size) => sum + size, 0);
  if (extra < 0) throw new Error("Tmux window too small for user splits.");
  let weights = cell.children.map((child, i) => Math.max(0, child[size] - minimums[i]));
  if (weights.every((weight) => weight === 0)) weights = weights.map(() => 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let used = 0;
  let allocated = 0;
  let weight = 0;
  const children = cell.children.map((child, i) => {
    weight += weights[i];
    const end = Math.round(extra * weight / total);
    const length = minimums[i] + end - allocated;
    const fitted = fit(child, { ...rect, [size]: length, [position]: rect[position] + used + i });
    allocated = end;
    used += length;
    return fitted;
  });
  return { ...rect, axis: cell.axis, children };
}

function group(axis: "horizontal" | "vertical", children: LayoutCell[], rect: Rect): LayoutCell {
  return children.length === 1 ? children[0] : { ...rect, axis, children };
}

/** Equal-weight worker cells use the same sizing routine as user splits. */
export function columnLayout({ width, height, left, top }: Rect, region: LayoutCell | undefined, piWidth: number, columns: string[][]): LayoutCell {
  const rect = { width, height, left, top };
  if (columns.length === 0) {
    if (!region) throw new Error("Tmux layout has no panes.");
    return fit(region, rect);
  }
  const unit: Rect = { width: 1, height: 1, left: 0, top: 0 };
  const workers = group("horizontal", columns.map((panes) =>
    group("vertical", panes.map((paneId) => ({ ...unit, paneId })), unit)), unit);
  if (!region) return fit(workers, rect);
  return group("horizontal", [
    fit(region, { ...rect, width: piWidth }),
    fit(workers, { ...rect, left: rect.left + piWidth + 1, width: rect.width - piWidth - 1 }),
  ], rect);
}
