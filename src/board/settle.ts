/* A second moment, not a second renderer. Dagre may move every box, so it only
   gets a turn when the explanation is handed over. Keep its ranks and order;
   the board's layout still owns the size of the ink and the air around it. */
import { graphlib, layout } from '@dagrejs/dagre';
import type {
  ApplyOpsResult, Board, Edge, Node, Op, Placed, Placement, SettleOp,
} from './state.js';
import { applyOps } from './state.js';

/* @dagrejs/dagre 3.1.3 ships extensionless relative imports in its .d.ts files,
   which NodeNext cannot resolve and silently widens to any under skipLibCheck.
   Type the narrow seam settle actually calls. */
interface DagreNode {
  rank: number;
  order: number;
  dummy?: string;
  edgeObj?: { v: string; w: string };
}

interface DagreGraph {
  setGraph(label: { rankdir: string }): this;
  setDefaultEdgeLabel(factory: () => Record<string, unknown>): this;
  setNode(id: string, label: { width: number; height: number }): this;
  setEdge(from: string, to: string): this;
  nodes(): string[];
  node(id: string): DagreNode;
}

export type DrawingOp = Op | { op: 'settle' };

const isSettleRequest = (op: DrawingOp): op is { op: 'settle' } =>
  op?.op === 'settle' && !('positions' in op);

const isOp = (op: DrawingOp): op is Op => !isSettleRequest(op);

/* Only callers author a fresh layout. State and browser replay consume the
   recorded coordinates without loading dagre. Split a batch at each request
   so the calculation sees every earlier draw or removal, but nothing later. */
export function applySettlingOps(board: Board, ops: DrawingOp | DrawingOp[]): ApplyOpsResult {
  const list = Array.isArray(ops) ? ops : [ops];
  if (list.every(isOp)) return applyOps(board, list);
  const result: ApplyOpsResult = {
    fresh: { nodes: [], edges: [], boundaries: [] },
    errors: [],
    warnings: [],
    applied: [],
  };
  const apply = (batch: Op[]): void => {
    const next = applyOps(board, batch);
    result.fresh.nodes.push(...next.fresh.nodes);
    result.fresh.edges.push(...next.fresh.edges);
    result.fresh.boundaries.push(...next.fresh.boundaries);
    result.errors.push(...next.errors);
    result.warnings.push(...next.warnings);
    result.applied.push(...next.applied);
  };
  let batch: Op[] = [];
  for (const op of list) {
    if (isOp(op)) batch.push(op);
    else {
      apply(batch);
      batch = [];
      apply([settleOp(board)]);
    }
  }
  apply(batch);
  return result;
}

interface DummySlot {
  rank: number;
  order: number;
  from: string;
  to: string;
}

interface RowBlock {
  members: { n: Node; offset: number }[];
  base?: number;
  order: number;
}

