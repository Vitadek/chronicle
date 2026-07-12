import { Chapter, Manuscript } from '../types';

/**
 * Manuscript import — the inverse of the exporters in exportService.ts.
 *
 * Accepts every format Chronicle exports except EPUB:
 *   .docx        — Word documents (via mammoth). Heading 1/2/3 start chapters.
 *   .md          — Markdown, including Chronicle's own export shape (YAML
 *                  front matter, `# Title` / `By Author` header, `##` chapters).
 *   .html/.htm   — Chronicle HTML exports round-trip exactly; generic HTML
 *                  falls back to heading-based splitting.
 *   .zip         — a zip of .md files (Chronicle's multi-chapter Markdown
 *                  export); each file becomes a chapter, in filename order.
 *
 * Every step appends to a log the import dialog shows, so a surprising result
 * ("why is it one big chapter?") explains itself.
 */

export interface ImportLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ImportOutcome {
  manuscript: Manuscript;
  log: ImportLogEntry[];
}

/** Thrown when the file can't be imported; carries the log for the dialog. */
export class ImportError extends Error {
  log: ImportLogEntry[];
  constructor(message: string, log: ImportLogEntry[]) {
    super(message);
    this.name = 'ImportError';
    this.log = [...log, { level: 'error', message }];
  }
}

const newId = () => Math.random().toString(36).substr(2, 9);

/** Derive a clean manuscript title from an export-style filename. */
function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^/.]+$/, '')                       // extension
    .replace(/_?\d{4}-\d{2}-\d{2}_\d{6}$/, '')      // export timestamp
    .replace(/_(Manuscript|markdown)$/i, '')        // export suffixes
    .replace(/[-_]/g, ' ')
    .trim();
}

/** Escape text destined for element content. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Strip scripts/inline handlers from untrusted imported HTML. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}

// ---- Heading-based HTML splitting (shared by .docx and generic .html) ------

/**
 * Split a flat HTML body into chapters on h1/h2/h3 boundaries. This is the
 * long-standing .docx heuristic, moved here verbatim from LibraryView (with
 * log output added): contact-info lines before the first heading are skipped,
 * and back-to-back generic/descriptive headings are de-duplicated.
 */
function chaptersFromHtmlBody(body: HTMLElement, log: ImportLogEntry[]): Chapter[] {
  const children = Array.from(body.children);
  const chapters: Chapter[] = [];
  let currentChapter: Chapter | null = null;
  let isSkippingHeader = true;
  let skippedHeaderLines = 0;

  children.forEach((child) => {
    const tag = child.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script') return;
    const isHeading = ['h1', 'h2', 'h3'].includes(tag);
    const text = child.textContent?.trim() || '';

    // If we haven't hit a heading yet, we check if we should skip this
    // paragraph because it looks like contact info (Author, Address, Phone,
    // Email) or word-count metadata from a title page.
    if (isSkippingHeader && !isHeading && tag === 'p') {
      const isEmail = /\S+@\S+\.\S+/.test(text);
      const isPhone = /^[\d\s-().+]{7,}$/.test(text) && /[0-9]/.test(text);
      const isMetadata = text.toLowerCase().startsWith('word count') ||
                         text.toLowerCase().startsWith('approx');

      if (isEmail || isPhone || isMetadata || (text.length < 40 && !currentChapter)) {
        skippedHeaderLines++;
        return;
      }
      isSkippingHeader = false;
    }

    if (isHeading || !currentChapter) {
      isSkippingHeader = false;

      // De-duplication: a heading immediately after a still-empty heading
      // resolves to whichever title is descriptive rather than "Chapter N".
      if (isHeading && currentChapter && currentChapter.content === '') {
        const isPrevGeneric = /^(chapter|ch\.|sect\.|section)\s*\d+\s*$/i.test(currentChapter.title);
        const isNewGeneric = /^(chapter|ch\.|sect\.|section)\s*\d+\s*$/i.test(text);

        if (isPrevGeneric && !isNewGeneric) {
          currentChapter.title = text;
          return;
        } else if (!isPrevGeneric && isNewGeneric) {
          return;
        }
        // Both generic or both descriptive: deliberate split, fall through.
      }

      currentChapter = {
        id: newId(),
        title: isHeading ? text || 'Untitled Chapter' : 'Prologue',
        content: '',
        lastModified: Date.now(),
      };
      chapters.push(currentChapter);

      if (isHeading) return;
    }

    currentChapter.content += sanitizeHtml((child as HTMLElement).outerHTML);
  });

  if (skippedHeaderLines > 0) {
    log.push({ level: 'info', message: `Skipped ${skippedHeaderLines} title-page/contact line(s) before the first heading.` });
  }
  return chapters;
}

