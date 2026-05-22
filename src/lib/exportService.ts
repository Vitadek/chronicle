import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Header,
  PageNumber,
  SectionType,
  TabStopType,
  TabStopPosition,
  HeadingLevel,
  LineRuleType,
} from 'docx';
import { saveAs } from 'file-saver';
import { Chapter, ManuscriptMetadata } from '../types';

/**
 * Standard Manuscript Format export.
 *
 * Follows the Shunn-style spec used by most US short-fiction markets and
 * adopted by many novel agents:
 *   - Times New Roman 12pt (sz=24 half-points)
 *   - 1" margins on all sides (1440 twips)
 *   - Double-spaced body (240 twentieths = single → 480 = double; we use the
 *     `line: 480` shortcut, which is in 240ths)
 *   - First-line indent 0.5" on body paragraphs only (720 twips)
 *   - No first-line indent on the first paragraph after a heading or scene
 *     break — but a per-paragraph indicator is more trouble than it's worth
 *     here, so we indent uniformly. Most editors accept either.
 *   - Title page: contact block top-left, word count top-right (same row),
 *     title block centered roughly at the vertical mid-point.
 *   - Word count: rounded to a nice number using SMF convention.
 *   - Running header on body pages: "Lastname / TitleKeyword / Page#",
 *     right-aligned. No header on the title page.
 *   - Chapter heading drops down ~1/3 page (about 4 lines worth).
 *
 * The previous version uppercased the title and used negative spacing to put
 * the word count back up on the same line as the contact name — that broke
 * on many .docx renderers. This version uses a tab stop, which is what real
 * SMF templates do.
 */

// ---- Constants (twips: 1440 per inch) ----
const ONE_INCH = 1440;
const HALF_INCH = 720;
const LINE_DOUBLE = 480; // line spacing in 240ths

const BODY_FONT = 'Times New Roman';
const BODY_SIZE = 24; // half-points → 12pt

// ---- Helpers --------------------------------------------------------------

const stripHtml = (html: string): string => {
  if (typeof window === 'undefined') return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return doc.body.textContent || '';
};

/**
 * Round a raw word count to a "nice" presentation number per SMF convention:
 *   <  1,500 → nearest 100
 *   <  10,000 → nearest 500
 *   < 100,000 → nearest 1,000
 *   ≥ 100,000 → nearest 5,000
 * Always rounded UP — publishers prefer over-estimates to surprises.
 */
function roundedWordCount(raw: number): number {
  const step =
    raw < 1500 ? 100 : raw < 10000 ? 500 : raw < 100000 ? 1000 : 5000;
  return Math.ceil(raw / step) * step;
}

function pickSurname(author: string): string {
  // Strip leading bylines like "by " then take the last token.
  const cleaned = author.replace(/^\s*by\s+/i, '').trim();
  if (!cleaned) return 'Author';
  const parts = cleaned.split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * Title keyword for the running header — the first significant word(s) of
 * the title, in title case, dropping leading articles per SMF convention.
 * Caps at ~20 chars to keep the header line readable.
 */
function titleKeyword(title: string): string {
  const stripped = title.replace(/^(the|a|an)\s+/i, '').trim();
  if (stripped.length <= 20) return stripped;
  return stripped.split(/\s+/)[0];
}

/**
 * Count words across all chapters by stripping HTML and splitting on
 * whitespace. Cheap, deterministic, agrees within a word or two with the
 * editor's TipTap CharacterCount.
 */
function countAllWords(chapters: Chapter[]): number {
  return chapters.reduce((sum, c) => {
    const text = stripHtml(c.content)
      .replace(/\s+/g, ' ')
      .trim();
    return sum + (text ? text.split(' ').filter(Boolean).length : 0);
  }, 0);
}

// ---- HTML → docx ----------------------------------------------------------

/**
 * Walk inline children, preserving nested bold/italic/underline. Previously
 * this only looked one element deep, so `<p>plain <em>italic</em></p>` lost
 * the italics when the structure was `<em><strong>...</strong></em>`.
 */
function inlineRuns(parent: Node, inherit: {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
} = {}): TextRun[] {
  const out: TextRun[] = [];
  parent.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(
        new TextRun({
          text: node.textContent || '',
          font: BODY_FONT,
          size: BODY_SIZE,
          bold: inherit.bold,
          italics: inherit.italics,
          underline: inherit.underline ? {} : undefined,
        }),
      );
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const next = {
      bold: inherit.bold || el.nodeName === 'STRONG' || el.nodeName === 'B',
      italics: inherit.italics || el.nodeName === 'EM' || el.nodeName === 'I',
      underline: inherit.underline || el.nodeName === 'U',
    };
    if (el.nodeName === 'BR') {
      out.push(new TextRun({ text: '', break: 1, font: BODY_FONT, size: BODY_SIZE }));
      return;
    }
    out.push(...inlineRuns(el, next));
  });
  return out;
}