export function settleOp(board: { nodes: readonly Node[]; edges: readonly Edge[] }): SettleOp {
  const graph: DagreGraph = new graphlib.Graph()
    .setGraph({ rankdir: 'LR' })
    .setDefaultEdgeLabel(() => ({}));
  const byId = new Map<string, Node>(board.nodes.map(n => [n.id, n]));
  for (const n of board.nodes) graph.setNode(n.id, { width: 1, height: 1 });
  for (const e of board.edges) {
    if (byId.has(e.from) && byId.has(e.to)) graph.setEdge(e.from, e.to);
  }
  if (!board.nodes.length) return { op: 'settle', positions: {}, routes: {} };
  const dummies: DummySlot[] = [];
  // The public ordering hook sees the normalized graph before dagre removes
  // its dummy chains. Run the default order unchanged, then keep its answer.
  layout(graph, {
    customOrder(g: DagreGraph, order: (g: DagreGraph) => void) {
      order(g);
      for (const id of g.nodes()) {
        const n = g.node(id);
        if (n.dummy && n.edgeObj) {
          dummies.push({
            rank: n.rank, order: n.order, from: n.edgeObj.v, to: n.edgeObj.w,
          });
        }
      }
    },
  });

  // Label-only ranks do not become columns; keep the chain's slots at the
  // same real ranks that phase one projects onto the board.
  const ranks = [...new Set(board.nodes.map(n => graph.node(n.id).rank))].sort((a, b) => a - b);
  const proposed: Placed = {};
  for (const n of board.nodes) {
    proposed[n.id] = { col: ranks.indexOf(graph.node(n.id).rank), row: graph.node(n.id).order };
  }

  /* A hint is a constraint, not a suggestion to dagre (which cannot pin a
     node). Resolve relative columns against the new base, then reserve rows
     for hints before filling the remaining slots in dagre's order. */
  const columns = new Map<string, number>();
  const column = (n: Node, visiting = new Set<string>()): number => {
    const known = columns.get(n.id);
    if (known != null) return known;
    if (visiting.has(n.id)) return proposed[n.id].col;
    visiting.add(n.id);
    let col = proposed[n.id].col;
    const [rel, ref] = (typeof n.place === 'string' ? n.place : '').split(':');
    const target = byId.get(ref);
    if (n.col != null) col = n.col;
    else if (target) {
      const base = column(target, visiting);
      col = rel === 'right-of' ? base + 1 : rel === 'left-of' ? Math.max(0, base - 1) : base;
    } else if (n.kind === 'note') col = -1;
    columns.set(n.id, col);
    return col;
  };
  const placed: Placed = {};
  const used = new Map<number, Set<number>>();
  const slots = (col: number): Set<number> => {
    let set = used.get(col);
    if (!set) {
      set = new Set();
      used.set(col, set);
    }
    return set;
  };
  /* Above/below is a little row block. Moving its reference without moving
     the block would break the hint; placing it one node at a time can put the
     second member on a row a pinned stranger already owns. */
  const links = new Map<string, { id: string; offset: number }[]>(board.nodes.map(n => [n.id, []]));
  for (const n of board.nodes) {
    const [rel, ref] = (typeof n.place === 'string' ? n.place : '').split(':');
    if (n.row != null || !byId.has(ref) || !['above', 'below'].includes(rel)) continue;
    const offset = rel === 'below' ? 1 : -1;
    links.get(ref)?.push({ id: n.id, offset });
    links.get(n.id)?.push({ id: ref, offset: -offset });
  }
  const blocks: RowBlock[] = [];
  const seen = new Set<string>();
  for (const n of board.nodes) {
    if (seen.has(n.id)) continue;
    const block: RowBlock = { members: [], order: proposed[n.id].row };
    const visit = (node: Node, offset: number): void => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      block.members.push({ n: node, offset });
      if (node.row != null) block.base = node.row - offset;
      for (const link of links.get(node.id) || []) {
        const next = byId.get(link.id);
        if (next) visit(next, offset + link.offset);
      }
    };
    visit(n, 0);
    blocks.push(block);
  }
  const chains = new Map<string, { id: string; col: number }[]>();
  for (const d of dummies) {
    const col = ranks.indexOf(d.rank);
    const from = byId.get(d.from), to = byId.get(d.to);
    if (col < 0 || !from || !to || col <= column(from) || col >= column(to)) continue;
    let id = `@lane:${d.from}>${d.to}:${col}`;
    while (byId.has(id) || proposed[id]) id += ':';
    const n: Node = { id, col };
    proposed[id] = { col, row: d.order };
    blocks.push({ members: [{ n, offset: 0 }], order: d.order });
    const key = `${d.from}>${d.to}`;
    let chain = chains.get(key);
    if (!chain) {
      chain = [];
      chains.set(key, chain);
    }
    chain.push({ id, col });
  }
  blocks.sort((a, b) => Number(b.base != null) - Number(a.base != null) || a.order - b.order);
  for (const block of blocks) {
    let base = block.base ?? Math.max(0, ...block.members.map(m => -m.offset));
    if (block.base == null) {
      while (block.members.some(m => slots(column(m.n)).has(base + m.offset))) base++;
    }
    for (const { n, offset } of block.members) {
      const col = column(n), row = n.row ?? base + offset;
      placed[n.id] = { col, row };
      slots(col).add(row);
    }
  }
  const routes: Record<string, Placement[]> = {};
  for (const [key, chain] of chains) {
    routes[key] = chain.sort((a, b) => a.col - b.col).map(({ id }) => {
      const p = placed[id];
      delete placed[id];
      return p;
    });
  }
  return { op: 'settle', positions: placed, routes };
}
