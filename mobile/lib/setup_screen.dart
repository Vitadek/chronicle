import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'oidc_login.dart';
import 'store.dart';

/// First-run screen: enter the server URL + token, validate them together with
/// a probe request, then persist and hand off to the library.
class SetupScreen extends StatefulWidget {
  final VoidCallback onConnected;
  const SetupScreen({super.key, required this.onConnected});

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _url = TextEditingController(text: 'https://');
  final _token = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // Detect the server's auth mode and take the right path.
      final mode = await ChronicleApi(_url.text, '').authMode();
      var token = _token.text;
      if (mode == 'oidc') {
        if (!mounted) return;
        final captured = await Navigator.of(context).push<String>(
          MaterialPageRoute(builder: (_) => OidcLoginScreen(serverUrl: _url.text)),
        );
        if (captured == null || captured.isEmpty) {
          setState(() => _error = 'Sign-in was cancelled.');
          return;
        }
        token = captured;
      }
      final api = ChronicleApi(_url.text, token);
      await api.ping();
      await Settings.save(_url.text, token);
      HapticFeedback.mediumImpact();
      widget.onConnected();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'Something went wrong: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Chronicle',
                  textAlign: TextAlign.center,
                  style: Theme.of(context)
                      .textTheme
                      .headlineMedium
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 8),
                Text(
                  'Connect to your server',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: muted),
                ),
                const SizedBox(height: 32),
                TextField(
                  controller: _url,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: const InputDecoration(
                    labelText: 'Server URL',
                    hintText: 'https://chronicle.example.com',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _token,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  onSubmitted: (_) => _busy ? null : _connect(),
                  decoration: const InputDecoration(
                    labelText: 'Access token',
                    hintText: 'AUTH_TOKEN from the server',
                    border: OutlineInputBorder(),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    _error!,
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _busy ? null : _connect,
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                  ),
                  child: _busy
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Connect'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
