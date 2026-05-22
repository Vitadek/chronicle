import path from 'path';
import fs from 'fs';
import { db, LOCAL_USER_ID } from '../db';
import { config } from '../config';

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
      const mLast = (m.metadata.lastModified as number) || Date.now();
      const metaToStore = { ...m.metadata };

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO manuscripts (user_id, id, data, last_modified, deleted_at)
           VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(user_id, id) DO UPDATE SET
             data = CASE WHEN excluded.last_modified > manuscripts.last_modified
                         THEN excluded.data ELSE manuscripts.data END,
             last_modified = MAX(manuscripts.last_modified, excluded.last_modified)`,
        ).run(LOCAL_USER_ID, mId, JSON.stringify(metaToStore), mLast);

        const upCh = db.prepare(
          `INSERT INTO chapters
             (user_id, manuscript_id, id, title, content, position, last_modified, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(user_id, manuscript_id, id) DO UPDATE SET
             title = CASE WHEN excluded.last_modified > chapters.last_modified
                          THEN excluded.title ELSE chapters.title END,
             content = CASE WHEN excluded.last_modified > chapters.last_modified
                            THEN excluded.content ELSE chapters.content END,
             position = excluded.position,
             last_modified = MAX(chapters.last_modified, excluded.last_modified)`,
        );

        (m.chapters || []).forEach((c: any, idx: number) => {
          upCh.run(
            LOCAL_USER_ID,
            mId,
            c.id,
            c.title || '',
            c.content || '',
            idx,
            c.lastModified || mLast,
          );
        });
      });
      tx();

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
