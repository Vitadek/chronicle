/**
 * Counting helpers used by the chapter list and manuscript totals.
 *
 * The editor (TipTap) reports word count internally via CharacterCount, but
 * the sidebar needs to count from raw chapter HTML so it can show stats for
 * chapters that aren't currently being edited. These two paths should agree
 * within a word or two; small differences come from edge cases around
 * punctuation and apostrophes that don't really matter for a "Time to read"
 * label.
 */

/** Words per minute used for the reading-time estimate. */
const WORDS_PER_MINUTE = 200;

/**
 * Count words in an HTML string. Strips tags, normalises whitespace, splits
 * on whitespace, and drops any zero-length tokens.
 *
 * Cheap and deterministic; runs on every chapter on every render of the
 * sidebar, so keep it simple.
 */
export function countWords(html: string | null | undefined): number {
  if (!html) return 0;

  const text = html
    // Drop tags
    .replace(/<[^>]+>/g, ' ')
    // Decode the handful of entities we actually emit
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return 0;
  return text.split(' ').filter(Boolean).length;
}

/**
 * Reading-time estimate, rounded up. Returns at least 1 for non-empty chapters
 * so the UI never reads "0 min" next to actual content.
 */
export function readingMinutes(wordCount: number): number {
  if (wordCount <= 0) return 0;
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
}

/**
 * Format a count for compact UI display. Uses locale grouping so US users see
 * "12,345" rather than "12345".
 */
export function formatWordCount(n: number): string {
  return n.toLocaleString();
}