// ---- Markdown ---------------------------------------------------------------

interface FrontMatter {
  title?: string;
  author?: string;
  raw: Record<string, string>;
}

/** Parse the simple `key: value` YAML front matter Chronicle exports emit. */
function parseFrontMatter(text: string): { fm: FrontMatter | null; rest: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: null, rest: text };
  const raw: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) raw[kv[1]] = kv[2].trim();
  }
  const unquote = (v?: string) =>
    v && /^".*"$/.test(v) ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : v;
  return {
    fm: { title: unquote(raw.title), author: unquote(raw.author), raw },
    rest: text.slice(m[0].length),
  };
}

/** Convert a block of Chronicle-flavoured Markdown body text to editor HTML. */
function markdownBlocksToHtml(mdBody: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');

  return mdBody
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith('> ')) {
        const quote = block.split('\n').map((l) => l.replace(/^>\s?/, '')).join('<br>');
        return `<blockquote>${inline(quote)}</blockquote>`;
      }
      // Single newlines inside a block were hard breaks on export.
      return `<p>${block.split('\n').map(inline).join('<br>')}</p>`;
    })
    .join('');
}

/**
 * Import a Markdown document. Handles both Chronicle export shapes:
 *  - book export: front matter + `# Title` + `By Author` + `##` per chapter
 *  - single-chapter export: front matter + one `#` heading (the chapter)
 * Plain third-party Markdown works with the same rules.
 */
