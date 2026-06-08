import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'flags.dart';

/// In-app OIDC login. Opens the server's `/api/auth/oidc/start`, lets the user
/// authenticate with the IdP (Authelia/Authentik), and captures the session
/// token from the `/auth/complete#token=...` redirect — the same flow the web
/// client uses. Pops with the captured token (or null if cancelled).
class OidcLoginScreen extends StatefulWidget {
  final String serverUrl; // e.g. https://chronicle.example.com
  const OidcLoginScreen({super.key, required this.serverUrl});

  @override
  State<OidcLoginScreen> createState() => _OidcLoginScreenState();
}

class _OidcLoginScreenState extends State<OidcLoginScreen> {
  bool _done = false;

  String? _tokenFromUrl(String? url) {
    if (url == null || !url.contains('/auth/complete')) return null;
    final hashIdx = url.indexOf('#');
    if (hashIdx == -1) return null;
    for (final part in url.substring(hashIdx + 1).split('&')) {
      final kv = part.split('=');
      if (kv.length == 2 && kv[0] == 'token') return Uri.decodeComponent(kv[1]);
    }
    return null;
  }

  void _capture(String? url) {
    if (_done) return;
    final token = _tokenFromUrl(url);
    if (token != null && token.isNotEmpty) {
      _done = true;
      if (mounted) Navigator.of(context).pop(token);
    }
  }

  @override
  Widget build(BuildContext context) {
    final base = widget.serverUrl.trim().replaceAll(RegExp(r'/+$'), '');
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri('$base/api/auth/oidc/start')),
        // Accept the self-signed Authelia cert on the testbed (gated by flag).
        onReceivedServerTrustAuthRequest: kAllowInsecureTls
            ? (controller, challenge) async =>
                ServerTrustAuthResponse(action: ServerTrustAuthResponseAction.PROCEED)
            : null,
        onLoadStart: (controller, url) => _capture(url?.toString()),
        onUpdateVisitedHistory: (controller, url, isReload) => _capture(url?.toString()),
      ),
    );
  }
}
