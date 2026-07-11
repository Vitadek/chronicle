import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { Chapter, ManuscriptMetadata } from '../types';
import { fileTimestamp } from './exportFilename';
import { loadCoverBlobUrl } from '../services/coverService';

/**
 * EPUB3 export.
 *
 * An EPUB is a renamed zip with a specific layout:
 *   mimetype                    — uncompressed, MUST be first
 *   META-INF/container.xml      — points to the package document
 *   OEBPS/content.opf           — package: manifest, spine, metadata
 *   OEBPS/nav.xhtml             — navigation document (TOC)
 *   OEBPS/cover.xhtml           — landing page rendering the cover image
 *   OEBPS/copyright.xhtml       — generic boilerplate copyright page
 *   OEBPS/chapters/cN.xhtml     — one per chapter
 *   OEBPS/cover.{jpg,png,webp}  — the cover image (defaulted if absent)
 *   OEBPS/style.css             — single shared stylesheet
 *
 * We hand-write the small XML/XHTML rather than pulling a heavyweight
 * EPUB lib — the spec surface we need is small and writing it directly
 * is faster than wiring a build dependency. EPUBCheck-clean as far as a
 * single chapter of body content goes; if you want richer features later
 * (footnotes, fixed layout) you'd swap to epub-gen-memory or similar.
 *
 * Reader notes:
 *   - mimetype MUST be stored without compression. JSZip respects that
 *     when we pass compression:'STORE' for that file only.
 *   - Cover image gets a properties="cover-image" in the manifest so
 *     Kindle / Apple Books treat it as the thumbnail.
 *   - We include both an EPUB3 nav.xhtml and an EPUB2-style toc.ncx for
 *     readers that haven't caught up to EPUB3 fully (e.g. older Kindle
 *     pipelines). Modern readers prefer nav.xhtml.
 */

interface EpubOptions {
  /** Generic copyright boilerplate is appended unless this is provided. */
  copyrightNotice?: string;
}

/**
 * The default cover used when no upload exists. Rendered server-side via the
 * exact same path as a real cover — we just embed an inline SVG so we have
 * zero external dependencies and works offline.
 */
function defaultCoverSvg(title: string, author: string): string {
  // 1600×2400 ≈ 2:3 aspect, the EPUB3 cover-image recommendation.
  // ASCII-only SVG; safe to drop straight into XHTML/embed.
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const t = esc(title || 'Untitled');
  const a = esc(author || 'Anonymous');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 2400" width="1600" height="2400">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1c1b1a"/>
      <stop offset="100%" stop-color="#3a3735"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="2400" fill="url(#g)"/>
  <line x1="200" y1="600" x2="1400" y2="600" stroke="#c9b896" stroke-width="2"/>
  <line x1="200" y1="1800" x2="1400" y2="1800" stroke="#c9b896" stroke-width="2"/>
  <text x="800" y="1100" text-anchor="middle" fill="#f1ede4"
        font-family="Georgia, serif" font-size="120" font-style="italic">${t}</text>
  <text x="800" y="1300" text-anchor="middle" fill="#c9b896"
        font-family="Georgia, serif" font-size="64" font-style="italic">by ${a}</text>
  <text x="800" y="2200" text-anchor="middle" fill="#9a8d75"
        font-family="Georgia, serif" font-size="36" letter-spacing="12">CHRONICLE</text>
</svg>`;
}

/** Sanitise chapter HTML to be valid XHTML-ish: void tags self-close. */
function cleanChapterHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '<br/>')
    .replace(/<hr\s*\/?>/gi, '<hr/>')
    .replace(/<img([^>]*?)\/?>/gi, '<img$1/>')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    // Strip our internal mark spans (data-comment, data-audio-token) so the
    // exported book doesn't carry editor metadata.
    .replace(/\sdata-(comment|audio-token|from|to)="[^"]*"/g, '')
    .replace(/<span\s*(?:class="manuscript-(?:comment|audio)-marker"\s*)?>([^<]*)<\/span>/g, '$1');
}

/** Format the package <dc:date>: RFC 3339 UTC. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const XHTML_DOCTYPE = '<?xml version="1.0" encoding="UTF-8"?>';

function chapterXhtml(title: string, body: string): string {
  return `${XHTML_DOCTYPE}
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
  <link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body>
  <section epub:type="chapter">
    <h2 class="chapter-title">${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h2>
    ${body}
  </section>
</body>
</html>`;
}

function coverXhtml(coverHref: string, title: string): string {
  return `${XHTML_DOCTYPE}
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Cover</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
  <style>
    body { margin: 0; padding: 0; }
    .cover { display: flex; align-items: center; justify-content: center; height: 100vh; }
    .cover img { max-width: 100%; max-height: 100%; }
  </style>
</head>
<body>
  <section epub:type="cover">
    <div class="cover">
      <img src="${coverHref}" alt="Cover of ${title.replace(/"/g, '&quot;')}"/>
    </div>
  </section>
