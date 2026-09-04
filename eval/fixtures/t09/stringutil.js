/** stringutil — small string helpers (no tests yet). */

export function capitalize(s) {
  if (typeof s !== 'string' || s.length === 0) return '';
  return s[0].toUpperCase() + s.slice(1);
}

export function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

/** Truncate to `max` chars; append '…' when truncated. max must be >= 1. */
export function truncate(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  if (max === 1) return '…';
  return `${str.slice(0, max - 1)}…`;
}