/** Detect scene-break markers, which SMF renders as a centered # on its own line. */
function isSceneBreak(text: string): boolean {
  const t = text.trim();
  return t === '#' || t === '***' || t === '###' || t === '* * *';
}

function htmlToParagraphs(html: string): Paragraph[] {
  if (typeof window === 'undefined') return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const out: Paragraph[] = [];

  doc.body.childNodes.forEach((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const text = (el.textContent || '').trim();

    if (el.nodeName === 'P') {
      if (isSceneBreak(text)) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: '#', font: BODY_FONT, size: BODY_SIZE })],
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
          }),
        );
        return;
      }
      out.push(
        new Paragraph({
          children: inlineRuns(el),
          spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
          indent: { firstLine: HALF_INCH },
          alignment: AlignmentType.LEFT,
        }),
      );
      return;
    }

    if (el.nodeName === 'BLOCKQUOTE') {
      const isEpigraph = el.getAttribute('data-type') === 'epigraph';
      out.push(
        new Paragraph({
          children: inlineRuns(el, { italics: isEpigraph }),
          spacing: {
            line: LINE_DOUBLE,
            lineRule: LineRuleType.AUTO,
            before: 240,
            after: 240,
          },
          alignment: isEpigraph ? AlignmentType.CENTER : AlignmentType.LEFT,
          indent: isEpigraph ? undefined : { left: HALF_INCH, firstLine: 0 },
        }),
      );
      return;
    }

    // In-body headings other than the chapter title (e.g. section header).
    if (/^H[1-6]$/.test(el.nodeName)) {
      out.push(
        new Paragraph({
          children: [new TextRun({ text, font: BODY_FONT, size: BODY_SIZE, bold: true })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 480, after: 480, line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
        }),
      );
    }
  });

  return out;
}

// ---- Title-page builder ---------------------------------------------------

