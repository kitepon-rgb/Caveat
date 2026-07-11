export type VisibilityClassification = 'public' | 'private' | 'invalid';

/**
 * Classifies the raw frontmatter value at the public/private boundary.
 *
 * Do not normalize this input. In particular, trim(), lowercasing, or a
 * permissive fallback would turn malformed frontmatter into publishable data.
 */
export function classifyVisibility(value: unknown): VisibilityClassification {
  if (value === 'public') return 'public';
  if (value === 'private') return 'private';
  return 'invalid';
}
