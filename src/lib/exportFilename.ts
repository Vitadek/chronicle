/**
 * Local-time, filesystem-safe timestamp appended to export filenames so repeated
 * downloads don't silently overwrite each other in the browser's download folder.
 *
 * Format: `YYYY-MM-DD_HHMMSS` (e.g. `2026-07-10_143205`) — sortable, no characters
 * that browsers/OSes reject, and second-precision so even rapid back-to-back
 * exports get distinct names.
 */
export function fileTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
