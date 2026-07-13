import React, { useEffect, useMemo, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { buildCoreExtensions, EDITOR_KEYBOARD_ATTRS } from '../lib/editorExtensions';

interface CollabEditorProps {
  /** User-scoped server document name: `<encoded-user>/<manuscript>:<chapter>`. */
  docName: string;
  /** WebSocket base for the collab endpoint, e.g. wss://host/collab */
  collabUrl: string;
  /** Bearer token if the collab socket needs auth (OIDC phase). */
  token?: string;
  className?: string;
}

/**
 * Real-time collaborative editor: one Y.Doc per document name, synced to the
 * server's Hocuspocus /collab endpoint. Content lives in the Y.Doc (not an HTML
 * prop), so two clients on the same docName edit live. Reuses the shared core
 * extensions, so it keeps the app's typography + keyboard behavior.
 *
 * A fresh chapter Y.Doc is seeded from the authoritative chapter HTML by the
 * server before live updates begin.
 */
export const CollabEditor: React.FC<CollabEditorProps> = ({
  docName,
  collabUrl,
  token,
  className,
}) => {
  const ydoc = useMemo(() => new Y.Doc(), [docName]);
  const [status, setStatus] = useState<string>('connecting');

  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: collabUrl,
        name: docName,
        document: ydoc,
        token,
        onStatus: ({ status }: { status: string }) => setStatus(status),
      }),
    [collabUrl, docName, token, ydoc],
  );

  const editor = useEditor(
    {
      extensions: buildCoreExtensions({ collabDocument: ydoc }),
      editorProps: {
        attributes: {
          class: 'novel-editor-content focus:outline-none min-h-[500px]',
          ...EDITOR_KEYBOARD_ATTRS,
        },
      },
    },
    [ydoc],
  );

  // Tear the provider + doc down on unmount or when the document changes;
  // React runs this cleanup against the previous provider/ydoc before the
  // memo's recreated values take effect.
  useEffect(() => {
    return () => {
      provider.destroy();
      ydoc.destroy();
    };
  }, [provider, ydoc]);

  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-30 mb-3">
        Live · {status}
      </div>
      <EditorContent editor={editor} className="w-full" />
    </div>
  );
};
