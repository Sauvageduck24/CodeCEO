// File-level dependency graph, derived from import statements.
import { extractImports, makeResolver, resolveImport } from './lang.mjs';

/** @returns {Array<[string,string]>} deduplicated [from, to] edges (repo-relative posix paths). */
export function buildEdges(files) {
  const R = makeResolver(files.map((f) => f.path));
  const seen = new Set();
  const edges = [];
  for (const f of files) {
    if (!f.lang || !f.text) continue;
    for (const imp of extractImports(f.lang, f.text)) {
      for (const to of resolveImport(f.lang, imp, f.path, R)) {
        if (!to || to === f.path) continue;
        const k = `${f.path}\0${to}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push([f.path, to]);
      }
    }
  }
  return edges;
}

export function adjacency(edges) {
  const out = new Map();
  const inn = new Map();
  for (const [a, b] of edges) {
    (out.get(a) ?? out.set(a, new Set()).get(a)).add(b);
    (inn.get(b) ?? inn.set(b, new Set()).get(b)).add(a);
  }
  return { out, inn };
}

/** Strongly connected components (Tarjan). Returns only components with more than one node. */
export function cycles(nodes, succ) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of succ(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) result.push(comp.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return result;
}
