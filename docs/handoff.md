# Android Control MCP Handoff

## Current State

This repo contains a local Android UI automation MCP server with a persistent Android-side UIAutomator bridge.

The desktop MCP server is implemented in TypeScript, runs over stdio, and exposes MCP `tools/list` and `tools/call`. It delegates most UI operations to an Android process started with `uiautomator runtest` and reached through:

```sh
adb forward tcp:27183 localabstract:android-ui-mcp
```

The Android bridge is implemented in Kotlin in `android-server/src/com/example/androiduiserver/BridgeTest.kt`.

Headless virtual-display phases 0–5 are implemented. On Android 14+, the bridge can
own one focusable/touch-capable virtual display, launch an app onto it, capture its
ImageReader surface, filter accessibility windows by display, inject display-tagged
touch/key events, and cleanly invalidate session-bound snapshots on destroy,
replacement, or bridge restart.

## Exposed MCP Tools

Bridge-backed tools:

- `android_capabilities`
- `android_trace_start`
- `android_trace_stop`
- `android_trace_status`
- `android_bridge_ping`
- `android_bridge_exit`
- `android_current_app`
- `android_wait_for_package`
- `android_wait_for_text`
- `android_wait_for_ref_gone`
- `android_wait_for_screen_change`
- `android_dump_tree`
- `android_dump_compact`
- `android_tap`
- `android_tap_ref`
- `android_fill_ref`
- `android_tap_text`
- `android_tap_content_desc`
- `android_click`
- `android_fill_near_label`
- `android_swipe`
- `android_input_text`
- `android_perform_action`
- `android_long_press`
- `android_key`
- `android_go_home`
- `android_open_notifications`
- `android_open_quick_settings`
- `android_close_keyboard`
- `android_grant_permission_dialog`
- `android_open_recents`
- `android_switch_recent_app`
- `android_list_apps`
- `android_launch_app`

ADB-backed tools:

- `android_screenshot`
- `android_ocr_screen`

Hybrid tools:

- `android_get_semantic_screen`
- `android_get_ui_outline`
- `android_viewer_start`, `android_viewer_status`, `android_viewer_stop`

`android_get_semantic_screen` uses both screenshot capture and the bridge-backed compact tree. It can run OCR automatically when the accessibility tree is sparse.

`android_get_ui_outline` reuses that semantic pipeline and snapshot cache, but defaults
to a compact zoned text response with actionable refs and no screenshot. Pass
`includeEntries: true` only when structured outline entries are needed.
It is the preferred default observation path; use `android_get_semantic_screen` only
when the outline is insufficient or richer node metadata is genuinely needed.

The Viewer companion runs inside the MCP process and therefore shares its bridge,
queue, snapshot cache, and safe ref actions. It is loopback-only, bearer-token
protected, read-only by default, and exposes OCR/vision nodes for inspection without
making them action targets.

Overlapping Viewer elements are selected through coordinate hit-testing with a ranked
layer chooser. Repeated clicks and the `[`/`]` keys cycle the stack, so large root or
scrollable bounds no longer automatically capture selection.

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
- The desktop server allocates a host forward port per selected device and starts the Android bridge on demand.
- Screenshots use `adb exec-out screencap -p`.
- OCR supports local Tesseract TSV output and Apple Vision through `desktop-mcp/apple-vision-ocr.swift`.
- Apple Vision is the default OCR backend and is macOS-only. Tesseract remains available with `ocrEngine: "tesseract"`.
- Compact accessibility nodes are collected directly from `AccessibilityNodeInfo`.
- XML hierarchy dumps are still available for debugging and compatibility.
- Text input prefers accessibility `ACTION_SET_TEXT` through the bridge.
- App listing uses launcher activities from Android package manager output.
- App launching uses `monkey -p <applicationId> -c android.intent.category.LAUNCHER 1` from inside the bridge process.
- Device-backed tools accept optional `deviceId`; `ANDROID_SERIAL` is only the default when `deviceId` is omitted.

Screenshot file policy:

- Default screenshots overwrite:

