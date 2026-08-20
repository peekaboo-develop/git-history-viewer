import type { Change } from '../schema/types.js';

export function commitDescription(body: string, subject: string): string {
  const normalized = body.trim();
  if (!normalized) return '';
  const lines = normalized.split(/\r?\n/u);
  if ((lines[0] ?? '').trim() === subject.trim()) return lines.slice(1).join('\n').trim();
  return normalized === subject.trim() ? '' : normalized;
}

export function changeLabel(state: string): string {
  const code = state.charAt(0).toUpperCase();
  return ({ A: '追加', M: '変更', D: '削除', R: '名前変更', C: 'コピー', T: '種類変更', U: '未解決' } as Record<string, string>)[code] ?? state;
}

export function changeTone(state: string): string {
  const code = state.charAt(0).toUpperCase();
  return ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typed', U: 'unmerged' } as Record<string, string>)[code] ?? 'unknown';
}

export function changeTotals(changes: Change[]): { files: number; additions: number; deletions: number; binary: number } {
  let additions = 0; let deletions = 0; let binary = 0;
  for (const change of changes) {
    if (change.added === null || change.deleted === null) binary += 1;
    else { additions += change.added; deletions += change.deleted; }
  }
  return { files: changes.length, additions, deletions, binary };
}
