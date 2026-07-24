# Android UI MCP Desktop Server

MCP server for Android UI automation. UIAutomator operations go through the persistent
on-device bridge, exposed over MCP stdio:

- `android_bridge_ping`: verify that the on-device bridge is reachable
- `android_bridge_exit`: stop the on-device bridge
- `android_list_devices`: list ADB devices and managed bridge state
- `android_capabilities`: report enabled tool capability groups
- `android_trace_start`, `android_trace_status`, `android_trace_stop`: local sanitized agent-debugging traces
- `android_record_video_start`, `android_record_video_status`, `android_record_video_stop`: record display 0 to a local MP4
- `android_create_virtual_display`, `android_list_displays`, `android_destroy_virtual_display`: manage one bridge-owned Android 14+ headless display per device
- `android_current_app`: return the current foreground Android package
- `android_wait_for_package`
- `android_wait_for_text`
- `android_wait_for_ref_gone`
- `android_wait_for_screen_change`
- `android_screenshot`: overwrites one stable temp file by default; pass `retain=true` to keep a unique screenshot
- `android_ocr_screen`: run local OCR on the current screenshot and return compact OCR nodes
- `android_get_semantic_screen`: return accessibility nodes with automatic or forced OCR fallback
- `android_get_ui_outline`: return a compact `[Top]`/`[Content]`/`[Bottom]` outline using the same snapshot refs
- `android_viewer_start`, `android_viewer_status`, `android_viewer_stop`: host a loopback-only visual companion inside the MCP process
- `android_dump_tree`: XML hierarchy from the on-device bridge
- `android_dump_compact`: compact node list from the on-device bridge
- `android_tap`
- `android_tap_ref`: tap an accessibility node from a semantic snapshot by `snapshotId` + `ref`
- `android_fill_ref`: fill an editable accessibility node from a semantic snapshot by `snapshotId` + `ref`
- `android_long_press_ref`: long press an accessibility node from a semantic snapshot by `snapshotId` + `ref`
- `android_perform_action_ref`: execute an accessibility action on a semantic snapshot node by `snapshotId` + `ref`
- `android_tap_text`
- `android_tap_content_desc`
- `android_click`
- `android_fill_near_label`
- `android_swipe`
- `android_input_text`
- `android_key`
- `android_go_home`
- `android_open_notifications`, `android_open_quick_settings`, `android_close_keyboard`
- `android_grant_permission_dialog`, `android_open_recents`, `android_switch_recent_app`
- `android_list_apps`: list launcher apps through the Android bridge
- `android_launch_app`: launch by `applicationId`, or by a unique `appName` match

Observation, wait, launch, coordinate, locator, and ref tools accept either
`sessionId` or `displayId`. Supplying both is rejected. A virtual display session
binds screenshot, accessibility, OCR/vision, snapshots, refs, and injected input to
the same display. Snapshot refs cannot be reused across displays.

## Display 0 Video Recording

Start one managed `screenrecord` process per device, inspect it without side effects,
then stop it to finalize and pull the MP4:

```json
{
  "name": "android_record_video_start",
  "arguments": {
    "deviceId": "emulator-5554",
    "size": "1280x720",
    "bitRate": 6000000,
    "timeLimitSec": 30,
    "outputPath": "/tmp/demo.mp4",
    "overwrite": false
  }
}
```

Call `android_record_video_status` to distinguish `recording` from
`completed_pending_pull`. Even after the time limit expires, call
`android_record_video_stop` to pull the finalized file and remove the generated
remote files. Stop sends SIGINT only while the saved PID still belongs to the exact
generated `screenrecord` path.

The first version supports display 0 only. It explicitly rejects `sessionId` and any
non-zero `displayId`; virtual-display recording is deferred. `size` uses
`WIDTHxHEIGHT`, `bitRate` is bits per second, and `timeLimitSec` defaults to and is
capped at 180 seconds. Official `screenrecord` has no audio, and rotating the display
during recording can crop the resulting video.