function importMarkdownText(text: string, filename: string, log: ImportLogEntry[]): Manuscript {
  const src = text.replace(/^\uFEFF/, '');
  const { fm, rest } = parseFrontMatter(src);
  if (fm) {
    log.push({ level: 'info', message: `Found YAML front matter${fm.title ? ` (title: “${fm.title}”)` : ''}.` });
    const extras = Object.keys(fm.raw).filter((k) => !['title', 'author'].includes(k));
    if (extras.length) {
      log.push({ level: 'info', message: `Front matter fields not imported: ${extras.join(', ')}.` });
    }
  }

  const lines = rest.split(/\r?\n/);
  let bookTitle: string | undefined;
  let author: string | undefined;
  let genre: string | undefined;

  // Chapters keyed by `##` headings (book export). We also remember the first
  // `#` heading: book title in the book shape, chapter title in the
  // single-chapter shape.
  const hasH2 = lines.some((l) => /^##\s+/.test(l));
  type MdChapter = { title: string; body: string[] };
  const mdChapters: MdChapter[] = [];
  let current: MdChapter | null = null;
  let inContactBlock = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      current = { title: line.replace(/^##\s+/, '').trim() || 'Untitled Chapter', body: [] };
      mdChapters.push(current);
      continue;
    }
    if (/^#\s+/.test(line)) {
      const heading = line.replace(/^#\s+/, '').trim();
      if (hasH2) {
        bookTitle = bookTitle || heading;
      } else {
        // Single-chapter shape: `#` is the chapter heading.
        current = { title: heading || 'Untitled Chapter', body: [] };
        mdChapters.push(current);
      }
      continue;
    }
    if (!current) {
      // Book-header region (before the first chapter heading).
      const by = line.match(/^By\s+(.+)$/i);
      if (by) { author = author || by[1].trim(); continue; }
      const g = line.match(/^\*\*Genre:\*\*\s*(.+)$/i);
      if (g) { genre = g[1].trim(); continue; }
      if (/^---\s*$/.test(line)) { inContactBlock = !inContactBlock; continue; }
      if (inContactBlock) continue; // contact name/email between --- fences
      if (line.trim()) {
        // Body text before any heading: start an implicit chapter.
        current = { title: 'Prologue', body: [line] };
        mdChapters.push(current);
      }
      continue;
    }
    current.body.push(line);
  }

  if (mdChapters.length === 0) {
    throw new ImportError('No text content found in the Markdown file.', log);
  }

  const chapters: Chapter[] = mdChapters.map((c) => ({
    id: newId(),
    title: c.title,
    content: markdownBlocksToHtml(c.body.join('\n')),
    lastModified: Date.now(),
  }));

  const title =
    (hasH2 ? fm?.title || bookTitle : undefined) ??  // book shape
    fm?.title ??                                     // single-chapter shape
    titleFromFilename(filename) ??
    'Imported Manuscript';

  log.push({
    level: 'info',
    message: hasH2
      ? `Split ${chapters.length} chapter(s) on "##" headings.`
      : `Single-chapter Markdown: “${chapters[0].title}”.`,
  });

  return {
    metadata: {
      id: newId(),
      title: title || 'Imported Manuscript',
      author: author || '',
      ...(genre ? { genre } : {}),
      lastModified: Date.now(),
    },
    chapters,
  };
}

// ---- HTML -------------------------------------------------------------------

function importHtmlText(text: string, filename: string, log: ImportLogEntry[]): Manuscript {
  const doc = new DOMParser().parseFromString(text, 'text/html');

  // Chronicle's own HTML export: exact round-trip via its structure.
  const sections = Array.from(doc.querySelectorAll('section.chapter'));
  if (sections.length > 0) {
    log.push({ level: 'info', message: `Recognized a Chronicle HTML export (${sections.length} chapter section(s)).` });
    const title =
      doc.querySelector('header.title-page h1')?.textContent?.trim() ||
      doc.querySelector('title')?.textContent?.trim() ||
      titleFromFilename(filename);
    const author = (doc.querySelector('header.title-page .by')?.textContent || '')
      .replace(/^\s*by\s+/i, '')
      .trim();

    const chapters: Chapter[] = sections.map((s, i) => ({
      id: newId(),
      title: s.querySelector('.chapter-title')?.textContent?.trim() || `Chapter ${i + 1}`,
      content: sanitizeHtml(s.querySelector('.chapter-body')?.innerHTML || ''),
      lastModified: Date.now(),
    }));

    return {
      metadata: { id: newId(), title: title || 'Imported Manuscript', author, lastModified: Date.now() },
      chapters,
    };
  }

  // Generic HTML: same heading-split heuristic as .docx.
  log.push({ level: 'info', message: 'Generic HTML: splitting chapters on h1/h2/h3 headings.' });
  const chapters = chaptersFromHtmlBody(doc.body, log);
  if (chapters.length === 0) {
    throw new ImportError('No readable content found in the HTML file.', log);
  }
  return {
    metadata: {
      id: newId(),
      title: doc.querySelector('title')?.textContent?.trim() || titleFromFilename(filename) || 'Imported Manuscript',
      author: '',
      lastModified: Date.now(),
    },
    chapters,
  };
}

// ---- docx -------------------------------------------------------------------

async function importDocxFile(file: File, log: ImportLogEntry[]): Promise<Manuscript> {
  const [{ default: mammoth }, arrayBuffer] = await Promise.all([
    import('mammoth'),
    file.arrayBuffer(),
  ]);
  const result = await mammoth.convertToHtml({ arrayBuffer });
  for (const msg of result.messages || []) {
    log.push({ level: 'warn', message: `Word converter: ${msg.message}` });
  }

  const doc = new DOMParser().parseFromString(result.value, 'text/html');
  const chapters = chaptersFromHtmlBody(doc.body, log);

  if (chapters.length === 0) {
    log.push({ level: 'warn', message: 'No headings found — imported as a single "Full Manuscript" chapter. Use Heading 1/2 styles in Word to mark chapters.' });
  } else {
    log.push({ level: 'info', message: `Split ${chapters.length} chapter(s) on Heading 1/2/3 styles.` });
  }

  return {
    metadata: {
      id: newId(),
      title: titleFromFilename(file.name) || 'Imported Manuscript',
      author: '',
      lastModified: Date.now(),
    },
    chapters: chapters.length > 0 ? chapters : [
      { id: newId(), title: 'Full Manuscript', content: sanitizeHtml(result.value), lastModified: Date.now() },
    ],
  };
}

// ---- zip of markdown ----------------------------------------------------------

async function importMarkdownZip(file: File, log: ImportLogEntry[]): Promise<Manuscript> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const entries = Object.values(zip.files)
    .filter((e) => !e.dir && /\.(md|markdown)$/i.test(e.name) && !e.name.startsWith('__MACOSX') && !/(^|\/)\./.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  if (entries.length === 0) {
    throw new ImportError('The zip contains no .md files. Expected Chronicle\'s multi-chapter Markdown export (one .md per chapter).', log);
  }
  log.push({ level: 'info', message: `Found ${entries.length} Markdown file(s) in the zip; importing in filename order.` });

  const chapters: Chapter[] = [];
  let author = '';
  for (const entry of entries) {
    const text = (await entry.async('string')).replace(/^\uFEFF/, '');
    const { fm, rest } = parseFrontMatter(text);
    // Each entry is a single-chapter document: `#` heading (or front-matter
    // title, or the filename) names the chapter.
    const lines = rest.split(/\r?\n/);
    const h1 = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim();
    const body = lines.filter((l) => !/^#\s+/.test(l)).join('\n');
    if (!author && fm?.author) author = fm.author;
    chapters.push({
      id: newId(),
      title: fm?.title || h1 || titleFromFilename(entry.name.split('/').pop() || entry.name).replace(/^\d+\s*/, '') || `Chapter ${chapters.length + 1}`,
      content: markdownBlocksToHtml(body),
      lastModified: Date.now(),
    });
  }

  return {
    metadata: {
      id: newId(),
      title: titleFromFilename(file.name) || 'Imported Manuscript',
      author,
      lastModified: Date.now(),
    },
    chapters,
  };
}

// ---- Dispatcher ---------------------------------------------------------------

export async function importManuscriptFile(file: File): Promise<ImportOutcome> {
  const log: ImportLogEntry[] = [];
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  log.push({ level: 'info', message: `Reading ${file.name} (${(file.size / 1024).toFixed(0)} KB).` });

  try {
    let manuscript: Manuscript;
    if (ext === 'docx') {
      manuscript = await importDocxFile(file, log);
    } else if (ext === 'md' || ext === 'markdown') {
      manuscript = importMarkdownText(await file.text(), file.name, log);
    } else if (ext === 'html' || ext === 'htm') {
      manuscript = importHtmlText(await file.text(), file.name, log);
    } else if (ext === 'zip') {
      manuscript = await importMarkdownZip(file, log);
    } else if (ext === 'epub') {
      throw new ImportError('EPUB import isn\'t supported — EPUB export is one-way. Import the .docx, Markdown, or HTML version instead.', log);
    } else {
      throw new ImportError(`Unsupported file type ".${ext}". Chronicle imports .docx, .md, .html, and .zip (of Markdown).`, log);
    }

    const words = manuscript.chapters.reduce((n, c) => n + (c.content.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length), 0);
    log.push({
      level: 'info',
      message: `Imported “${manuscript.metadata.title}” — ${manuscript.chapters.length} chapter(s), ~${words.toLocaleString()} words${manuscript.metadata.author ? `, by ${manuscript.metadata.author}` : ''}.`,
    });
    return { manuscript, log };
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError(err instanceof Error ? err.message : 'Unknown error while reading the file.', log);
  }
}
