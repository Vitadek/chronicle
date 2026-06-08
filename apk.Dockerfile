# syntax=docker/dockerfile:1
#
# Reproducible Android APK build for the Chronicle mobile app — no host SDK.
# Build context is the repo root. Extract the APKs with:
#
#   docker build -f apk.Dockerfile --target export --output type=local,dest=build-apk .
#   # or: ./scripts/build-apk.sh
#
# Local builds and CI (.github/workflows/android.yml) use this same file, so
# "works on my machine" == "works in CI".

# --- Stage 1: build the slim TipTap editor bundle (Node) ---------------------
FROM node:24-bookworm-slim AS editor
WORKDIR /src
COPY package.json package-lock.json ./
# --ignore-scripts: the editor bundle only needs the frontend deps. It skips
# better-sqlite3's node-gyp native build (a server dep we never import here,
# which would otherwise need Python + build tools). esbuild's platform binary
# still arrives via optionalDependencies, so the Vite build is unaffected.
RUN npm ci --ignore-scripts
COPY vite.editor.config.ts ./
COPY editor-host ./editor-host
COPY src ./src
RUN npm run build:editor   # -> /src/mobile/assets/editor/

# --- Stage 2: build the Android APK (Flutter + Android SDK) -------------------
FROM ghcr.io/cirruslabs/flutter:stable AS build
WORKDIR /app
COPY mobile/ ./
# Overlay the freshly built editor bundle (don't trust a stale committed copy).
COPY --from=editor /src/mobile/assets/editor ./assets/editor
RUN flutter pub get
# Newer AGP (bundled in the Flutter stable image) hard-errors on plugins that
# still call getDefaultProguardFile('proguard-android.txt') — e.g.
# flutter_inappwebview_android 1.1.3. Repoint any offending plugin at the
# -optimize variant AGP now requires. (Cleaner long-term fix: bump the plugin.)
RUN find /root/.pub-cache -path '*/android/build.gradle' \
      -exec sed -i 's/proguard-android\.txt/proguard-android-optimize.txt/g' {} +
# M0 ships a debug-signed release APK (installable for sideload). Real release
# signing via a keystore is wired in a later pass.
RUN flutter build apk --release --split-per-abi

# --- Stage 3: export just the APKs -------------------------------------------
FROM scratch AS export
COPY --from=build /app/build/app/outputs/flutter-apk/*.apk /