When `outputPath` is omitted, recordings are saved under
`<OS temp>/android-ui-mcp/recordings/<deviceId>/`. Existing files are rejected by
default. Pass `overwrite: true` at start to permit replacement. Pulling uses a local
staging file and atomic final commit; pull or remote-cleanup failures retain retryable
managed state.

## Local Viewer Companion

Start the Viewer through MCP so it shares this server's bridge, operation queue,
semantic snapshots, and ref cache:

```json
{
  "name": "android_viewer_start",
  "arguments": {
    "deviceId": "emulator-5554",
    "port": 0,
    "allowActions": false
  }
}
```

The result contains a URL such as `http://127.0.0.1:49152/#token=...`. Open it in a
local browser. The Viewer provides screenshot overlays, ref/role/source/bounds/window
details, Outline text, source filters, manual refresh, and optional one-second live
refresh. It binds only `127.0.0.1`, protects every API with a random bearer token,
and defaults to read-only mode.

Overlay selection uses coordinate hit-testing instead of SVG paint order. When several
nodes cover the same point, the Viewer prioritizes secondary windows, actionable
targets, accessibility source, deeper nodes, and smaller bounds. The detail panel lists
the complete overlap stack; click the same point again or use `[` and `]` to cycle
layers. Selecting one layer dims the remaining boxes.

When `allowActions` is true, an explicit Tap button is shown only for actionable
accessibility `aN` refs. The backend executes the existing safe
`snapshotId + ref` action path; OCR and vision refs remain observation-only. Use
`android_viewer_stop` when finished. The standalone Viewer CLI is intentionally not
part of this companion-only phase.

## Requirements

- Node.js 24+
- Android platform-tools with `adb` on `PATH`
- The Android bridge jar built at `../android-server/build/android-ui-server.jar`

## Usage

Build the Android bridge jar, then start the MCP server:

```sh
../android-server/scripts/build-uiautomator-jar.sh
npm run build
npm run start
```

The MCP server can start with no Android device connected. Bridge-backed tools discover devices on demand and automatically push, forward, and start the UIAutomator bridge for the selected device.

This MVP intentionally has no npm dependencies. It relies on Node 24's built-in TypeScript type stripping.

Optional environment variables:

- `ANDROID_SERIAL`: default target device serial when a tool omits `deviceId`
- `ANDROID_MCP_ADB_TIMEOUT_MS`: default ADB command timeout, default `15000`
- `ANDROID_MCP_SCREENSHOT_TIMEOUT_MS`: screenshot timeout, default `20000`
- `ANDROID_MCP_OCR_TIMEOUT_MS`: local OCR command timeout, default `90000`
- `ANDROID_MCP_APPLE_VISION_OCR_BIN`: optional prebuilt Apple Vision OCR helper path
- `ANDROID_UI_MCP_HOST`: bridge host, default `127.0.0.1`
- `ANDROID_UI_MCP_JAR`: UIAutomator bridge jar path, default `../android-server/build/android-ui-server.jar`
- `ANDROID_UI_MCP_PORT`: first bridge/adb-forward port, default `27183`
- `ANDROID_UI_MCP_PORT_BASE`: base port for additional device forwards, default `ANDROID_UI_MCP_PORT` or `27183`
- `ANDROID_UI_MCP_TIMEOUT_MS`: bridge request timeout, default `15000`
- `ANDROID_MCP_CAPABILITIES`: optional comma-separated tool groups (`core,ocr,apps,debug,trace,vision,media`); defaults to all
- `ANDROID_MCP_TRACE_DIR`: local trace root, default `<OS temp>/android-ui-mcp/traces`

## MCP Client Configuration

Use the repository launcher for Codex and other stdio MCP clients. It starts `node src/server.ts` without requiring a device to be connected. Avoid launching through plain `npm run start` for stdio clients unless it is run silently, because npm can print lifecycle text to stdout and MCP stdout must contain only JSON-RPC messages.

```json
{
  "mcpServers": {
    "android-ui-mcp": {
      "command": "/Users/allan/Documents/Codex/misc/Android Control MCP/scripts/start-desktop-mcp.sh",
      "args": []
    }
  }
}
```

