import path from 'path';
import fs from 'fs';
import { LOCAL_USER_ID } from '../db';
import { config } from '../config';
import { saveLegacyManuscript, type ManuscriptRecord } from '../lib/manuscriptRepository';

/**
 * Imports any pre-existing data/manuscripts/*.json files into SQLite under
 * the local user. Runs at server boot and is idempotent: re-running on an
 * already-imported file is a no-op (LWW protects it).
 *
 * After successful import, the JSON file is renamed to .imported so we don't
 * keep re-importing on every boot, but we never delete the user's data.
 */
export function importLegacyManuscripts(): void {
  const dir = path.join(config.dataDir, 'manuscripts');
  if (!fs.existsSync(dir)) return;

  let imported = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, 'utf-8');
      if (!raw.trim()) {
        // Empty file — skip and rename so we stop looking at it.
        fs.renameSync(full, `${full}.empty`);
        continue;
      }
      const m = JSON.parse(raw);
      if (!m?.metadata?.id) continue;

      const mId = m.metadata.id as string;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(mId)) {
        throw new Error('Invalid manuscript id');
      }
      const rawLastModified = m.metadata.lastModified;
      const mLast = typeof rawLastModified === 'number' &&
        Number.isSafeInteger(rawLastModified) && rawLastModified >= 0
        ? rawLastModified
        : Date.now();
      const chapters = (Array.isArray(m.chapters) ? m.chapters : []).map(
        (chapter: Record<string, unknown>) => {
          const id = String(chapter.id || '');
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
            throw new Error(`Invalid chapter id: ${id}`);
          }
          return {
            id,
            title: typeof chapter.title === 'string' ? chapter.title : '',
            content: typeof chapter.content === 'string' ? chapter.content : '',
            lastModified:
              typeof chapter.lastModified === 'number' && chapter.lastModified >= 0
                ? chapter.lastModified
                : mLast,
          };
        },
      );
      const manuscript: ManuscriptRecord = {
        metadata: {
          ...m.metadata,
          id: mId,
          title: typeof m.metadata.title === 'string' ? m.metadata.title : '',
          author: typeof m.metadata.author === 'string'
            ? m.metadata.author
            : 'Uncredited Author',
          lastModified: mLast,
        },
        chapters,
      };
      saveLegacyManuscript(LOCAL_USER_ID, manuscript);

      fs.renameSync(full, `${full}.imported`);
      imported++;
    } catch (err) {
      console.warn(`Skipping ${file}: ${(err as Error).message}`);
    }
  }

  if (imported > 0) {
    console.log(`[migrate] Imported ${imported} legacy manuscript(s) into SQLite.`);
  }
}
