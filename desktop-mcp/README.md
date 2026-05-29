# Android UI MCP Desktop Server

MCP server for Android UI automation. UIAutomator operations go through the persistent
on-device bridge, exposed over MCP stdio:

- `android_bridge_ping`: verify that the on-device bridge is reachable
- `android_bridge_exit`: stop the on-device bridge
- `android_screenshot`: overwrites one stable temp file by default; pass `retain=true` to keep a unique screenshot
- `android_ocr_screen`: run local OCR on the current screenshot and return compact OCR nodes
- `android_get_semantic_screen`: return accessibility nodes with automatic or forced OCR fallback
- `android_dump_tree`: XML hierarchy from the on-device bridge
- `android_dump_compact`: compact node list from the on-device bridge
- `android_tap`
- `android_tap_ref`: tap an accessibility node from a semantic snapshot by `snapshotId` + `ref`
- `android_fill_ref`: fill an editable accessibility node from a semantic snapshot by `snapshotId` + `ref`
- `android_tap_text`
- `android_tap_content_desc`
- `android_click`
- `android_fill_near_label`
- `android_swipe`
- `android_input_text`
- `android_key`
- `android_list_apps`: list launcher apps through the Android bridge
- `android_launch_app`: launch by `applicationId`, or by a unique `appName` match

## Requirements

- Node.js 24+
- Android platform-tools with `adb` on `PATH`
- One authorized Android device, or `ANDROID_SERIAL` set when multiple devices are connected
- The Android bridge jar built and started with `../android-server/scripts/start-uiautomator-server.sh`

## Usage

Start the Android-side bridge in one terminal:

```sh
../android-server/scripts/start-uiautomator-server.sh
```

Start the MCP server in another terminal:

```sh
npm run build
npm run start
```

This MVP intentionally has no npm dependencies. It relies on Node 24's built-in TypeScript type stripping.

Optional environment variables:

- `ANDROID_SERIAL`: target device serial
- `ANDROID_MCP_ADB_TIMEOUT_MS`: default ADB command timeout, default `15000`
- `ANDROID_MCP_SCREENSHOT_TIMEOUT_MS`: screenshot timeout, default `20000`
- `ANDROID_MCP_OCR_TIMEOUT_MS`: local OCR command timeout, default `90000`
- `ANDROID_MCP_APPLE_VISION_OCR_BIN`: optional prebuilt Apple Vision OCR helper path
- `ANDROID_UI_MCP_HOST`: bridge host, default `127.0.0.1`
- `ANDROID_UI_MCP_PORT`: bridge/adb-forward port, default `27183`
- `ANDROID_UI_MCP_TIMEOUT_MS`: bridge request timeout, default `15000`

## MCP Client Configuration

Use the repository launcher for Codex and other stdio MCP clients. It auto-selects the connected Android device when exactly one device is authorized, respects `ANDROID_SERIAL` when set, and then starts `node src/server.ts`. Avoid launching through plain `npm run start` for stdio clients unless it is run silently, because npm can print lifecycle text to stdout and MCP stdout must contain only JSON-RPC messages.

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

If multiple Android devices are connected, set `ANDROID_SERIAL`:

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

- `android_dump_tree`, `android_dump_compact`, `android_tap`, `android_tap_ref`, `android_fill_ref`, `android_tap_text`, `android_tap_content_desc`, `android_click`, `android_fill_near_label`, `android_swipe`, `android_input_text`, `android_perform_action`, `android_long_press`, `android_key`, `android_list_apps`, and `android_launch_app` require the persistent Android bridge.
- `android_get_semantic_screen` requires both screenshot capture and the persistent Android bridge.
- `android_screenshot` and `android_ocr_screen` use direct ADB screenshot capture because the Android bridge does not yet expose screenshot capture.
- `android_ocr_screen` and OCR fallback in `android_get_semantic_screen` support `ocrEngine: "apple-vision"` and `ocrEngine: "tesseract"`.
- The Apple Vision engine is the default OCR backend on this MCP.
- The Tesseract engine requires local `tesseract` on `PATH`.
- The Apple Vision engine requires macOS. The desktop server compiles `apple-vision-ocr.swift` with `swiftc` into `/tmp/android-ui-mcp/apple-vision-ocr` on first use unless `ANDROID_MCP_APPLE_VISION_OCR_BIN` is set.
- The MCP server refreshes `adb forward tcp:$ANDROID_UI_MCP_PORT localabstract:android-ui-mcp` before each bridge call.

## Limitations

- `android_screenshot` writes `/tmp/android-ui-mcp/current-screen.png` by default. Use `retain=true` only when you want historical screenshots.
- Text input uses accessibility `ACTION_SET_TEXT` when possible, but depends on the target node exposing editable accessibility actions.
- App-name launch uses package/activity-derived aliases. `applicationId` launch is deterministic.
- `FLAG_SECURE` apps can return black screenshots.
- WebView, OpenGL, and game screens may expose little or no accessibility tree.
- Apple Vision is macOS-only and its supported OCR languages depend on the installed system.
