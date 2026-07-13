import { db } from '../db';
import { purgeChapterCollaborationResidue } from './manuscriptRepository';

const liveChapter = db.prepare(`
  SELECT 1 FROM chapters
  WHERE user_id = ? AND manuscript_id = ? AND id = ? AND deleted_at IS NULL
`);
const upsertYdoc = db.prepare(`
  INSERT INTO ydocs (name, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

/**
 * Persist an already-authorized Hocuspocus state only while its owning chapter
 * is live. All statements are synchronous, so a REST delete cannot interleave
 * between the ownership check and the write on this process's event loop.
 */
export function persistCollaborativeStateIfLive(
  documentName: string,
  state: Uint8Array,
  userId: string,
  manuscriptId: string,
  chapterId: string,
): boolean {
  if (!liveChapter.get(userId, manuscriptId, chapterId)) {
    purgeChapterCollaborationResidue(userId, manuscriptId, chapterId);
    return false;
  }
  upsertYdoc.run(documentName, Buffer.from(state), Date.now());
  return true;
}