function buildTitlePage(metadata: ManuscriptMetadata, rawWordCount: number): Paragraph[] {
  const author = stripHtml(metadata.author);
  const title = stripHtml(metadata.title);
  const contactName = metadata.contactName ? stripHtml(metadata.contactName) : '';
  const contactAddress = metadata.contactAddress ? stripHtml(metadata.contactAddress) : '';
  const contactPhone = metadata.contactPhone ? stripHtml(metadata.contactPhone) : '';
  const contactEmail = metadata.contactEmail ? stripHtml(metadata.contactEmail) : '';
  const agentInfo = metadata.agentInfo ? stripHtml(metadata.agentInfo) : '';
  const genre = metadata.genre ? stripHtml(metadata.genre) : '';

  // Top row: contact name left, "About N words" right, on the same line via tab stop.
  const topName = contactName || (author && author !== 'Uncredited Author' ? author : 'Author Name');
  const wordsString = `About ${roundedWordCount(rawWordCount).toLocaleString()} words`;
  const topRow = new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: topName, font: BODY_FONT, size: BODY_SIZE }),
      new TextRun({ text: '\t', font: BODY_FONT, size: BODY_SIZE }),
      new TextRun({ text: wordsString, font: BODY_FONT, size: BODY_SIZE }),
    ],
    spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
  });

  // Contact lines (single-spaced — SMF tradition is to set this block tighter).
  const contactBlockLines = [
    ...contactAddress.split('\n').map((l) => l.trim()).filter(Boolean),
    contactPhone,
    contactEmail,
  ].filter(Boolean);
  const contactParas = contactBlockLines.map((line) =>
    new Paragraph({
      children: [new TextRun({ text: line, font: BODY_FONT, size: BODY_SIZE })],
      spacing: { line: 240, lineRule: LineRuleType.AUTO },
      alignment: AlignmentType.LEFT,
    }),
  );

  // Title block sits roughly at the vertical center — about 12 blank lines down.
  // Slot in agentInfo (if any) below the contact block, right-aligned.
  const agentParas = agentInfo
    ? agentInfo.split('\n').map((l) => l.trim()).filter(Boolean).map((line) =>
        new Paragraph({
          children: [new TextRun({ text: line, font: BODY_FONT, size: BODY_SIZE })],
          alignment: AlignmentType.RIGHT,
          spacing: { line: 240, lineRule: LineRuleType.AUTO },
        }),
      )
    : [];

  // Vertical gap to push the title block to roughly mid-page. The number of
  // blank lines that achieves "centered" depends on how much contact info is
  // above; aim for around 12-14 line-heights of total whitespace before the
  // title, including content above.
  const linesUsed = 1 /* top row */ + contactParas.length + agentParas.length;
  const gapLines = Math.max(4, 14 - linesUsed);
  const gapParas: Paragraph[] = Array.from({ length: gapLines }, () =>
    new Paragraph({
      children: [new TextRun({ text: '', font: BODY_FONT, size: BODY_SIZE })],
      spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
    }),
  );

  const titlePara = new Paragraph({
    children: [new TextRun({ text: title, font: BODY_FONT, size: BODY_SIZE, bold: true })],
    alignment: AlignmentType.CENTER,
    spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO, after: 240 },
  });
  const byPara = new Paragraph({
    children: [new TextRun({ text: 'by', font: BODY_FONT, size: BODY_SIZE })],
    alignment: AlignmentType.CENTER,
    spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO, after: 240 },
  });
  const authorPara = new Paragraph({
    children: [new TextRun({ text: author || 'Uncredited Author', font: BODY_FONT, size: BODY_SIZE })],
    alignment: AlignmentType.CENTER,
    spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
  });

  const genreParas = genre
    ? [
        new Paragraph({
          children: [new TextRun({ text: '', font: BODY_FONT, size: BODY_SIZE })],
          spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
        }),
        new Paragraph({
          children: [new TextRun({ text: genre, font: BODY_FONT, size: BODY_SIZE, italics: true })],
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
        }),
      ]
    : [];

  return [
    topRow,
    ...contactParas,
    ...agentParas,
    ...gapParas,
    titlePara,
    byPara,
    authorPara,
    ...genreParas,
  ];
}

// ---- Main export ----------------------------------------------------------

export interface ExportOptions {
  /**
   * When true, omit the manuscript-level title page and emit only the
   * provided chapter(s). Filename is derived from the first chapter's
   * title rather than the manuscript title.
   *
   * The running page header is kept (it still anchors page numbers and
   * the author/title-keyword in case the printout gets shuffled), and the
   * "# # #" end marker is dropped since a single chapter isn't an end.
   */
  singleChapter?: boolean;
}