</body>
</html>`;
}

function copyrightXhtml(title: string, author: string, notice?: string): string {
  const year = new Date().getFullYear();
  const body = notice
    ? notice.split('\n').map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('\n      ')
    : `<p>Copyright © ${year} ${author.replace(/&/g, '&amp;').replace(/</g, '&lt;')}. All rights reserved.</p>
      <p>This is a work of fiction. Names, characters, businesses, places, events, locales, and incidents are either the products of the author's imagination or used in a fictitious manner. Any resemblance to actual persons, living or dead, or actual events is purely coincidental.</p>
      <p>No part of this book may be reproduced or transmitted in any form or by any means, electronic or mechanical, including photocopying, recording, or by any information storage and retrieval system, without the express written permission of the author.</p>`;
  return `${XHTML_DOCTYPE}
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Copyright</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <section epub:type="copyright-page">
    <h2>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h2>
    ${body}
  </section>
</body>
</html>`;
}

function navXhtml(chapters: Chapter[]): string {
  const items = chapters.map((c, i) => {
    const safeTitle = c.title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `      <li><a href="chapters/c${i + 1}.xhtml">${safeTitle}</a></li>`;
  }).join('\n');
  return `${XHTML_DOCTYPE}
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h2>Contents</h2>
    <ol>
      <li><a href="cover.xhtml">Cover</a></li>
      <li><a href="copyright.xhtml">Copyright</a></li>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

