import { Editor } from '@tiptap/core';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { buildCoreExtensions, EDITOR_KEYBOARD_ATTRS } from '../src/lib/editorExtensions';
import { TenseShift } from '../src/lib/TenseShift';
import { Grammar } from '../src/lib/Grammar';
import { setGrammarEndpoint } from '../src/lib/grammar/languagetool';
import './editor.css';
import '../src/styles/checkers.css';

/**
 * Standalone TipTap editing canvas hosted by the Flutter app inside a WebView.
 *
 * Two modes:
 *  - HTML mode (default): content arrives via `chronicleEditor.setContent()` and
 *    leaves via the debounced `onUpdate` event.
 *  - Collab mode: `chronicleEditor.startCollab(docName)` binds the editor to a
 *    Y.Doc synced over a Hocuspocus provider whose WebSocket is SHIMMED through
 *    the Flutter bridge — native Dart owns the real socket + auth and relays the
 *    bytes (see BridgeWebSocket). The Hocuspocus protocol itself stays here.
 */

// ---- Flutter bridge ---------------------------------------------------------
interface FlutterBridge {
  callHandler: (name: string, ...args: unknown[]) => Promise<unknown>;
}
function emit(event: string, payload?: unknown): void {
  const b = (window as unknown as { flutter_inappwebview?: FlutterBridge }).flutter_inappwebview;
  if (b?.callHandler) {
    b.callHandler(event, payload);
  } else {
    window.parent?.postMessage({ source: 'chronicle-editor', event, payload }, '*');
    console.debug('[chronicle-editor]', event, payload);
  }
}

// Binary <-> base64 for relaying Yjs/Hocuspocus frames over the (JSON) bridge.
function bytesToB64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/**
 * A WebSocket whose I/O is relayed by native Dart over the bridge. Implements
 * just enough of the WebSocket interface for HocuspocusProvider. Native calls
 * `_open/_message/_close` (via window.__collab) to drive it.
 */
class BridgeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType = 'arraybuffer';
  readyState = 0;
  url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    (window as unknown as { __collabSocket?: BridgeWebSocket }).__collabSocket = this;
    emit('collabOpen', { url });
  }
  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === 'string') emit('collabSendText', data);
    else emit('collabSend', bytesToB64(data));
  }
  close(): void {
    this.readyState = this.CLOSING;
    emit('collabClose', {});
    this.readyState = this.CLOSED;
    this.onclose?.({});
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (type === 'open') this.onopen = fn;
    else if (type === 'message') this.onmessage = fn as (ev: { data: ArrayBuffer }) => void;
    else if (type === 'close') this.onclose = fn;
    else if (type === 'error') this.onerror = fn;
  }
  removeEventListener(): void { /* single-handler shim */ }
  _open(): void { this.readyState = this.OPEN; this.onopen?.({}); }
  _message(b64: string): void { this.onmessage?.({ data: b64ToBytes(b64).buffer }); }
  _close(): void { this.readyState = this.CLOSED; this.onclose?.({}); }
}

// ---- Editor (recreatable when switching into collab) ------------------------
const mount = document.querySelector('#editor') as HTMLElement;
let applyingRemote = false;
let updateTimer: number | undefined;
function scheduleUpdate(ed: Editor): void {
  clearTimeout(updateTimer);
  updateTimer = window.setTimeout(() => {
    emit('onUpdate', {
      html: ed.getHTML(),
      words: (ed.storage as { characterCount?: { words?: () => number } }).characterCount?.words?.() ?? 0,
    });
  }, 300);
}
function selectionState(ed: Editor) {
  return {
    marks: { bold: ed.isActive('bold'), italic: ed.isActive('italic'), underline: ed.isActive('underline') },
    blockType: ed.isActive('heading', { level: 1 }) ? 'h1'
      : ed.isActive('heading', { level: 2 }) ? 'h2'
        : ed.isActive('heading', { level: 3 }) ? 'h3'
          : ed.isActive('blockquote') ? 'blockquote' : 'paragraph',
  };
}

