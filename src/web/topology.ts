import type { CommitSummary, GitRef, WorktreeInfo } from '../schema/types.js';

export type TopologyKind = 'head' | 'branch' | 'remote' | 'tag' | 'worktree' | 'merge' | 'root';

export interface TopologyNode {
  oid: string;
  commit: CommitSummary;
  refs: GitRef[];
  worktrees: WorktreeInfo[];
  kinds: TopologyKind[];
  rank: number;
  row: number;
}

export interface TopologyEdge { source: string; target: string; collapsed: number }
export interface TopologyModel {
  nodes: TopologyNode[]; edges: TopologyEdge[]; hiddenCommitCount: number; landmarkCount: number;
  limited: boolean; maxRank: number; maxRow: number;
}

function laneMap(commits: CommitSummary[]): Map<string, number> {
  let lanes: string[] = [];
  const result = new Map<string, number>();
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) { lane = 0; lanes = [commit.oid, ...lanes]; }
    result.set(commit.oid, lane);
    const next = lanes.filter((oid) => oid !== commit.oid);
    let insertion = Math.min(lane, next.length);
    for (const parent of commit.parents) {
      if (next.includes(parent)) continue;
      next.splice(insertion, 0, parent); insertion += 1;
    }
    lanes = next;
  }
  return result;
}

function kindsFor(commit: CommitSummary, worktrees: WorktreeInfo[], head: string | null): TopologyKind[] {
  const kinds = new Set<TopologyKind>();
  if (commit.oid === head) kinds.add('head');
  if (commit.parents.length > 1) kinds.add('merge');
  if (commit.parents.length === 0) kinds.add('root');
  for (const ref of commit.refs) kinds.add(ref.kind === 'local' ? 'branch' : ref.kind);
  if (worktrees.length > 0) kinds.add('worktree');
  return [...kinds];
}

function nearestVisibleAncestors(start: string, visible: Set<string>, commits: Map<string, CommitSummary>): Array<{ oid: string; collapsed: number }> {
  const found = new Map<string, number>();
  const queue: Array<{ oid: string; collapsed: number }> = [{ oid: start, collapsed: 0 }];
  const visited = new Map<string, number>();
  while (queue.length > 0) {
    const item = queue.shift(); if (!item) break;
    const previous = visited.get(item.oid);
    if (previous !== undefined && previous <= item.collapsed) continue;
    visited.set(item.oid, item.collapsed);
    if (visible.has(item.oid)) {
      const distance = found.get(item.oid);
      if (distance === undefined || item.collapsed < distance) found.set(item.oid, item.collapsed);
      continue;
    }
    const commit = commits.get(item.oid); if (!commit) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, collapsed: item.collapsed + 1 });
  }
  return [...found].map(([oid, collapsed]) => ({ oid, collapsed }));
}

export function buildTopology(commits: CommitSummary[], worktrees: WorktreeInfo[], head: string | null, maxNodes = 120): TopologyModel {
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const worktreesByOid = new Map<string, WorktreeInfo[]>();
  for (const worktree of worktrees) {
    if (!worktree.head || !byOid.has(worktree.head)) continue;
    const list = worktreesByOid.get(worktree.head) ?? [];
    list.push(worktree); worktreesByOid.set(worktree.head, list);
  }
  const candidates = commits.filter((commit, index) => index === 0 || commit.oid === head || commit.refs.length > 0 || commit.parents.length !== 1 || worktreesByOid.has(commit.oid));
  const priority = (commit: CommitSummary): number => {
    if (commit.oid === head) return 1_000;
    if (commit.refs.some((ref) => ref.current)) return 980;
    if (worktreesByOid.has(commit.oid)) return 960;
    if (commit.refs.some((ref) => ref.kind === 'local')) return 920;
    if (commit.refs.length > 0) return 880;
    if (commit.parents.length > 1) return 760;
    if (commit.parents.length === 0) return 700;
    return 500;
  };
  const indexByOid = new Map(commits.map((commit, index) => [commit.oid, index]));
  const chosen = candidates.length <= maxNodes ? candidates : [...candidates]
    .sort((left, right) => priority(right) - priority(left) || (indexByOid.get(left.oid) ?? 0) - (indexByOid.get(right.oid) ?? 0))
    .slice(0, maxNodes)
    .sort((left, right) => (indexByOid.get(left.oid) ?? 0) - (indexByOid.get(right.oid) ?? 0));
  const visible = new Set(chosen.map((commit) => commit.oid));
  const edges: TopologyEdge[] = []; const edgeKeys = new Set<string>();
  for (const target of chosen) {
    for (const parent of target.parents) {
      for (const ancestor of nearestVisibleAncestors(parent, visible, byOid)) {
        const key = `${ancestor.oid}:${target.oid}`; if (edgeKeys.has(key)) continue;
        edgeKeys.add(key); edges.push({ source: ancestor.oid, target: target.oid, collapsed: ancestor.collapsed });
      }
    }
  }
  const incoming = new Map<string, TopologyEdge[]>();
  for (const edge of edges) { const list = incoming.get(edge.target) ?? []; list.push(edge); incoming.set(edge.target, list); }
  const ranks = new Map<string, number>(); const resolving = new Set<string>();
  const resolveRank = (oid: string): number => {
    const cached = ranks.get(oid); if (cached !== undefined) return cached;
    if (resolving.has(oid)) return 0;
    resolving.add(oid);
    const parents = incoming.get(oid) ?? [];
    const rank = parents.length === 0 ? 0 : Math.max(...parents.map((edge) => resolveRank(edge.source) + 1));
    resolving.delete(oid); ranks.set(oid, rank); return rank;
  };
  for (const commit of chosen) resolveRank(commit.oid);
  const lanes = laneMap(commits); const occupied = new Set<string>(); let maxRank = 0; let maxRow = 0;
  const nodes = [...chosen].reverse().map((commit) => {
    const rank = ranks.get(commit.oid) ?? 0; let row = lanes.get(commit.oid) ?? 0;
    while (occupied.has(`${rank}:${row}`)) row += 1;
    occupied.add(`${rank}:${row}`); maxRank = Math.max(maxRank, rank); maxRow = Math.max(maxRow, row);
    const nodeWorktrees = worktreesByOid.get(commit.oid) ?? [];
    return { oid: commit.oid, commit, refs: commit.refs, worktrees: nodeWorktrees, kinds: kindsFor(commit, nodeWorktrees, head), rank, row };
  });
  return { nodes, edges, hiddenCommitCount: Math.max(0, commits.length - nodes.length), landmarkCount: candidates.length, limited: candidates.length > chosen.length, maxRank, maxRow };
}
