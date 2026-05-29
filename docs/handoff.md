# Android Control MCP Handoff

## Current State

This repo contains a local Android UI automation MCP server with a persistent Android-side UIAutomator bridge.

The desktop MCP server is implemented in TypeScript, runs over stdio, and exposes MCP `tools/list` and `tools/call`. It delegates most UI operations to an Android process started with `uiautomator runtest` and reached through:

```sh
adb forward tcp:27183 localabstract:android-ui-mcp
```

The Android bridge is implemented in Kotlin in `android-server/src/com/example/androiduiserver/BridgeTest.kt`.

## Exposed MCP Tools

Bridge-backed tools:

- `android_bridge_ping`
- `android_bridge_exit`
- `android_dump_tree`
- `android_dump_compact`
- `android_tap`
- `android_swipe`
- `android_input_text`
- `android_perform_action`
- `android_long_press`
- `android_key`
- `android_list_apps`
- `android_launch_app`

ADB-backed tools:

- `android_screenshot`

## Core Implementation

Main desktop implementation:

```text
desktop-mcp/src/server.ts
```

Main Android bridge implementation:

```text
android-server/src/com/example/androiduiserver/BridgeTest.kt
```

Important behavior:

- MCP transport is stdio with direct JSON-RPC handling.
- The desktop server refreshes `adb forward` before bridge calls.
- Screenshots use `adb exec-out screencap -p`.
- Compact accessibility nodes are collected directly from `AccessibilityNodeInfo`.
- XML hierarchy dumps are still available for debugging and compatibility.
- Text input prefers accessibility `ACTION_SET_TEXT` through the bridge.
- App listing uses launcher activities from Android package manager output.
- App launching uses `monkey -p <applicationId> -c android.intent.category.LAUNCHER 1` from inside the bridge process.
- `ANDROID_SERIAL` selects a target device when multiple devices are connected.

Screenshot file policy:

- Default screenshots overwrite:

```text
/tmp/android-ui-mcp/current-screen.png
```

- `retain: true` creates a unique temp directory and preserves that screenshot.

## Local Workflow

Build the Android bridge:

```sh
android-server/scripts/build-uiautomator-jar.sh
```

Start the Android bridge:

```sh
android-server/scripts/start-uiautomator-server.sh
```

Start the desktop MCP server:

```sh
cd desktop-mcp
npm run start
```

For MCP clients, prefer the silent launcher:

```sh
scripts/start-desktop-mcp.sh
```

## Verified Locally

Recent local checks:

- `./gradlew :android-server:buildUiautomatorJar` passes.
- `npm run build` in `desktop-mcp` passes.

Previously verified behavior:

- Gmail launches by `applicationId`.
- Gmail screenshots work at device resolution.
- Gmail exposes useful accessibility nodes such as search and compose.
- `android_key HOME` works.
- `android_list_apps` can find launcher apps.
- `android_launch_app` works by deterministic `applicationId` and by unique app-name match.
- Xiaohongshu (`com.xingin.xhs`) exposes a useful accessibility tree.
- WeChat (`com.tencent.mm`) can launch, but often exposes a sparse accessibility tree.

## Known Limitations

- `android_screenshot` still uses direct ADB because screenshot capture is not implemented in the Android bridge.
- Multi-device selection is process-level through `ANDROID_SERIAL`; tools do not accept a per-call serial.
- App-name matching is best effort. `applicationId` launch is deterministic.
- `uiautomator` exposes the accessibility tree, not the full rendered view tree.
- WebView, OpenGL, game, video, and some Compose screens may expose little or no useful accessibility data.
- `FLAG_SECURE` windows can block screenshots.
- OCR/CV fallback is planned but not implemented.
- Automated tests are still minimal.

## Recommended Next Work

Highest priority:

- Implement OCR/CV fallback from `docs/ocr-cv-fallback-plan.md`.
- Add `android_get_semantic_screen` as the default screen-understanding tool.
- Add `android_ocr_screen` as a debugging and fallback tool.

Hardening:

- Add `android_devices` and `android_current_app`.
- Add bridge health diagnostics and clearer startup failure messages.
- Add structured tests for MCP request handling, input validation, bridge error normalization, and selector behavior.
- Update compatibility notes as more devices and Android versions are tested.
