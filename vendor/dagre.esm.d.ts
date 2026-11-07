export class Graph {
  setGraph(label: { rankdir: string }): this;
  setDefaultEdgeLabel(factory: () => Record<string, unknown>): this;
  setNode(id: string, label: { width: number; height: number }): this;
  setEdge(from: string, to: string): this;
  node(id: string): { rank: number; order: number; x: number; y: number };
}
export const graphlib: { Graph: typeof Graph };
interface OrderedGraph {
  nodes(): string[];
  node(id: string): { rank: number; order: number; dummy?: string; edgeObj?: { v: string; w: string } };
}
export function layout(graph: Graph, options?: {
  customOrder?: (graph: OrderedGraph, order: (graph: OrderedGraph) => void) => void;
}): void;
