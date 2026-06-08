/// Testbed build flags. Flip + rebuild the APK to test, then turn OFF for any
/// real or distributed build.

/// Real-time collaboration (Phase 10): the editor binds to a server-synced
/// Y.Doc over the bridge-relayed Hocuspocus provider instead of HTML save.
const bool kCollabEnabled = false;

/// Trust self-signed TLS certs across the app (login WebView + HTTP + collab
/// WebSocket). For the local self-signed Authelia/OIDC testbed ONLY — never
/// ship this enabled.
const bool kAllowInsecureTls = true;
