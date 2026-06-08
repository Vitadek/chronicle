import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Server URL + bearer token, the only persisted state for M0. Stored in the
/// platform keystore via flutter_secure_storage.
class ServerCreds {
  final String url;
  final String token;
  const ServerCreds(this.url, this.token);
}

class Settings {
  static const _storage = FlutterSecureStorage();
  static const _kUrl = 'server_url';
  static const _kToken = 'token';

  static Future<ServerCreds?> load() async {
    final url = await _storage.read(key: _kUrl);
    if (url == null || url.isEmpty) return null;
    final token = await _storage.read(key: _kToken) ?? '';
    return ServerCreds(url, token);
  }

  static Future<void> save(String url, String token) async {
    await _storage.write(key: _kUrl, value: url.trim());
    await _storage.write(key: _kToken, value: token.trim());
  }

  static Future<void> clear() async {
    await _storage.delete(key: _kUrl);
    await _storage.delete(key: _kToken);
  }

  // ---- Writing-aid toggles (parity with the web client's settings) ----
  static const _kTenseCheck = 'tense_check';
  static const _kGrammarCheck = 'grammar_check';

  static Future<bool> tenseCheck() async =>
      (await _storage.read(key: _kTenseCheck)) == 'true';
  static Future<void> setTenseCheck(bool on) async =>
      _storage.write(key: _kTenseCheck, value: on.toString());

  static Future<bool> grammarCheck() async =>
      (await _storage.read(key: _kGrammarCheck)) == 'true';
  static Future<void> setGrammarCheck(bool on) async =>
      _storage.write(key: _kGrammarCheck, value: on.toString());
}