function ncxXml(title: string, identifier: string, chapters: Chapter[]): string {
  const points = chapters.map((c, i) => {
    const safeTitle = c.title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `    <navPoint id="ch${i + 1}" playOrder="${i + 3}">
      <navLabel><text>${safeTitle}</text></navLabel>
      <content src="chapters/c${i + 1}.xhtml"/>
    </navPoint>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${identifier}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></docTitle>
  <navMap>
    <navPoint id="cover" playOrder="1">
      <navLabel><text>Cover</text></navLabel>
      <content src="cover.xhtml"/>
    </navPoint>
    <navPoint id="copyright" playOrder="2">
      <navLabel><text>Copyright</text></navLabel>
      <content src="copyright.xhtml"/>
    </navPoint>
${points}
  </navMap>
</ncx>`;
}

function packageOpf(
  title: string,
  author: string,
  language: string,
  identifier: string,
  chapters: Chapter[],
  coverFile: { name: string; mime: string },
): string {
  const chapterManifest = chapters.map((_c, i) =>
    `    <item id="ch${i + 1}" href="chapters/c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n');
  const chapterSpine = chapters.map((_c, i) =>
    `    <itemref idref="ch${i + 1}"/>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${identifier}</dc:identifier>
    <dc:title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</dc:title>
    <dc:creator>${author.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</dc:creator>
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${nowIso()}</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="${coverFile.name}" media-type="${coverFile.mime}" properties="cover-image"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="copyright" href="copyright.xhtml" media-type="application/xhtml+xml"/>
${chapterManifest}
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover" linear="yes"/>
    <itemref idref="copyright" linear="yes"/>
${chapterSpine}
    <itemref idref="nav" linear="no"/>
  </spine>
</package>`;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const STYLESHEET = `body { font-family: Georgia, "Times New Roman", serif; line-height: 1.6; margin: 1em; }
h1, h2, h3 { font-family: Georgia, serif; }
h2.chapter-title { text-align: center; font-weight: bold; font-size: 1.4em; margin: 3em 0 2em; }
p { margin: 0; text-indent: 1.5em; }
p:first-child, h1 + p, h2 + p, h3 + p { text-indent: 0; }
blockquote { margin: 1.5em 2em; font-style: italic; }
blockquote[data-type="epigraph"] { text-align: center; margin: 2em 3em; }`;

function isoFromTitle(title: string): string {
  // Crude but unique enough for a personal export.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `urn:chronicle:${slug || 'untitled'}:${Date.now()}`;
}

function stripHtmlMinimal(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

/**
 * Resolve the cover image bytes for the export.
 * Returns null if no upload exists — caller falls back to the default SVG.
 */
async function fetchUploadedCover(coverFilename: string): Promise<{ bytes: ArrayBuffer; mime: string; ext: string } | null> {
  try {
    const url = await loadCoverBlobUrl(coverFilename);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    // Sniff again client-side from the blob's content-type — already enforced
    // server-side, but the loadCoverBlobUrl helper might cache a generic
    // type. Falling back to JPEG mime if unknown is safe for readers.
    const mime = res.headers.get('content-type') || 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return { bytes, mime, ext };
  } catch {
    return null;
  }
}

export async function exportToEpub(
  metadata: ManuscriptMetadata,
  chapters: Chapter[],
  options: EpubOptions = {},
): Promise<void> {
  const author = stripHtmlMinimal(metadata.author) || 'Anonymous';
  const title = stripHtmlMinimal(metadata.title) || 'Untitled';
  const language = 'en';
  const identifier = isoFromTitle(title);

  const zip = new JSZip();

  // mimetype MUST be the first entry, uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);

  const oebps = zip.folder('OEBPS')!;

  // Cover image: prefer the user's upload, fall back to a generated SVG.
  let coverFile: { name: string; mime: string };
  const uploaded = metadata.coverArt ? await fetchUploadedCover(metadata.coverArt) : null;
  if (uploaded) {
    const name = `cover.${uploaded.ext}`;
    oebps.file(name, uploaded.bytes);
    coverFile = { name, mime: uploaded.mime };
  } else {
    oebps.file('cover.svg', defaultCoverSvg(title, author));
    coverFile = { name: 'cover.svg', mime: 'image/svg+xml' };
  }

  // Stylesheet, cover XHTML, copyright XHTML, nav, NCX, package.
  oebps.file('style.css', STYLESHEET);
  oebps.file('cover.xhtml', coverXhtml(coverFile.name, title));
  oebps.file('copyright.xhtml', copyrightXhtml(title, author, options.copyrightNotice));
  oebps.file('nav.xhtml', navXhtml(chapters));
  oebps.file('toc.ncx', ncxXml(title, identifier, chapters));
  oebps.file('content.opf', packageOpf(title, author, language, identifier, chapters, coverFile));

  // Chapter XHTML files.
  const chaptersFolder = oebps.folder('chapters')!;
  chapters.forEach((c, i) => {
    chaptersFolder.file(`c${i + 1}.xhtml`, chapterXhtml(c.title || `Chapter ${i + 1}`, cleanChapterHtml(c.content || '')));
  });

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
  const filename = `${title.replace(/\s+/g, '_') || 'Manuscript'}_${fileTimestamp()}.epub`;
  saveAs(blob, filename);
}
