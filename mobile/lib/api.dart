import 'dart:convert';
import 'package:http/http.dart' as http;
import 'models.dart';

class ApiException implements Exception {
  final String message;
  ApiException(this.message);
  @override
  String toString() => message;
}

/// Thin client over Chronicle's bearer-authed REST API
/// (server/routes/manuscripts.ts, auth via AUTH_MODE=token).
class ChronicleApi {
  final String baseUrl;
  final String token;

  ChronicleApi(String baseUrl, this.token)
      : baseUrl = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');

  Map<String, String> get _headers => {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      };

  Uri _u(String path) => Uri.parse('$baseUrl$path');

  /// Probe used by the setup screen to validate URL + token together.
  Future<void> ping() async {
    final http.Response res;
    try {
      res = await http.get(_u('/api/manuscripts'), headers: _headers);
    } catch (e) {
      throw ApiException('Could not reach $baseUrl — check the URL and that the server is up.');
    }
    if (res.statusCode == 401) {
      throw ApiException('Unauthorized — the token was rejected.');
    }
    if (res.statusCode >= 400) {
      throw ApiException('Server returned ${res.statusCode}.');
    }
  }

  /// Public auth mode of the server (no token needed). Lets setup choose between
  /// a static-token field and the OIDC sign-in flow. Returns none/token/forward/oidc.
  Future<String> authMode() async {
    final http.Response res;
    try {
      res = await http.get(_u('/api/auth/config'));
    } catch (e) {
      throw ApiException('Could not reach $baseUrl — check the URL and that the server is up.');
    }
    if (res.statusCode != 200) return 'none';
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return (j['mode'] ?? 'none') as String;
  }

  Future<List<ManuscriptMeta>> list() async {
    final res = await http.get(_u('/api/manuscripts'), headers: _headers);
    if (res.statusCode != 200) {
      throw ApiException('Failed to load library (${res.statusCode}).');
    }
    final data = jsonDecode(res.body) as List;
    return data
        .map((m) => ManuscriptMeta.fromJson(Map<String, dynamic>.from(m as Map)))
        .toList();
  }

  Future<Manuscript> get(String id) async {
    final res = await http.get(_u('/api/manuscripts/$id'), headers: _headers);
    if (res.statusCode != 200) {
      throw ApiException('Failed to open manuscript (${res.statusCode}).');
    }
    return Manuscript.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  Future<void> update(Manuscript m) async {
    final res = await http.put(
      _u('/api/manuscripts/${m.id}'),
      headers: _headers,
      body: jsonEncode(m.toJson()),
    );
    if (res.statusCode != 200) {
      throw ApiException('Failed to save (${res.statusCode}).');
    }
  }
}