If multiple Android devices are connected, call `android_list_devices` and pass `deviceId` to device-backed tools. You can set `ANDROID_SERIAL` as a default device:

```json
{
  "mcpServers": {
    "android-ui-mcp": {
      "command": "/Users/allan/Documents/Codex/misc/Android Control MCP/scripts/start-desktop-mcp.sh",
      "args": [],
      "env": {
        "ANDROID_SERIAL": "16011JEC202078"
      }
    }
  }
}
```

For Codex, install the server with:

```sh
codex mcp add android-ui-mcp \
  -- "/Users/allan/Documents/Codex/misc/Android Control MCP/scripts/start-desktop-mcp.sh"
```

Restart or reload Codex after installation so it discovers the tools.

## Transport Notes

- `android_current_app`, `android_wait_for_package`, `android_wait_for_text`, `android_wait_for_screen_change`, `android_dump_tree`, `android_dump_compact`, `android_tap`, `android_tap_ref`, `android_fill_ref`, `android_long_press_ref`, `android_perform_action_ref`, `android_tap_text`, `android_tap_content_desc`, `android_click`, `android_fill_near_label`, `android_swipe`, `android_input_text`, `android_perform_action`, `android_long_press`, `android_key`, `android_go_home`, `android_list_apps`, and `android_launch_app` require the persistent Android bridge.
- `android_get_semantic_screen` and `android_get_ui_outline` require the persistent Android bridge and capture a screenshot only when requested or needed for OCR/vision fallback.
- Bridge-backed tools start the on-device bridge automatically for the selected `deviceId`; if multiple authorized devices are connected and no default is set, pass `deviceId`.
- Coordinate, ref, and locator action tools default to returning a post-action snapshot after waiting up to 1500 ms for strict or actionable accessibility stability.
- `android_perform_action` and `android_perform_action_ref` accept predefined accessibility action names or custom action labels exposed by the target node.
- `android_screenshot` and `android_ocr_screen` use direct ADB capture for display 0 and bridge-owned ImageReader capture for virtual displays.
- `android_record_video_start`, `android_record_video_status`, and `android_record_video_stop` use the official device-side `screenrecord` command and do not require the persistent UIAutomator bridge.
- `android_ocr_screen` and OCR fallback in the semantic-screen/outline tools support `ocrEngine: "apple-vision"` and `ocrEngine: "tesseract"`.
- OCR results use a bounded content-and-parameter LRU and report `ocrCached`.
- Mutating tools accept `after.waitForText` and/or `after.waitForPackage` postconditions.
- The Apple Vision engine is the default OCR backend on this MCP.
- The Tesseract engine requires local `tesseract` on `PATH`.
- The Apple Vision engine requires macOS. The desktop server compiles `apple-vision-ocr.swift` with `swiftc` into `/tmp/android-ui-mcp/apple-vision-ocr` on first use unless `ANDROID_MCP_APPLE_VISION_OCR_BIN` is set.
- The MCP server allocates one host forward port per device and starts one UIAutomator bridge process per active device.

## Limitations

- `android_screenshot` writes `/tmp/android-ui-mcp/<deviceId>/current-screen.png` by default. Use `retain=true` only when you want historical screenshots.
- Managed video recording is limited to display 0, 180 seconds, and one active or pending recording per device in the current MCP process. It records no audio and does not support rotation during capture.
- Text input uses accessibility `ACTION_SET_TEXT` when possible, but depends on the target node exposing editable accessibility actions.
- App-name launch uses package/activity-derived aliases. `applicationId` launch is deterministic.
- `FLAG_SECURE` apps can return black screenshots.
- WebView, OpenGL, and game screens may expose little or no accessibility tree.
- Apple Vision is macOS-only and its supported OCR languages depend on the installed system.
- Headless sessions require Android 14+ and hidden Android APIs that an OEM may restrict.
- The first implementation owns one virtual display per device; creating another invalidates the previous session with `virtual_display_recreated`.
