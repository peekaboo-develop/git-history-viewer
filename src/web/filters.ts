import type { CommitSummary } from '../schema/types.js';

export interface FilterOption { value: string; label: string; count: number }

export function branchOptions(commits: CommitSummary[]): FilterOption[] {
  const values = new Map<string, { label: string; count: number; priority: number }>();
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (ref.kind === 'tag') continue;
      const existing = values.get(ref.name);
      const priority = ref.current ? 0 : ref.kind === 'local' ? 1 : 2;
      if (!existing) values.set(ref.name, { label: ref.name, count: 1, priority });
      else { existing.count += 1; existing.priority = Math.min(existing.priority, priority); }
    }
  }
  return [...values].map(([value, item]) => ({ value, label: item.label, count: item.count }))
    .sort((left, right) => {
      const a = values.get(left.value)?.priority ?? 3; const b = values.get(right.value)?.priority ?? 3;
      return a - b || left.label.localeCompare(right.label);
    });
}

export function authorOptions(commits: CommitSummary[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const commit of commits) counts.set(commit.authorName, (counts.get(commit.authorName) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, label: value, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

export function relatedHistory(commits: CommitSummary[], refName: string): CommitSummary[] {
  if (!refName) return commits;
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const pending = commits.filter((commit) => commit.refs.some((ref) => ref.name === refName)).map((commit) => commit.oid);
  const included = new Set<string>();
  while (pending.length > 0) {
    const oid = pending.pop(); if (!oid || included.has(oid)) continue;
    included.add(oid);
    const commit = byOid.get(oid); if (!commit) continue;
    for (const parent of commit.parents) if (byOid.has(parent)) pending.push(parent);
  }
  return commits.filter((commit) => included.has(commit.oid));
}

export function matchesHighlight(commit: CommitSummary, query: string, author: string): boolean {
  if (author && commit.authorName !== author) return false;
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return `${commit.subject} ${commit.authorName} ${commit.oid} ${commit.refs.map((ref) => ref.name).join(' ')}`.toLocaleLowerCase().includes(normalized);
}
