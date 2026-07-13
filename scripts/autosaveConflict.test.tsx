import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Manuscript } from '../src/types';
import {
  ManuscriptServiceError,
  manuscriptService,
  manuscriptServiceErrorFromResponse,
} from '../src/services/manuscriptService';
import {
  manuscriptFingerprint,
  useManuscriptAutosave,
} from '../src/hooks/useManuscriptAutosave';
import { readManuscriptConflictDraft } from '../src/lib/manuscriptDraftJournal';

const base: Manuscript = {
  metadata: {
    id: 'two-device-book',
    title: 'Two device book',
    author: 'Author',
    lastModified: 1,
    revision: 1,
  },
  chapters: [{
    id: 'chapter-one',
    title: 'One',
    content: '<p>Base</p>',
    lastModified: 1,
    revision: 1,
  }],
};

const local: Manuscript = {
  metadata: { ...base.metadata, lastModified: 2 },
  chapters: [{ ...base.chapters[0], content: '<p>Local B</p>', lastModified: 2 }],
};

const authoritative: Manuscript = {
  metadata: { ...base.metadata, lastModified: 3, revision: 3 },
  chapters: [{
    ...base.chapters[0],
    content: '<p>Server A</p>',
    lastModified: 3,
    revision: 2,
  }],
};

const conflictPayload = {
  error: 'The manuscript changed on another device',
  manuscript: authoritative,
  conflicts: [{
    entity: 'chapter' as const,
    id: 'chapter-one',
    manuscriptId: 'two-device-book',
    expectedRevision: 1,
    currentRevision: 2,
    reason: 'stale-revision' as const,
  }],
};

// The transport wrapper must retain the structured 409 response. Losing this
// body makes safe, explicit recovery impossible in the hook.
const parsedError = await manuscriptServiceErrorFromResponse(new Response(
  JSON.stringify(conflictPayload),
  { status: 409, headers: { 'content-type': 'application/json' } },
), 'Failed to save manuscript');
assert(parsedError instanceof ManuscriptServiceError);
assert.equal(parsedError.status, 409);
assert.deepEqual(parsedError.authoritativeManuscript, authoritative);
assert.deepEqual(parsedError.conflicts, conflictPayload.conflicts);

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://chronicle.test/',
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type AutosaveResult = ReturnType<typeof useManuscriptAutosave>;
let autosave: AutosaveResult | null = null;
let setDocument: React.Dispatch<React.SetStateAction<Manuscript>> | null = null;
let setSessionKey: React.Dispatch<React.SetStateAction<number | null>> | null = null;
let updateCalls = 0;
let lastSubmitted: Manuscript | null = null;

const originalUpdate = manuscriptService.update;
manuscriptService.update = async () => {
  updateCalls += 1;
  throw parsedError;
};

function Harness() {
  const [manuscript, setManuscript] = useState(local);
  const [sessionKey, setActiveSessionKey] = useState<number | null>(1);
  setDocument = setManuscript;
  setSessionKey = setActiveSessionKey;
  autosave = useManuscriptAutosave({
    sessionKey,
    manuscriptId: sessionKey === null ? null : manuscript.metadata.id,
    manuscript: sessionKey === null ? null : manuscript,
    baselineFingerprint: manuscriptFingerprint(base),
    debounceMs: 0,
    journalDebounceMs: 0,
    onConflictReloaded: (server) => setManuscript(server),
    onConflictDraftRestored: (draft) => setManuscript(draft),
  });
  return null;
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

const root = createRoot(document.getElementById('root')!);
try {
  await act(async () => root.render(<Harness />));
  await settle();
  assert(autosave);
  assert.equal(autosave.status, 'conflict');
  assert.equal(autosave.canReloadServerVersion, true);
  assert.equal(updateCalls, 1);

  // More typing is retained locally, but the latched conflict must prevent an
  // infinite sequence of PUTs carrying the same stale chapter revision.
  await act(async () => {
    setDocument!((current) => ({
      ...current,
      chapters: current.chapters.map((chapter) => ({
        ...chapter,
        content: '<p>Local B, continued after conflict</p>',
        lastModified: 4,
      })),
    }));
  });
  await settle();
  assert.equal(updateCalls, 1);
  assert.equal(autosave.status, 'conflict');

  // The explicit reload first persists the latest local state in an isolated
  // recovery slot, then hydrates the exact authoritative 409 manuscript.
  await act(async () => {
    assert.equal(autosave!.reloadServerVersion(), true);
  });
  await settle();
  assert.equal(autosave.status, 'saved');
  assert.equal(autosave.hasConflictRecovery, true);
  assert.equal(updateCalls, 1);
  assert.equal(
    readManuscriptConflictDraft('two-device-book')?.manuscript.chapters[0].content,
    '<p>Local B, continued after conflict</p>',
  );

  // Restoring that copy is another explicit transition. It rebases the local
  // prose onto A's current revision before autosave, so it does not repeat the
  // stale request, and clears the recovery copy only after acknowledgement.
  manuscriptService.update = async (_id, submitted) => {
    updateCalls += 1;
    lastSubmitted = structuredClone(submitted);
    return {
      ...submitted,
      metadata: { ...submitted.metadata, revision: 4 },
      chapters: submitted.chapters.map((chapter) => ({ ...chapter, revision: 3 })),
    };
  };
  await act(async () => {
    assert.equal(autosave!.restoreConflictDraft(), true);
  });
  await settle();
  assert.equal(updateCalls, 2);
  assert.equal(lastSubmitted?.chapters[0].revision, authoritative.chapters[0].revision);
  assert.equal(lastSubmitted?.chapters[0].content, '<p>Local B, continued after conflict</p>');
  assert.equal(autosave.status, 'saved');
  assert.equal(autosave.hasConflictRecovery, false);
  assert.equal(readManuscriptConflictDraft('two-device-book'), null);

  // Successful manuscript deletion closes the active session while paused.
  // A later book/session must not inherit that pause and silently stop saving.
  await act(async () => autosave!.pause());
  await act(async () => setSessionKey!(null));
  await settle();
  await act(async () => setSessionKey!(2));
  await settle();
  assert.equal(updateCalls, 3, 'a new session inherited the previous session pause');

  // A failed online PUT is not merely a generic server error when the exact
  // latest snapshot also cannot be journaled. Keep the stronger data-loss
  // warning visible instead of overwriting it in the request catch block.
  const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  const originalWarn = console.warn;
  storagePrototype.setItem = () => { throw new Error('simulated storage denial'); };
  console.warn = () => {};
  manuscriptService.update = async () => {
    updateCalls += 1;
    throw new Error('simulated gateway failure');
  };
  await act(async () => {
    setDocument!((current) => ({
      ...current,
      metadata: { ...current.metadata, title: 'Unsaved without journal', lastModified: 10 },
    }));
  });
  await settle();
  assert.equal(updateCalls, 4);
  assert.equal(autosave.status, 'draft-error');
  assert.match(autosave.error ?? '', /remote save failed.*draft storage is unavailable/i);
  storagePrototype.setItem = originalSetItem;
  console.warn = originalWarn;
} finally {
  await act(async () => root.unmount());
  manuscriptService.update = originalUpdate;
  dom.window.close();
}

console.log('Autosave conflict recovery checks passed.');
