# Android UI MCP Desktop Server

Phase 1 MVP MCP server for Android UI automation. It exposes ADB-backed tools over MCP stdio:

- `android_screenshot`: overwrites one stable temp file by default; pass `retain=true` to keep a unique screenshot
- `android_dump_tree`
- `android_tap`
- `android_swipe`
- `android_input_text`
- `android_key`
- `android_list_apps`: list launcher apps; pass `resolveLabels=true` to parse APK labels when needed
- `android_launch_app`: launch by `applicationId`, or by a unique `appName` match

## Requirements

- Node.js 20+
- Android platform-tools with `adb` on `PATH`
- One authorized Android device, or `ANDROID_SERIAL` set when multiple devices are connected

## Usage

```sh
npm run build
npm run start
```

This MVP intentionally has no npm dependencies. It relies on Node 24's built-in TypeScript type stripping.

Optional environment variables:

- `ANDROID_SERIAL`: target device serial
- `ANDROID_MCP_ADB_TIMEOUT_MS`: default ADB command timeout, default `15000`
- `ANDROID_MCP_SCREENSHOT_TIMEOUT_MS`: screenshot timeout, default `20000`
- `ANDROID_MCP_APP_LIST_TIMEOUT_MS`: app listing timeout, default `60000`
- `AAPT_PATH`: optional path to Android SDK `aapt` for APK label parsing

## MCP Client Configuration

Use `npm run start` from this directory as the MCP stdio command after building.

```json
{
  "mcpServers": {
    "android-ui-mcp": {
      "command": "npm",
      "args": ["run", "start"],
      "cwd": "/Users/allan/Documents/Codex/misc/Android Control MCP/desktop-mcp"
    }
  }
}
```

## Limitations

- This phase shells out to `adb` for each operation.
- `android_screenshot` writes `/tmp/android-ui-mcp/current-screen.png` by default. Use `retain=true` only when you want historical screenshots.
- `adb shell input text` has limited Unicode support on some Android builds.
- App-name launch is localization-sensitive. Fast matching uses package/activity-derived aliases; pass `resolveLabels=true` to allow APK label parsing with local `aapt`. `applicationId` launch is deterministic.
- `FLAG_SECURE` apps can return black screenshots.
- WebView, OpenGL, and game screens may expose little or no accessibility tree.
