# Chronicle plugins

A plugin is a **git repo**. You paste its URL into Settings → Plugins; Chronicle
clones it, compiles it on the server, and loads it. Plugin authors write plain
TypeScript — **no build tooling, no bundler, no `npm install`** on their side.

Every feature is a first-class plugin using the same API: the bundled Chibi
companion, the official plugins below, and anything you write.

- [Installing a plugin](#installing-a-plugin) · [The official plugins](#the-official-plugins)
- [Trust model](#trust-model--read-this-first)
- [Writing your own](#the-shape-of-a-plugin-repo) · [Contribution slots](#what-you-can-contribute)

---

## Installing a plugin

**Settings → Plugins → Install from git**, paste the repo URL, hit **Install**,
then **Enable** it.

Chronicle clones the repo, validates its manifest, and compiles it server-side.
Nothing is downloaded or built by hand.

### The official plugins

Each lives in its own repo. Paste any of these URLs:

| Plugin | Repo URL | What it does |
|---|---|---|
| **Proofreader** | `https://github.com/Vitadek/chronicle-plugin-proofreader.git` | Guided revision pass: spelling, grammar, observation-only AI clarity check |
| **Outliner** | `https://github.com/Vitadek/chronicle-plugin-outliner.git` | Synopsis, navigation, plot canvas, character sheets, notes — with a pop-out window |
| **Grammar Check** | `https://github.com/Vitadek/chronicle-plugin-grammar-check.git` | Live LanguageTool squiggles + a custom dictionary |
| **Tense Check** | `https://github.com/Vitadek/chronicle-plugin-tense-check.git` | Flags sentences drifting from a paragraph's narrative tense |
| **Autocorrect** | `https://github.com/Vitadek/chronicle-plugin-autocorrect.git` | Deterministic fixes + sentence capitalization as you type |
| **Issues Panel** | `https://github.com/Vitadek/chronicle-plugin-issues-panel.git` | One list of every checker finding, plus an on-demand AI grammar pass |
| **Smart Thesaurus** | `https://github.com/Vitadek/chronicle-plugin-thesaurus.git` | Selection synonyms — offline first, optional AI lookup |

> **Grammar Check / Tense Check / Autocorrect** replace the built-in checkers.
> Turn the corresponding built-in toggle **off** in Settings before enabling
> them, or you'll get doubled squiggles.
>
> **Issues Panel** shows findings published by the checker plugins — install
> Grammar Check and/or Tense Check alongside it, or its list stays empty.

### Updating

Chronicle never updates a plugin behind your back.

- **Check for updates** fetches the repo and lists the incoming commit subjects.
- **Update** pulls and recompiles.
- **Pin** freezes the plugin at its current commit; updates stop being offered
  until you unpin. Pin anything you rely on mid-draft.

### Requirements

- **Grammar Check / Proofreader** need the LanguageTool sidecar
  (`LANGUAGETOOL_URL`, shipped in the compose files).
- **AI features** (clarity pass, AI grammar pass, thesaurus AI lookup) need an AI
  provider configured, and are hidden entirely when `AI_UI=off`. The clarity and
  AI-grammar passes specifically need `GEMINI_API_KEY`.

### Installing from a local folder (development)

Instead of a URL, give the **path** to a plugin folder on the server's
filesystem. Handy while writing one; re-install to pick up changes.

---

## Trust model — read this first

Plugins run **inside the app with full privileges**. They can read your
`localStorage` (including your auth token), call any API, and render anything.
This is the same model as Obsidian and VS Code: **trust on install, not a
sandbox.**

Install only repos you trust and have read. Chronicle's protections are that
installing is an authenticated, deliberate act, and that the compiled bundle is
served only to logged-in users — not that a hostile plugin is contained.

---

## The shape of a plugin repo

```
my-plugin/
  chronicle-plugin.json     ← the manifest
  src/index.tsx             ← your entry file
```

**`chronicle-plugin.json`**

```json
{
  "id": "example.wordcount",
  "name": "Word Count Goals",
  "description": "Tracks a daily word target.",
  "version": "1.0.0",
  "entry": "src/index.tsx",
  "minAppVersion": "0.1.0"
}
```

| Field | Notes |
|---|---|
| `id` | Unique; also the on-disk folder. `[a-z0-9._-]` |
| `entry` | Path to your entry file, relative to the repo root |
| `minAppVersion` | Chronicle refuses to load the plugin below this version |

**`src/index.tsx`**

```tsx
import { definePlugin, PLUGIN_API_VERSION } from '@chronicle/plugin-api';

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: 'example.wordcount',
  name: 'Word Count Goals',
  description: 'Tracks a daily word target.',
  defaultState: { target: 1000 },

  contributes: {
    slashCommands: [{
      name: 'goal',
      description: 'Show progress toward today’s target',
      run: (ctx) => {
        const words = ctx.editor?.getText().split(/\s+/).filter(Boolean).length ?? 0;
        const { target } = ctx.state.get() as { target: number };
        ctx.services.toast(`${words} / ${target} words`);
      },
    }],
  },
});
```

That's a complete plugin. Push it, paste the URL, enable it.

---

## What you can contribute

Declare any of these under `contributes`:

| Slot | What it does |
|---|---|
| `editorExtensions(ctx)` | Return TipTap extensions — merged into every editor. For checkers, input rules, marks. |
| `sidebarTabs[]` | A tab in the manuscript sidebar (`{ id, label, icon, render }`). |
| `views[]` | A **full-page** view that takes over the screen (`render` gets a `close()`). |
| `libraryActions[]` | An icon button on each book card in the Library. |
| `selectionActions[]` | An action on the text-selection bubble menu. |
| `slashCommands[]` | An editor command, typed as `#!/name`. |
| `checkers[]` | Publish findings (offsets + message) to the shared results bus. |
| `companion` | A free-floating overlay component (this is what Chibi uses). |
| `settingsPanel` | Your own section inside Global Settings. |

Plus lifecycle: `activate(ctx)` and `deactivate()`. Throwing in `activate`
disables your plugin cleanly and shows the error in Settings — it can't take the
app down.

## The context (`ctx`)

```ts
ctx.manuscriptId          // string | null
ctx.editor                // the live TipTap Editor, or null outside the editor
ctx.state.get() / .set()  // your persisted JSON state (global)
ctx.state.getForManuscript() / .setForManuscript()   // scoped to the open book

ctx.services.grammar.lint(text)      // LanguageTool → [{ start, end, kind, message, replacements }]
ctx.services.ai.available            // false when AI is off or AI_UI=off — always check
ctx.services.ai.respond(prompt, sys) // server-mediated; provider keys never reach you
ctx.services.settings.get/set(key)   // synced settings store (survives updates, follows devices)
ctx.services.toast(message)

// Checker results, shared between plugins (see below)
ctx.services.findings.publish(source, findings)
ctx.services.findings.subscribe(cb)   // → unsubscribe fn
ctx.services.findings.snapshot()

// Building your own editor — see the warning below. Use this.
ctx.services.editor.createEditorOptions({ content, extensions, onUpdate })
ctx.services.editor.coreExtensions()   // raw escape hatch
```

### Talking to other plugins: the findings bus

Checkers publish; panels subscribe. Neither imports the other, so a panel works
with whatever checkers happen to be installed:

```ts
// in a checker plugin
ctx.services.findings.publish('tense', [{ start, end, kind: 'tense', message }]);

// in a panel plugin
useEffect(() => ctx.services.findings.subscribe(setAll), []);
```

This is exactly how the Issues Panel lists Grammar Check's and Tense Check's
results without depending on either.

## Imports you may use

**Shared with the app** (you get the *same* React and TipTap instance the editor
uses — you must import these rather than bundle your own, or hooks will crash):

`react`, `react/jsx-runtime`, `react-dom`, `@tiptap/core`, `@tiptap/react`,
`@tiptap/react/menus`, `@tiptap/pm/{state,view,model}`, `motion/react`,
`lucide-react`, `@chronicle/plugin-api`

**Everything else Chronicle already ships** (`clsx`, `tailwind-merge`,
`compromise`, `jszip`, …) resolves too, and is **bundled into your plugin** — the
app's dependencies act as your standard library. Your repo needs no
`package.json`, no lockfile, no `node_modules`.

> If you import something Chronicle doesn't have, the build fails with a clear
> message naming it. Vendor the code into your repo instead.

## ⚠️ Building your own editor — read this or you will delete people's work

If your plugin needs its **own** TipTap editor (a full-page review view, say),
there is exactly one safe way to build it:

```tsx
const editor = useEditor(ctx.services.editor.createEditorOptions({
  content: chapter.content,
  extensions: [MyChecker],          // yours are appended to the core set
  onUpdate: (html) => save(html),
}));
```

**Never do this:**

```tsx
const editor = useEditor({ extensions: [StarterKit, MyChecker] });  // ☠️
```

Why it's fatal: chapter content is stored as **HTML**, and TipTap parses it
against the schema *your extensions define* — **silently discarding any markup it
has no parse rule for.** A bare-StarterKit schema doesn't know Chronicle's marks,
so simply *loading* a chapter throws away:

| Lost | What that is |
|---|---|
| `span[data-comment]` | every inline comment in the chapter |
| `span[data-audio-token]` | every `#!/ai_listen` play widget |
| `blockquote[data-type="epigraph"]` | the epigraph attribute — it degrades to a plain quote |

Then your first `getHTML()` save writes the gutted version back over the
original. **No error, no warning.** It round-trips plain prose perfectly, so it
sails through testing and only destroys the chapters an author has actually
annotated.

`createEditorOptions` makes this impossible to get wrong, and means you
automatically inherit any mark Chronicle adds in future — a copied extension list
would rot silently the day core gains one.

(Guarded by `scripts/schemaRoundTrip.test.ts`, which asserts the core schema is
lossless *and* that a bare-StarterKit schema really does destroy those marks.)

## Styling

Chronicle uses Tailwind. Utility classes in your JSX work, because the app's
stylesheet is already loaded. For anything custom, ship a `<style>` block (Chibi
does this for its sprite animations).

---

## Publishing your plugin

Push the repo (the root must contain `chronicle-plugin.json`), then install it by
URL like any other. Nothing else to do — no registry, no packaging, no release
step. Cut a tag if you want users to be able to pin to it.

## Bundled (seed) plugins

The **Chibi Assistant** ships inside the image (`plugins-seed/`) and is copied
into `/data/plugins` on first boot, so a fresh or air-gapped install has it with
no network. It's an ordinary plugin — disable or uninstall it like any other.
