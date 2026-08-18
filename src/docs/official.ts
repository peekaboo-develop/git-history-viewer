import type { Change } from '../schema/types.js';

export interface OfficialDocRecommendation {
  id: string;
  title: string;
  url: string;
  technology: string;
  version: null;
  reasonJa: string;
}

interface RegistryEntry extends OfficialDocRecommendation { matches(path: string): boolean }

const REGISTRY: RegistryEntry[] = [
  { id: 'github-actions', title: 'GitHub Actions workflow syntax', url: 'https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax', technology: 'GitHub Actions', version: null, reasonJa: 'GitHub Actionsのworkflowファイルが変更されています。', matches: (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path) },
  { id: 'dockerfile', title: 'Dockerfile reference', url: 'https://docs.docker.com/reference/dockerfile', technology: 'Dockerfile', version: null, reasonJa: 'Dockerfileが変更されています。', matches: (path) => /(?:^|\/)Dockerfile(?:\.[^/]*)?$/u.test(path) },
  { id: 'compose', title: 'Docker Compose file reference', url: 'https://docs.docker.com/compose/compose-file/', technology: 'Docker Compose', version: null, reasonJa: 'Compose設定が変更されています。', matches: (path) => /(?:^|\/)(?:compose|docker-compose)(?:\.[^/]*)?\.ya?ml$/u.test(path) },
  { id: 'typescript', title: 'TSConfig reference', url: 'https://www.typescriptlang.org/tsconfig/', technology: 'TypeScript', version: null, reasonJa: 'TypeScript設定が変更されています。', matches: (path) => /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/u.test(path) },
  { id: 'vite', title: 'Vite config reference', url: 'https://vite.dev/config/', technology: 'Vite', version: null, reasonJa: 'Vite設定が変更されています。', matches: (path) => /(?:^|\/)vite\.config\.(?:js|mjs|cjs|ts|mts|cts)$/u.test(path) },
  { id: 'vue-sfc', title: 'Vue Single-File Components', url: 'https://vuejs.org/guide/scaling-up/sfc.html', technology: 'Vue SFC', version: null, reasonJa: 'Vueコンポーネントが変更されています。', matches: (path) => path.endsWith('.vue') },
];

export function recommendOfficialDocs(changes: Change[], limit = 2): OfficialDocRecommendation[] {
  if (!Number.isInteger(limit) || limit < 0 || limit > 6) return [];
  const paths = changes.filter((change) => change.state !== 'D' && change.path?.encoding === 'utf8').map((change) => change.path!.display);
  return REGISTRY.filter((entry) => paths.some((path) => entry.matches(path))).slice(0, limit).map(({ matches: _matches, ...entry }) => entry);
}
