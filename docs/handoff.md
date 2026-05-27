# Android Control MCP Handoff

## Current State

This repo contains a Phase 1 Android UI MCP bridge. It is a local stdio MCP server implemented in TypeScript and run directly by Node 24, with no npm dependencies.

The server shells out to `adb` for Android automation and currently exposes:

- `android_screenshot`
- `android_dump_tree`
- `android_tap`
- `android_swipe`
- `android_input_text`
- `android_key`
- `android_list_apps`
- `android_launch_app`

The project has been initialized as a git repo and pushed to a private GitHub repository:

```text
https://github.com/imallan/android-control-mcp
```

## Core Implementation

The main implementation is in:

```text
desktop-mcp/src/server.ts
```

Important behavior:

- MCP transport is stdio with JSON-RPC handling for `initialize`, `tools/list`, and `tools/call`.
- Screenshots use `adb exec-out screencap -p`.
- Accessibility trees use `uiautomator dump /sdcard/window.xml` and `adb exec-out cat`.
- Input actions use `adb shell input`.
- App listing uses launcher activities from `cmd package query-activities`.
- App launching uses `monkey -p <applicationId> -c android.intent.category.LAUNCHER 1`.
- `ANDROID_SERIAL` is supported through the environment for multi-device setups.

Screenshot file policy:

- Default screenshots overwrite:

```text
/tmp/android-ui-mcp/current-screen.png
```

- `retain: true` creates a unique temp directory and preserves that screenshot.
- Tree XML is not saved locally; it is returned directly as MCP output.

## Local Installation

The MCP server has been installed into Codex global config:

```toml
[mcp_servers.android-ui-mcp]
command = "npm"
args = ["--prefix", "/Users/allan/Documents/Codex/misc/Android Control MCP/desktop-mcp", "run", "start"]

[mcp_servers.android-ui-mcp.env]
ANDROID_SERIAL = "R5GL14WS2XD"
```

Codex may need a restart/new session before the installed MCP appears as active tools.

## Verified Behavior

Verified locally against Android device serial:

```text
R5GL14WS2XD
```

Build check:

```sh
npm run build
```

passed.

MCP behavior verified:

- `tools/list` returns all 8 tools.
- Gmail can be launched by `applicationId`.
- Gmail screenshot works at `1440 x 3120`.
- Gmail accessibility tree exposes useful nodes such as search and compose.
- `android_key HOME` succeeds.
- `android_list_apps` can find Gmail.
- `android_launch_app` works by both `applicationId` and unique app name.
- Xiaohongshu (`com.xingin.xhs`) exposes a useful accessibility tree with feed cards, search, tabs, and bottom navigation.
- WeChat (`com.tencent.mm`) launches, but its accessibility tree is effectively empty except for the root window node.

## Known Limitations

- This is still Phase 1: every tool call shells out to `adb`, so latency is higher than a persistent Android-side server.
- There is no Android jar/server yet.
- Multi-device selection depends on `ANDROID_SERIAL`; without it, `adb` returns “more than one device/emulator”.
- App-name launch is best-effort:
  - `applicationId` launch is deterministic.
  - app name matching uses package/activity-derived aliases by default.
  - `resolveLabels: true` can parse APK labels through local `aapt`, but this is slower and localization-sensitive.
- `adb shell input text` has limited Unicode support.
- `uiautomator dump` exposes accessibility/semantics, not the actual render tree.
- WeChat and similar apps can expose almost no accessibility nodes.
- `FLAG_SECURE` apps may return black screenshots.
- There are no automated tests yet beyond manual MCP protocol checks and device verification.

## Not Done Yet

Highest priority next work:

- Implement OCR/CV fallback from `docs/ocr-cv-fallback-plan.md`.
  - Add `android_get_semantic_screen`.
  - Add `android_ocr_screen`.
  - Use local `tesseract` with `chi_sim+eng`.
  - Return compact OCR/merged nodes instead of full OCR text.
  - Trigger fallback automatically when tree is sparse, especially for WeChat.

Next architecture milestone:

- Implement Phase 2 persistent Android server:
  - Kotlin/JVM jar.
  - launched with `app_process` as shell uid.
  - `LocalServerSocket("android-ui-mcp")`.
  - desktop connects through `adb forward tcp:27183 localabstract:android-ui-mcp`.
  - newline-delimited JSON protocol.

Polish and hardening:

- Add a real MCP SDK implementation if the direct JSON-RPC server becomes insufficient.
- Add structured tests for JSON-RPC requests, input validation, and ADB error normalization.
- Add bounded output modes for tree dumps to reduce token usage.
- Improve app label resolution and cache APK label lookups.
- Add explicit support for selecting device serial per tool call, not only through env.
- Add health/check tools such as `android_devices` and `android_current_app`.

## Recommended Next Step

Build OCR fallback first, before the Android persistent server. WeChat has already shown the practical gap: the ADB/tree/action loop works, but some real apps need screenshot-derived semantic nodes to be useful.
