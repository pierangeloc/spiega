// @ts-check
/* A second moment, not a second renderer. Dagre may move every box, so it only
   gets a turn when the explanation is handed over. Keep its ranks and order;
   the board's layout still owns the size of the ink and the air around it. */
import { graphlib, layout } from '../../vendor/dagre.esm.js';
import { applyOps } from './state.js';

/** @typedef {import('./state.js').Node} Node */
/** @typedef {import('../render/layout.js').Placed} Placed */
/** @typedef {import('./state.js').Op | {op: 'settle'}} DrawingOp */

/* Only callers author a fresh layout. State and browser replay consume the
   recorded coordinates without loading dagre. Split a batch at each request
   so the calculation sees every earlier draw or removal, but nothing later. */
/** @param {import('./state.js').Board} board @param {DrawingOp|DrawingOp[]} ops */
export function applySettlingOps(board, ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  if (!list.some(op => op?.op === 'settle' && !('positions' in op))) {
    return applyOps(board, /** @type {import('./state.js').Op[]} */ (list));
  }
  /** @type {import('./state.js').ApplyOpsResult} */
  const result = { fresh: { nodes: [], edges: [], boundaries: [] }, errors: [], applied: [] };
  /** @param {import('./state.js').Op[]} batch */
  const apply = batch => {
    const next = applyOps(board, batch);
    for (const key of /** @type {(keyof import('./state.js').Fresh)[]} */ (Object.keys(result.fresh))) {
      result.fresh[key].push(...next.fresh[key]);
    }
    result.errors.push(...next.errors);
    result.applied.push(...next.applied);
  };
  /** @type {import('./state.js').Op[]} */
  let batch = [];
  for (const op of list) {
    if (op?.op === 'settle' && !('positions' in op)) {
      apply(batch);
      batch = [];
      apply([settleOp(board)]);
    } else batch.push(/** @type {import('./state.js').Op} */ (op));
  }
  apply(batch);
  return result;
}

/**
 * @param {{nodes: Node[], edges: import('./state.js').Edge[]}} board
 * @returns {import('./state.js').SettleOp}
 */
export function settleOp(board) {
  const graph = new graphlib.Graph().setGraph({ rankdir: 'LR' })
    .setDefaultEdgeLabel(() => ({}));
  const byId = new Map(board.nodes.map(n => [n.id, n]));
  for (const n of board.nodes) graph.setNode(n.id, { width: 1, height: 1 });
  for (const e of board.edges) {
    if (byId.has(e.from) && byId.has(e.to)) graph.setEdge(e.from, e.to);
  }
  if (!board.nodes.length) return { op: 'settle', positions: {}, routes: {} };
  /** @type {{rank: number, order: number, from: string, to: string}[]} */
  const dummies = [];
  // The public ordering hook sees the normalized graph before dagre removes
  // its dummy chains. Run the default order unchanged, then keep its answer.
  layout(graph, { customOrder(g, order) {
    order(g);
    for (const id of g.nodes()) {
      const n = g.node(id);
      if (n.dummy && n.edgeObj) dummies.push({
        rank: n.rank, order: n.order, from: n.edgeObj.v, to: n.edgeObj.w,
      });
    }
  } });

  // Label-only ranks do not become columns; keep the chain's slots at the
  // same real ranks that phase one projects onto the board.
  const ranks = [...new Set(board.nodes.map(n => graph.node(n.id).rank))].sort((a, b) => a - b);
  /** @type {Placed} */
  const proposed = {};
  for (const n of board.nodes) proposed[n.id] = {
    col: ranks.indexOf(graph.node(n.id).rank), row: graph.node(n.id).order,
  };

  /* A hint is a constraint, not a suggestion to dagre (which cannot pin a
     node). Resolve relative columns against the new base, then reserve rows
     for hints before filling the remaining slots in dagre's order. */
  /** @type {Map<string, number>} */
  const columns = new Map();
  /** @param {Node} n @param {Set<string>} [visiting] @returns {number} */
  const column = (n, visiting = new Set()) => {
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
  /** @type {Placed} */
  const placed = {};
  /** @type {Map<number, Set<number>>} */
  const used = new Map();
  /** @param {number} col */
  const slots = col => {
    if (!used.has(col)) used.set(col, new Set());
    return /** @type {Set<number>} */ (used.get(col));
  };
  /* Above/below is a little row block. Moving its reference without moving
     the block would break the hint; placing it one node at a time can put the
     second member on a row a pinned stranger already owns. */
  /** @type {Map<string, {id: string, offset: number}[]>} */
  const links = new Map(board.nodes.map(n => [n.id, []]));
  for (const n of board.nodes) {
    const [rel, ref] = (typeof n.place === 'string' ? n.place : '').split(':');
    if (n.row != null || !byId.has(ref) || !['above', 'below'].includes(rel)) continue;
    const offset = rel === 'below' ? 1 : -1;
    links.get(ref)?.push({ id: n.id, offset });
    links.get(n.id)?.push({ id: ref, offset: -offset });
  }
  /** @typedef {{members: {n: Node, offset: number}[], base?: number, order: number}} RowBlock */
  /** @type {RowBlock[]} */
  const blocks = [];
  const seen = new Set();
  for (const n of board.nodes) {
    if (seen.has(n.id)) continue;
    /** @type {RowBlock} */
    const block = { members: [], order: proposed[n.id].row };
    /** @param {Node} node @param {number} offset */
    const visit = (node, offset) => {
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
  /** @type {Map<string, {id: string, col: number}[]>} */
  const chains = new Map();
  for (const d of dummies) {
    const col = ranks.indexOf(d.rank);
    const from = byId.get(d.from), to = byId.get(d.to);
    if (col < 0 || !from || !to || col <= column(from) || col >= column(to)) continue;
    let id = `@lane:${d.from}>${d.to}:${col}`;
    while (byId.has(id) || proposed[id]) id += ':';
    const n = { id, col };
    proposed[id] = { col, row: d.order };
    blocks.push({ members: [{ n, offset: 0 }], order: d.order });
    const key = `${d.from}>${d.to}`;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key)?.push({ id, col });
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
  /** @type {Record<string, import('../render/layout.js').Placement[]>} */
  const routes = {};
  for (const [key, chain] of chains) {
    routes[key] = chain.sort((a, b) => a.col - b.col).map(({ id }) => {
      const p = placed[id];
      delete placed[id];
      return p;
    });
  }
  return { op: 'settle', positions: placed, routes };
}
