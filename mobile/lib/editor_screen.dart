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
  bool _aiBusy = false;
  bool _tenseCheck = false;
  bool _grammarCheck = false;

  Chapter get _chapter => widget.manuscript.chapters[widget.chapterIndex];
  String get _docName => '${widget.manuscript.id}:${_chapter.id}';

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

  /// Push the current tense/grammar toggle state into the editor bundle. Grammar
  /// runs server-side (LanguageTool proxy), so we hand the bundle the server base
  /// URL + auth token before enabling the grammar checker.
  Future<void> _applyChecks() async {
    await _controller?.evaluateJavascript(
      source:
          "window.chronicleEditor.setGrammarEndpoint(${jsonEncode(widget.api.baseUrl)}, ${jsonEncode(widget.api.token)});",
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

  /// On-demand AI grammar pass (the structural check rule engines can't do).
  /// Pulls the editor text, sends it to the server, and lists what comes back.
  Future<void> _runAiPass() async {
    if (_controller == null || _aiBusy) return;
    setState(() => _aiBusy = true);
    try {
      final html = await _controller!
          .evaluateJavascript(source: "window.chronicleEditor.getContent();");
      final text = (html is String)
          ? html
              .replaceAll(RegExp(r'<[^>]*>'), ' ')
              .replaceAll(RegExp(r'&[a-z]+;'), ' ')
              .replaceAll(RegExp(r'\s+'), ' ')
              .trim()
          : '';
      if (text.isEmpty) {
        _toast('Nothing to check yet.');
        return;
      }
      final issues = await widget.api.aiGrammarPass(text);
      if (mounted) _showAiResults(issues);
    } on ApiException catch (e) {
      if (mounted) _toast(e.message);
    } finally {
      if (mounted) setState(() => _aiBusy = false);
    }
  }

  void _toast(String m) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  void _showAiResults(List<Map<String, dynamic>> issues) {
    showModalBottomSheet(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.5,
        maxChildSize: 0.9,
        builder: (ctx, scroll) {
          if (issues.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Text('No grammar issues found.'),
              ),
            );
          }
          return ListView.separated(
            controller: scroll,
            itemCount: issues.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (ctx, i) {
              final it = issues[i];
              final sugg = it['suggestion'];
              return ListTile(
                leading: const Icon(Icons.auto_fix_high, color: Colors.purple),
                title: Text('“${it['quote'] ?? ''}”',
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text(
                  [it['message'], if (sugg != null) '→ $sugg']
                      .whereType<String>()
                      .join('  '),
                ),
              );
            },
          );
        },
      ),
    );
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
            _aiBusy
                ? const Padding(
                    padding: EdgeInsets.all(16),
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    icon: const Icon(Icons.auto_fix_high),
                    tooltip: 'AI grammar pass',
                    onPressed: _runAiPass,
                  ),
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
                  // (Re)point grammar at the server proxy before enabling.
                  await _controller?.evaluateJavascript(
                    source:
                        "window.chronicleEditor.setGrammarEndpoint(${jsonEncode(widget.api.baseUrl)}, ${jsonEncode(widget.api.token)});",
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