function makeEditor(collabDocument?: Y.Doc): Editor {
  return new Editor({
    element: mount,
    extensions: [
      ...buildCoreExtensions({ placeholder: 'Once upon a time…', collabDocument }),
      // Same local checkers as the web client; toggled from native settings via
      // the bridge. Findings are emitted so a native list can render them.
      TenseShift.configure({ enabled: false, onShifts: (hits) => emit('onTenseShifts', hits) }),
      Grammar.configure({ enabled: false, onMarks: (marks) => emit('onGrammarMarks', marks) }),
    ],
    // In collab mode content comes from the Y.Doc, not an initial string.
    content: collabDocument ? undefined : '<p></p>',
    editorProps: { attributes: { ...EDITOR_KEYBOARD_ATTRS } },
    onCreate: () => emit('onReady'),
    onUpdate: ({ editor }) => {
      if (applyingRemote) return;
      scheduleUpdate(editor as Editor);
    },
    onSelectionUpdate: ({ editor }) => emit('onSelection', selectionState(editor as Editor)),
  });
}

let editor: Editor = makeEditor();
let provider: HocuspocusProvider | undefined;
let ydoc: Y.Doc | undefined;

// ---- Bridge API exposed to Flutter (window.chronicleEditor) ------------------
(window as unknown as { chronicleEditor: unknown }).chronicleEditor = {
  setContent(html: string): void {
    applyingRemote = true;
    editor.commands.setContent(html && html.trim() ? html : '<p></p>');
    applyingRemote = false;
  },
  getContent(): string {
    return editor.getHTML();
  },
  focus(): void {
    editor.commands.focus('end');
  },
  setTheme(theme: 'light' | 'dark'): void {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  },
  /** Live tense-shift squiggles (compromise, lazy-loaded). */
  setTenseCheck(enabled: boolean): void {
    editor.commands.setTenseCheck(enabled);
  },
  /** Point grammar at the Chronicle server (LanguageTool proxy) + auth token.
   *  Call before enabling grammar. */
  setGrammarEndpoint(base: string, token?: string): void {
    setGrammarEndpoint(base, token ?? null);
  },
  /** Live grammar/style squiggles via the server's LanguageTool proxy. */
  setGrammarCheck(enabled: boolean): void {
    editor.commands.setGrammarCheck(enabled);
  },
  /** Switch into real-time collaboration for a document. Native relays the
   *  socket; content then lives in the synced Y.Doc. */
  startCollab(docName: string, token?: string): void {
    if (provider) { provider.destroy(); provider = undefined; }
    if (ydoc) { ydoc.destroy(); }
    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: 'ws://bridge/collab', // nominal — native opens the real socket
      name: docName,
      document: ydoc,
      token: token || undefined,
      WebSocketPolyfill: BridgeWebSocket as unknown as typeof WebSocket,
      onSynced: () => emit('onCollabSynced', { docName }),
    });
    editor.destroy();
    editor = makeEditor(ydoc);
  },
  command(name: string, payload?: { level?: number; comment?: string }): void {
    const chain = editor.chain().focus() as unknown as Record<string, (...a: unknown[]) => unknown>;
    switch (name) {
      case 'toggleBold': (chain as any).toggleBold().run(); break;
      case 'toggleItalic': (chain as any).toggleItalic().run(); break;
      case 'toggleUnderline': (chain as any).toggleUnderline().run(); break;
      case 'setHeading': (chain as any).toggleHeading({ level: payload?.level ?? 1 }).run(); break;
      case 'insertSceneBreak': (chain as any).setHorizontalRule().run(); break;
      case 'setEpigraph': (chain as any).setEpigraph().run(); break;
      case 'toggleComment':
        if (payload?.comment) (chain as any).setMark('comment', { comment: payload.comment }).run();
        else (chain as any).unsetMark('comment').run();
        break;
      case 'undo': (chain as any).undo().run(); break;
      case 'redo': (chain as any).redo().run(); break;
      default: console.warn('[chronicle-editor] unknown command:', name);
    }
  },
};

// ---- Native -> JS socket relay (native calls these as the WS delivers) -------
(window as unknown as { __collab: unknown }).__collab = {
  open(): void { (window as unknown as { __collabSocket?: BridgeWebSocket }).__collabSocket?._open(); },
  message(b64: string): void { (window as unknown as { __collabSocket?: BridgeWebSocket }).__collabSocket?._message(b64); },
  close(): void { (window as unknown as { __collabSocket?: BridgeWebSocket }).__collabSocket?._close(); },
};