export async function exportToManuscriptDocx(
  metadata: ManuscriptMetadata,
  chapters: Chapter[],
  options: ExportOptions = {},
): Promise<void> {
  const author = stripHtml(metadata.author);
  const title = stripHtml(metadata.title);
  const surname = pickSurname(author);
  const keyword = titleKeyword(title);
  const rawCount = countAllWords(chapters);
  const isSingle = !!options.singleChapter;

  // Title page — its own section, no header. Skipped for single-chapter exports.
  const titlePageSection = isSingle ? null : {
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        margin: { top: ONE_INCH, right: ONE_INCH, bottom: ONE_INCH, left: ONE_INCH },
      },
      // Suppress the body header on this section.
      titlePage: true,
    },
    headers: {
      default: new Header({ children: [new Paragraph('')] }),
      first: new Header({ children: [new Paragraph('')] }),
    },
    children: buildTitlePage(metadata, rawCount),
  };

  // Body sections — one per chapter so each chapter starts on a new page.
  const bodySections = chapters.map((chapter, index) => ({
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        margin: { top: ONE_INCH, right: ONE_INCH, bottom: ONE_INCH, left: ONE_INCH },
      },
    },
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: `${surname} / ${keyword} / `,
                font: BODY_FONT,
                size: BODY_SIZE,
              }),
              new TextRun({
                children: [PageNumber.CURRENT],
                font: BODY_FONT,
                size: BODY_SIZE,
              }),
            ],
            alignment: AlignmentType.RIGHT,
          }),
        ],
      }),
    },
    children: [
      // Drop chapter heading down roughly 1/3 of the page. About 4 line-heights
      // of double-spaced body text, plus a single empty paragraph for breathing room.
      new Paragraph({
        children: [new TextRun({ text: '', font: BODY_FONT, size: BODY_SIZE })],
        spacing: { before: ONE_INCH * 2, line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: chapter.title,
            font: BODY_FONT,
            size: BODY_SIZE,
            bold: true,
          }),
        ],
        alignment: AlignmentType.CENTER,
        heading: HeadingLevel.HEADING_1,
        spacing: {
          line: LINE_DOUBLE,
          lineRule: LineRuleType.AUTO,
          after: LINE_DOUBLE, // a double-spaced blank line below the heading
        },
      }),
      ...htmlToParagraphs(chapter.content),
      // Per SMF, "# # #" or "THE END" goes after the final chapter. For a
      // single-chapter export we skip it — a chapter isn't the end.
      ...(!isSingle && index === chapters.length - 1
        ? [
            new Paragraph({
              children: [new TextRun({ text: '', font: BODY_FONT, size: BODY_SIZE })],
              spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
            }),
            new Paragraph({
              children: [new TextRun({ text: '# # #', font: BODY_FONT, size: BODY_SIZE })],
              alignment: AlignmentType.CENTER,
              spacing: { line: LINE_DOUBLE, lineRule: LineRuleType.AUTO },
            }),
          ]
        : []),
    ],
  }));

  const doc = new Document({
    creator: author || 'Chronicle',
    title: isSingle && chapters[0] ? stripHtml(chapters[0].title) : title,
    description: isSingle ? 'Single-chapter export' : 'Standard Manuscript Format export',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE },
        },
      },
    },
    sections: titlePageSection ? [titlePageSection, ...bodySections] : bodySections,
  });

  const filenameRoot = isSingle && chapters[0]
    ? stripHtml(chapters[0].title).replace(/\s+/g, '_') || 'Chapter'
    : (title.replace(/\s+/g, '_') || 'Manuscript');
  const blob = await Packer.toBlob(doc);
  saveAs(blob, isSingle ? `${filenameRoot}.docx` : `${filenameRoot}_Manuscript.docx`);
}

// ---- Markdown export (unchanged behaviour, tidied up) ---------------------

export function exportToMarkdown(
  metadata: ManuscriptMetadata,
  chapters: Chapter[],
  options: ExportOptions = {},
): void {
  const author = stripHtml(metadata.author);
  const title = stripHtml(metadata.title);
  const isSingle = !!options.singleChapter;

  let content = '';

  // Manuscript-level header (title, author, contact) is suppressed for a
  // single-chapter export — the chapter heading below is sufficient.
  if (!isSingle) {
    content += `# ${title}\n`;
    content += `By ${author}\n\n`;
    if (metadata.genre) content += `**Genre:** ${stripHtml(metadata.genre)}\n\n`;

    if (metadata.contactName || metadata.contactEmail) {
      content += `---\n\n`;
      if (metadata.contactName) content += `${stripHtml(metadata.contactName)}\n`;
      if (metadata.contactEmail) content += `${stripHtml(metadata.contactEmail)}\n`;
      content += `\n---\n\n`;
    }
  }

  chapters.forEach((chapter) => {
    // Promote chapter title to top-level heading when there's no manuscript
    // header above it, so the file reads as a complete standalone document.
    content += `${isSingle ? '#' : '##'} ${chapter.title}\n\n`;
    const md = chapter.content
      .replace(/<p>(.*?)<\/p>/gi, '$1\n\n')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<i>(.*?)<\/i>/gi, '*$1*')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<blockquote>(.*?)<\/blockquote>/gi, '> $1\n\n')
      .replace(/<[^>]*>/g, '');
    content += `${md}\n\n`;
  });

  const filenameRoot = isSingle && chapters[0]
    ? stripHtml(chapters[0].title).replace(/\s+/g, '_') || 'Chapter'
    : (title.replace(/\s+/g, '_') || 'Manuscript');
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  saveAs(blob, `${filenameRoot}.md`);
}

// ---- HTML export ----------------------------------------------------------

/**
 * Self-contained HTML export. One file, no external assets, no scripts.
 *
 * Layout aims for readable web-paginated output: title page first, then
 * each chapter as its own <section> with a chapter heading and the chapter
 * content rendered straight from the editor's TipTap HTML.
 *
 * Inlined CSS uses serif body with comfortable line height; the print
 * stylesheet mirrors SMF conventions (double-spaced body, 1" margins,
 * chapter breaks before each section) so File → Print produces a usable
 * PDF/manuscript-ish output without needing a separate PDF exporter.
 */
