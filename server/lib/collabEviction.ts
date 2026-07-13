export interface CollaborationEvictionTarget {
  userId: string;
  manuscriptId: string;
  chapterId?: string;
}

type CollaborationEvictor = (target: CollaborationEvictionTarget) => void;

let activeEvictor: CollaborationEvictor | null = null;

/**
 * Register the live collaboration server's cache/socket eviction hook.
 *
 * Persistence code deliberately depends only on this small registry rather
 * than importing the Hocuspocus server and creating a repository cycle.
 */
export function registerCollaborationEvictor(
  evictor: CollaborationEvictor,
): () => void {
  activeEvictor = evictor;
  return () => {
    if (activeEvictor === evictor) activeEvictor = null;
  };
}

/** Close sockets and evict any loaded Y.Doc covered by a durable deletion. */
export function evictCollaborationResidue(
  target: CollaborationEvictionTarget,
): void {
  activeEvictor?.(target);
}