```text
/tmp/android-ui-mcp/<deviceId>/current-screen.png
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
- Direct MCP `tools/list` from `desktop-mcp/src/server.ts` exposes the semantic ref, locator, wait, and recovery tools.
- `android_bridge_ping` and `android_current_app` were verified through direct MCP JSON-RPC calls against the desktop MCP server.

Latest Codex App MCP checks on 2026-05-30:

- `android_bridge_ping` returned `ok: true` / `pong`.
- `android_current_app` returned `com.android.vending`.
- `android_get_semantic_screen` on Play Store returned `snapshotId`, `screenSignature`, `actionableSignature`, accessibility refs, role/editable/score metadata, and `ocrUsed: false` when the accessibility tree was usable.
- `android_tap_ref` on an accessibility ref succeeded with `status: "relocated"`, `actionStrategy: "coordinate_tap"`, a returned `currentSnapshot`, and `stability: "strict"`.
- `android_wait_for_text` found visible text in the Play Store ad sheet.
- `android_tap_content_desc` closed the Play Store ad sheet via `contentDesc: "Close sheet"` and returned a stable snapshot.
- `android_tap_text` tapped the Play Store bottom-nav `Search` text and navigated to the search surface.
- `android_fill_ref` filled the Play Store search `EditText` via `accessibility_set_text`.
- `android_fill_near_label` found the `Navigate up` label and filled the nearby search `EditText`.
- `android_wait_for_package` found `com.android.vending`.
- `android_click` matched and tapped the search `EditText` by `className: "android.widget.EditText"` and `role: "textbox"`.
- `android_wait_for_screen_change` correctly timed out when no UI change occurred.
- Forced Apple Vision OCR returned OCR refs such as `o1`, and `android_tap_ref` rejected `o1` with `status: "unsupported_ref_source"`.
- Follow-up compile checks passed: `./gradlew :android-server:buildUiautomatorJar` and `npm run build` in `desktop-mcp`.

Observed during the same run:

- Direct `adb devices` from the Codex shell failed under sandboxing because the ADB daemon could not bind the smart socket (`Operation not permitted`), while the MCP bridge tools were already usable.
- A attempted positive `android_wait_for_screen_change` check using an older `snapshotId` did not report the expected immediate change; it appeared to resolve the baseline to the current signature and timed out. Re-test this path before treating old snapshot change detection as verified.

Additional `android_wait_for_screen_change` checks:

- Google App Discover produced immediate `screen_changed` results even without an intentional action because the feed accessibility tree changed by itself. Treat dynamic feeds as noisy for negative wait tests.
- On Google App Discover, a ref action against an older search-box snapshot returned `stale_ref_not_found` after the feed signature changed.
- On the stable Play Store search input state, setting the text through `android_input_text` changed the signature from `8109ed5aa33d128a` to `d432e71961570d90`.
- After that text change, both `android_wait_for_screen_change` with `screenSignature: "8109ed5aa33d128a"` and with `snapshotId: "screen:1780148599332:8109ed5aa3"` returned `success: true`, `status: "screen_changed"`.
- On the same stable Play Store input state with no follow-up action, both `screenSignature` and `snapshotId` baselines timed out with `status: "screen_change_timeout"` and the unchanged signature `d432e71961570d90`.
- On the current Global Relay page (`com.globalrelay.message`), the contact list initially changed from `60be029be80d0850` to `657229051769e7cc` during page settling. A no-action wait against `657229051769e7cc` timed out correctly. Opening the Find criteria bottom sheet changed the page to a smaller bottom-sheet tree, and a follow-up wait against the old signature returned `screen_changed`.

Previously verified behavior:

- Gmail launches by `applicationId`.
- Gmail screenshots work at device resolution.
- Gmail exposes useful accessibility nodes such as search and compose.
- `android_key HOME` works.
- `android_list_apps` can find launcher apps.
- `android_launch_app` works by deterministic `applicationId` and by unique app-name match.
- Xiaohongshu (`com.xingin.xhs`) exposes a useful accessibility tree.
- WeChat (`com.tencent.mm`) can launch, but often exposes a sparse accessibility tree.

Latest hardening checks on 2026-07-12:

- `npm test` passes semantic ranking/deduplication, stale-ref ambiguity, display identity, after-condition validation, capability grouping, and trace lifecycle tests.
- `npm run test:fake-bridge` passes local-socket request/response and bridge-error normalization tests.
- `npm run test:headless` passes API 37 default/virtual display, OCR cache miss/hit, post-action waits, ref-gone, trace, capability filtering, all system workflow helpers, a real Camera runtime-permission dialog grant, and Camera weak-accessibility OCR/vision fallback.
- `./gradlew :android-server:buildUiautomatorJar` and `npm run build` pass.

Latest default-display multi-window checks on 2026-07-20:

- Compact snapshots now keep the active window and merge only secondary windows whose
  accessibility parent chain reaches it; unrelated top-level split-screen/System UI
  windows remain excluded.
- A Pixel API 37 Emulator test used a deterministic `focusable=false` PopupWindow.
  The baseline activity returned 8 nodes; with the popup visible it returned the same
  8 activity nodes plus `Secondary popup` as node 9, confirming the parent-chain merge.
- Modal Launcher and Clock menus correctly became the active root and returned only
  their actionable menu contents instead of the obscured activity behind them.
- `testWindowHierarchy` covers active, direct/transitive child, unrelated top-level,
  cyclic parent, and maximum-parent-depth behavior on the host JVM.

## New Session Test Plan

Use this section when opening a fresh Codex App session after MCP tool discovery reloads.

Before testing:

- Confirm the Android device is connected and authorized with `adb devices`.
- Start the Android bridge if it is not already running:

```sh
android-server/scripts/start-uiautomator-server.sh --build
```

- In the new Codex session, confirm the `android-ui-mcp` tools are available. The important newly added tools are:

```text
android_current_app
android_wait_for_package
android_wait_for_text
android_wait_for_screen_change
android_get_semantic_screen
android_tap_ref
android_fill_ref
android_tap_text
android_tap_content_desc
android_click
android_fill_near_label
```

### 1. Bridge Health

Call `android_bridge_ping`.

Expected:

- `ok: true`
- `pong: "pong"`

### 2. Current App

Call `android_current_app`.

Expected:

- `ok: true`
- `packageName` is the current foreground Android package.

### 3. Semantic Snapshot

Call `android_get_semantic_screen` with:

```json
{
  "ocrMode": "auto",
  "includeScreenshot": false,
  "maxNodes": 30
}
```

Expected:

- top-level `snapshotId`
- top-level `screenSignature`
- top-level `actionableSignature`
- node refs like `a1`, `a2`, and possibly `o1`
- accessibility nodes include best-effort `role`, `editable`, and `score`

Keep one `snapshotId` and one accessible `a*` ref for the next tests.

### 4. Tap By Ref

Call `android_tap_ref` with an accessibility ref from the snapshot:

```json
{
  "snapshotId": "<snapshotId>",
  "ref": "a1"
}
```

Expected on success:

- `success: true`
- `status: "fresh"` or `status: "relocated"`
- `actionStrategy: "coordinate_tap"`
- `currentSnapshot`
- `snapshotStable`
- `stability`: `strict`, `actionable`, or `timeout`

If an OCR ref such as `o1` exists, also call `android_tap_ref` with that OCR ref.

Expected:

- `success: false`
- `status: "unsupported_ref_source"`

### 5. Locator Taps

Use visible accessibility text from the current snapshot.

Call `android_tap_text`:

```json
{
  "text": "<visible text>",
  "fuzzy": false
}
```

Expected:

- if exactly one node matches, it taps and returns a stable `currentSnapshot`
- if multiple nodes match, it returns `text_ambiguous` with `candidates`
- if none match, it returns `text_not_found`

Call `android_tap_content_desc` when a node has a useful content description:

```json
{
  "contentDesc": "<content description>"
}
```

Call `android_click` for a more specific locator, preferably by `resourceId` when present:

```json
{
  "resourceId": "<resource id>",
  "role": "button"
}
```

### 6. Fill By Ref

Find an editable node in `android_get_semantic_screen` where either:

- `editable: true`
- `role: "textbox"`

Call `android_fill_ref`:

```json
{
  "snapshotId": "<snapshotId>",
  "ref": "<editable a-ref>",
  "text": "hello from mcp",
  "pressEnter": false
}
```

Expected:

- `success: true`
- `actionStrategy: "accessibility_set_text"`
- stable `currentSnapshot`

If no editable node appears, launch an app with a search box such as Gmail or Play Store and repeat the snapshot.

### 7. Fill Near Label

Use a screen with a visible label and a nearby editable field.

Call `android_fill_near_label`:

```json
{
  "label": "<visible label>",
  "text": "test value",
  "fuzzy": true
}
```

Expected:

- unique label and unique nearby editable field result in `success: true`
- ambiguous labels return `label_ambiguous`
- ambiguous nearby editable fields return `editable_ambiguous`

### 8. Wait Tools

Call `android_wait_for_text` for text already visible:

```json
{
  "text": "<visible text>",
  "fuzzy": true,
  "timeoutMs": 3000
}
```

Expected:

- `success: true`
- `status: "text_found"`
- `matches`
- latest `currentSnapshot`

Call `android_wait_for_package` using the package from `android_current_app`:

```json
{
  "packageName": "<current package>",
  "timeoutMs": 3000
}
```

Expected:

- `success: true`
- `status: "package_found"`

Call `android_wait_for_screen_change` with a snapshot from before an action:

```json
{
  "snapshotId": "<snapshotId>",
  "timeoutMs": 3000
}
```

Then trigger a UI change in parallel or use it after a manual action.

Expected:

- `success: true` and `status: "screen_changed"` if accessibility state changes
- otherwise `success: false` and `status: "screen_change_timeout"`

### 9. Stable Snapshot Behavior

For high-level action tools, verify the returned stability fields:

```text
snapshotStable
stability
snapshotWaitElapsedMs
```

Expected:

- normal screens often return `stability: "strict"`
- animated pages may return `stability: "actionable"`
- continuously changing accessibility trees may return `stability: "timeout"` but still include the latest `currentSnapshot`

To bypass stability waiting for a tool call:

```json
{
  "returnSnapshot": true,
  "waitForStable": false
}
```

## Known Limitations

- Display 0 screenshots use direct ADB; MCP-owned virtual displays use bridge-side ImageReader capture.
- Headless virtual displays require Android 14+; only one MCP-owned display per device is supported in the first implementation.
- Multi-device selection is per call through optional `deviceId`; `ANDROID_SERIAL` remains a default when `deviceId` is omitted.
- App-name matching is best effort. `applicationId` launch is deterministic.
- `uiautomator` exposes the accessibility tree, not the full rendered view tree.
- WebView, OpenGL, game, video, and some Compose screens may expose little or no useful accessibility data.
- `FLAG_SECURE` windows can block screenshots.
- OCR is text-focused; Apple Vision icon/button detection supplies a separate visual fallback, while large CV models remain intentionally out of scope.
- Apple Vision quality is much better for Chinese UI text than Tesseract in early tests, but it requires macOS and system language support.
- OCR uses a bounded in-memory content/parameter LRU cache; cache state is process-local.
- Trace artifacts are local files under the OS temporary directory's `android-ui-mcp/traces` folder by default and are not automatically uploaded or pruned.
- Capability groups are configured with `ANDROID_MCP_CAPABILITIES`; changing them requires restarting the MCP server.
- Runtime-permission button wording varies by Android/OEM; `android_grant_permission_dialog` returns `permission_dialog_not_found` rather than guessing when no supported label is unique.
- Large CV/object-detection stacks such as YOLO or PaddleOCR remain out of scope; the built-in visual fallback uses Apple Vision.

## Optional Compatibility Follow-ups

- Continue sampling OCR/vision behavior on additional third-party apps and OEM ROMs; Camera and WeChat-specific sparse-app routing are already covered.
- Tune OCR region/merge heuristics only from observed device-specific failures.
- Extend the compatibility matrix as more Android 14+ physical devices become available.

Completed hardening includes `android_list_devices`, managed bridge health diagnostics,
input/selector/semantic contract tests, local-socket fake-bridge tests, trace tests, and
an API 37 end-to-end test covering default and virtual displays.
