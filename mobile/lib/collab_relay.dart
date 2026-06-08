import 'dart:convert';
import 'dart:io';

import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'flags.dart';

/// Relays the editor WebView's Hocuspocus WebSocket through native.
///
/// The JS side (`BridgeWebSocket` in editor-host/main.ts) emits
/// `collabOpen` / `collabSend` / `collabClose` over the Flutter bridge; this
/// class owns the real Dart WebSocket to the server's `/collab` endpoint and
/// pushes incoming frames back into JS via `window.__collab.*`. Native owns the
/// socket + auth (token in the URL); the Hocuspocus protocol stays in JS.
class CollabRelay {
  final InAppWebViewController controller;

  /// e.g. wss://chronicle.example.com/collab  (or ws://host:3000/collab)
  final String wsUrl;

  WebSocket? _socket;
  bool _disposed = false;

  CollabRelay({required this.controller, required this.wsUrl});

  /// Derive the collab WebSocket URL from the API base URL.
  static String wsUrlFromApiBase(String apiBase) {
    var u = apiBase.trim().replaceAll(RegExp(r'/+$'), '');
    if (u.startsWith('https://')) {
      u = 'wss://' + u.substring('https://'.length);
    } else if (u.startsWith('http://')) {
      u = 'ws://' + u.substring('http://'.length);
    }
    return u + '/collab';
  }

  /// Register the bridge handlers the JS shim talks to. Call this in
  /// onWebViewCreated, before the editor starts collab.
  void register() {
    controller.addJavaScriptHandler(
      handlerName: 'collabOpen',
      callback: (args) {
        _open();
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'collabSend',
      callback: (args) {
        if (args.isNotEmpty && args[0] is String) {
          _socket?.add(base64Decode(args[0] as String));
        }
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'collabSendText',
      callback: (args) {
        if (args.isNotEmpty && args[0] is String) _socket?.add(args[0] as String);
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'collabClose',
      callback: (args) {
        _socket?.close();
        return null;
      },
    );
  }

  Future<void> _open() async {
    try {
      HttpClient? custom;
      if (kAllowInsecureTls) {
        custom = HttpClient()..badCertificateCallback = (cert, host, port) => true;
      }
      final sock = await WebSocket.connect(wsUrl, customClient: custom);
      if (_disposed) {
        await sock.close();
        return;
      }
      _socket = sock;
      await _js('window.__collab.open()');
      sock.listen(
        (data) {
          if (data is List<int>) {
            _js("window.__collab.message('${base64Encode(data)}')");
          }
          // Hocuspocus frames are binary; text frames are ignored.
        },
        onDone: () => _js('window.__collab.close()'),
        onError: (_) => _js('window.__collab.close()'),
        cancelOnError: true,
      );
    } catch (_) {
      await _js('window.__collab.close()');
    }
  }

  Future<void> _js(String source) async {
    if (_disposed) return;
    try {
      await controller.evaluateJavascript(source: source);
    } catch (_) {/* webview gone */}
  }

  void dispose() {
    _disposed = true;
    _socket?.close();
    _socket = null;
  }
}