export function exportToHtml(
  metadata: ManuscriptMetadata,
  chapters: Chapter[],
  options: ExportOptions = {},
): void {
  const author = stripHtml(metadata.author);
  const title = stripHtml(metadata.title);
  const genre = metadata.genre ? stripHtml(metadata.genre) : '';
  const wordCount = countAllWords(chapters);
  const isSingle = !!options.singleChapter;

  // Helper: HTML-escape attribute values. (Body chapter HTML comes from
  // TipTap which produces well-formed HTML; we trust its output structure
  // but defensively sanitize any inline <script> just in case a future
  // extension adds something unexpected.)
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const cleanBody = (html: string) =>
    html.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\son\w+="[^"]*"/gi, '');

  const chapterHtml = chapters.map((c) => `
    <section class="chapter">
      <h2 class="chapter-title">${esc(c.title)}</h2>
      <div class="chapter-body">${cleanBody(c.content)}</div>
    </section>
  `).join('\n');

  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="author" content="${esc(author)}">
  ${genre ? `<meta name="genre" content="${esc(genre)}">` : ''}
  <style>
    :root {
      --body-font: "Libre Baskerville", Georgia, "Times New Roman", serif;
      --color-ink: #1a1a1a;
      --color-paper: #fdfbf7;
      --color-rule: #d8d3c4;
    }
    * { box-sizing: border-box; }
    html, body { background: var(--color-paper); color: var(--color-ink); }
    body {
      font-family: var(--body-font);
      font-size: 18px;
      line-height: 1.7;
      max-width: 38em;
      margin: 4rem auto;
      padding: 0 1.5rem;
    }
    .title-page {
      text-align: center;
      padding: 6rem 0 8rem;
      border-bottom: 1px solid var(--color-rule);
      margin-bottom: 4rem;
    }
    .title-page h1 { font-size: 2.4rem; margin: 0 0 1rem; font-weight: 700; }
    .title-page .by { font-style: italic; opacity: 0.7; margin: 1rem 0 2rem; }
    .title-page .meta {
      font-size: 0.75rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      opacity: 0.5;
      margin-top: 3rem;
    }
    .chapter { margin-bottom: 5rem; }
    .chapter-title {
      text-align: center;
      font-size: 1.4rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      margin: 0 0 3rem;
      padding-top: 3rem;
    }
    .chapter-body p {
      margin: 0;
      text-indent: 2.2em;
    }
    .chapter-body p:first-child,
    .chapter-body h1 + p,
    .chapter-body h2 + p,
    .chapter-body h3 + p {
      text-indent: 0;
    }
    .chapter-body blockquote {
      margin: 1.5em 2em;
      font-style: italic;
      opacity: 0.85;
      border-left: 2px solid var(--color-rule);
      padding-left: 1em;
    }
    .chapter-body blockquote[data-type="epigraph"] {
      text-align: center;
      border-left: none;
      padding-left: 0;
      margin: 2em 4em;
    }
    @media (prefers-color-scheme: dark) {
      :root { --color-ink: #f1ede4; --color-paper: #232220; --color-rule: #3a3936; }
    }
    @media print {
      body { font-size: 12pt; line-height: 2; max-width: none; margin: 0; padding: 0; }
      @page { margin: 1in; size: letter; }
      .chapter { page-break-before: always; margin-bottom: 0; }
      .title-page { page-break-after: always; border: none; padding: 4in 0; }
    }
  </style>
</head>
<body>${isSingle ? '' : `
  <header class="title-page">
    <h1>${esc(title)}</h1>
    <div class="by">by ${esc(author)}</div>
    <div class="meta">
      ${genre ? `<div>${esc(genre)}</div>` : ''}
      <div>${wordCount.toLocaleString()} words</div>
    </div>
  </header>`}
  <main>
${chapterHtml}
  </main>
</body>
</html>`;

  const filenameRoot = isSingle && chapters[0]
    ? stripHtml(chapters[0].title).replace(/\s+/g, '_') || 'Chapter'
    : (title.replace(/\s+/g, '_') || 'Manuscript');
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  saveAs(blob, `${filenameRoot}.html`);
}
