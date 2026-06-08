import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'api.dart';
import 'flags.dart';
import 'library_screen.dart';
import 'setup_screen.dart';
import 'store.dart';

/// Serves the slim TipTap editor bundle (assets/editor/) over
/// http://localhost:8080 so the WebView loads it with relative asset URLs,
/// offline and without auth. Started once at boot.
final InAppLocalhostServer localhostServer = InAppLocalhostServer();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Testbed: trust self-signed certs for HTTP + WebSocket (see flags.dart).
  // package:http (IOClient) and dart:io WebSocket both use HttpClient, so this
  // global override covers the API calls and the collab socket.
  if (kAllowInsecureTls) HttpOverrides.global = _InsecureHttpOverrides();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  await localhostServer.start();
  runApp(const ChronicleApp());
}

class ChronicleApp extends StatelessWidget {
  const ChronicleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Chronicle',
      debugShowCheckedModeBanner: false,
      theme: _buildTheme(Brightness.light),
      darkTheme: _buildTheme(Brightness.dark),
      home: const RootGate(),
    );
  }
}

ThemeData _buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final bg = isDark ? const Color(0xFF232220) : const Color(0xFFF4F1EA);
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: bg,
    colorScheme: ColorScheme.fromSeed(
      seedColor: const Color(0xFFC78A3F),
      brightness: brightness,
    ).copyWith(surface: bg),
    appBarTheme: AppBarTheme(
      backgroundColor: bg,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: true,
    ),
  );
}

/// Routes to setup (no creds yet) or the library (creds present).
class RootGate extends StatefulWidget {
  const RootGate({super.key});

  @override
  State<RootGate> createState() => _RootGateState();
}

class _RootGateState extends State<RootGate> {
  late Future<ServerCreds?> _future;

  @override
  void initState() {
    super.initState();
    _future = Settings.load();
  }

  void _reload() => setState(() => _future = Settings.load());

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<ServerCreds?>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        final creds = snap.data;
        if (creds == null) {
          return SetupScreen(onConnected: _reload);
        }
        return LibraryScreen(
          api: ChronicleApi(creds.url, creds.token),
          onSignOut: () async {
            await Settings.clear();
            _reload();
          },
        );
      },
    );
  }
}

/// Accepts self-signed certs (testbed only; gated by kAllowInsecureTls).
class _InsecureHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (cert, host, port) => true;
  }
}
