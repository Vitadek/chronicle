import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'api.dart';
import 'collab_relay.dart';
import 'flags.dart';
import 'models.dart';
import 'store.dart';

/// The editing surface: the slim TipTap canvas in a WebView (served locally by
/// localhostServer in main.dart) plus a native formatting toolbar that drives
/// it over the `window.chronicleEditor` bridge. Content is pushed in on
/// `onReady`; on save we pull the freshest HTML back and PUT the manuscript.
class EditorScreen extends StatefulWidget {
  final ChronicleApi api;
  final Manuscript manuscript;
  final int chapterIndex;
  const EditorScreen({
    super.key,
    required this.api,
    required this.manuscript,
    required this.chapterIndex,
  });

  @override
  State<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends State<EditorScreen> {
  InAppWebViewController? _controller;
  CollabRelay? _relay;
  bool _ready = false;
  bool _saving = false;
  bool _tenseCheck = false;
  bool _grammarCheck = false;

  Chapter get _chapter => widget.manuscript.chapters[widget.chapterIndex];
  String get _docName => '${widget.manuscript.id}:${_chapter.id}';
  String get _grammarWasmUrl =>
      '${widget.api.baseUrl}/assets/harper/harper_wasm_bg.wasm';

  @override
  void initState() {
    super.initState();
    Settings.tenseCheck().then((v) {
      if (mounted) setState(() => _tenseCheck = v);
    });
    Settings.grammarCheck().then((v) {
      if (mounted) setState(() => _grammarCheck = v);
    });
  }

  @override
  void dispose() {
    _relay?.dispose();
    super.dispose();
  }

  /// Push the current tense/grammar toggle state into the editor bundle. Harper
  /// fetches its WASM from the server (kept out of the APK), so we hand it the
  /// URL before enabling the grammar checker.
  Future<void> _applyChecks() async {
    await _controller?.evaluateJavascript(
      source:
          "window.chronicleEditor.setGrammarWasmUrl(${jsonEncode(_grammarWasmUrl)});",
    );
    await _controller?.evaluateJavascript(
      source: "window.chronicleEditor.setTenseCheck($_tenseCheck);",
    );
    await _controller?.evaluateJavascript(
      source: "window.chronicleEditor.setGrammarCheck($_grammarCheck);",
    );
  }

  Future<void> _pushContent() async {
    if (!mounted) return;
    final dark = Theme.of(context).brightness == Brightness.dark;
    await _controller?.evaluateJavascript(
      source: "window.chronicleEditor.setTheme(${dark ? "'dark'" : "'light'"});",
    );
    await _controller?.evaluateJavascript(
      source: "window.chronicleEditor.setContent(${jsonEncode(_chapter.content)});",
    );
    await _applyChecks();
    if (mounted) setState(() => _ready = true);
  }

  Future<void> _cmd(String name, [Map<String, dynamic>? payload]) async {
    HapticFeedback.lightImpact();
    final arg = payload == null ? '' : ', ${jsonEncode(payload)}';
    await _controller?.evaluateJavascript(
      source: "window.chronicleEditor.command(${jsonEncode(name)}$arg);",
    );
  }

  /// Pull the latest HTML straight from the editor and persist. Returns whether
  /// the save succeeded (used to gate back-navigation).
  Future<bool> _save() async {
    // In collab mode the Y.Doc auto-syncs and the server snapshots to /api,
    // so there is no separate HTML save to perform.
    if (kCollabEnabled) return true;
    if (_controller == null) return true;
    setState(() => _saving = true);
    try {
      final html = await _controller!
          .evaluateJavascript(source: "window.chronicleEditor.getContent();");
      if (html is String) {
        _chapter.content = html;
        _chapter.lastModified = DateTime.now().millisecondsSinceEpoch;
        await widget.api.update(widget.manuscript);
        HapticFeedback.mediumImpact();
      }
      return true;
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop) return;
        final ok = await _save();
        if (ok && context.mounted) Navigator.pop(context);
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(
            _chapter.title.isEmpty ? 'Untitled Chapter' : _chapter.title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          actions: [
            PopupMenuButton<String>(
              icon: const Icon(Icons.spellcheck),
              tooltip: 'Writing aids',
              itemBuilder: (context) => [
                CheckedPopupMenuItem(
                  value: 'tense',
                  checked: _tenseCheck,
                  child: const Text('Tense check'),
                ),
                CheckedPopupMenuItem(
                  value: 'grammar',
                  checked: _grammarCheck,
                  child: const Text('Grammar check'),
                ),
              ],
              onSelected: (v) async {
                if (v == 'tense') {
                  final next = !_tenseCheck;
                  setState(() => _tenseCheck = next);
                  await Settings.setTenseCheck(next);
                  await _controller?.evaluateJavascript(
                    source: "window.chronicleEditor.setTenseCheck($next);",
                  );
                } else if (v == 'grammar') {
                  final next = !_grammarCheck;
                  setState(() => _grammarCheck = next);
                  await Settings.setGrammarCheck(next);
                  // (Re)point Harper at the server WASM before enabling.
                  await _controller?.evaluateJavascript(
                    source:
                        "window.chronicleEditor.setGrammarWasmUrl(${jsonEncode(_grammarWasmUrl)});",
                  );
                  await _controller?.evaluateJavascript(
                    source: "window.chronicleEditor.setGrammarCheck($next);",
                  );
                }
              },
            ),
            if (_saving)
              const Padding(
                padding: EdgeInsets.all(16),
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            else
              IconButton(
                icon: const Icon(Icons.save_outlined),
                tooltip: 'Save',
                onPressed: () async {
                  final ok = await _save();
                  if (ok && mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Saved'),
                        duration: Duration(seconds: 1),
                      ),
                    );
                  }
                },
              ),
          ],
        ),
        body: Column(
          children: [
            Expanded(
              child: Stack(
                children: [
                  InAppWebView(
                    initialUrlRequest: URLRequest(
                      url: WebUri('http://localhost:8080/assets/editor/index.html'),
                    ),
                    initialSettings: InAppWebViewSettings(
                      transparentBackground: true,
                      supportZoom: false,
                    ),
                    onWebViewCreated: (controller) {
                      _controller = controller;
                      if (kCollabEnabled) {
                        _relay = CollabRelay(
                          controller: controller,
                          wsUrl: CollabRelay.wsUrlFromApiBase(widget.api.baseUrl),
                        );
                        _relay!.register();
                      }
                      controller.addJavaScriptHandler(
                        handlerName: 'onReady',
                        callback: (args) {
                          if (kCollabEnabled) {
                            final dark = Theme.of(context).brightness == Brightness.dark;
                            controller.evaluateJavascript(
                              source:
                                  "window.chronicleEditor.setTheme(${dark ? "'dark'" : "'light'"});",
                            );
                            controller.evaluateJavascript(
                              source:
                                  "window.chronicleEditor.startCollab(${jsonEncode(_docName)}, ${jsonEncode(widget.api.token)});",
                            );
                            _applyChecks();
                            if (mounted) setState(() => _ready = true);
                          } else {
                            _pushContent();
                          }
                          return null;
                        },
                      );
                      // onUpdate/onSelection are wired for M1 (live word count,
                      // toolbar active states); save pulls content directly.
                      controller.addJavaScriptHandler(
                        handlerName: 'onUpdate',
                        callback: (args) => null,
                      );
                      controller.addJavaScriptHandler(
                        handlerName: 'onSelection',
                        callback: (args) => null,
                      );
                    },
                  ),
                  if (!_ready) const Center(child: CircularProgressIndicator()),
                ],
              ),
            ),
            _Toolbar(onCommand: _cmd),
          ],
        ),
      ),
    );
  }
}

class _Toolbar extends StatelessWidget {
  final Future<void> Function(String, [Map<String, dynamic>?]) onCommand;
  const _Toolbar({required this.onCommand});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
        ),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              _btn(Icons.format_bold, 'Bold', () => onCommand('toggleBold')),
              _btn(Icons.format_italic, 'Italic', () => onCommand('toggleItalic')),
              _btn(Icons.format_underlined, 'Underline', () => onCommand('toggleUnderline')),
              _btn(Icons.title, 'Heading', () => onCommand('setHeading', {'level': 2})),
              _btn(Icons.horizontal_rule, 'Scene break', () => onCommand('insertSceneBreak')),
              _btn(Icons.format_quote, 'Epigraph', () => onCommand('setEpigraph')),
              _btn(Icons.undo, 'Undo', () => onCommand('undo')),
              _btn(Icons.redo, 'Redo', () => onCommand('redo')),
            ],
          ),
        ),
      ),
    );
  }

  Widget _btn(IconData icon, String tip, VoidCallback onTap) {
    return IconButton(
      icon: Icon(icon),
      tooltip: tip,
      onPressed: onTap,
      iconSize: 22,
      constraints: const BoxConstraints(minWidth: 52, minHeight: 52),
    );
  }
}
