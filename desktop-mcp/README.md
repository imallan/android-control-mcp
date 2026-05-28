# Android UI MCP Desktop Server

MCP server for Android UI automation. UIAutomator operations go through the persistent
on-device bridge, exposed over MCP stdio:

- `android_bridge_ping`: verify that the on-device bridge is reachable
- `android_bridge_exit`: stop the on-device bridge
- `android_screenshot`: overwrites one stable temp file by default; pass `retain=true` to keep a unique screenshot
- `android_dump_tree`: XML hierarchy from the on-device bridge
- `android_dump_compact`: compact node list from the on-device bridge
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
- `ANDROID_MCP_APP_LIST_TIMEOUT_MS`: app listing timeout, default `60000`
- `ANDROID_UI_MCP_HOST`: bridge host, default `127.0.0.1`
- `ANDROID_UI_MCP_PORT`: bridge/adb-forward port, default `27183`
- `ANDROID_UI_MCP_TIMEOUT_MS`: bridge request timeout, default `15000`
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

## Transport Notes

- `android_dump_tree`, `android_dump_compact`, `android_tap`, `android_swipe`, and `android_key` require the persistent Android bridge.
- `android_screenshot`, `android_input_text`, `android_list_apps`, and `android_launch_app` still use direct ADB commands because the Android bridge does not yet expose screenshot, text input, or package-manager methods.
- The MCP server refreshes `adb forward tcp:$ANDROID_UI_MCP_PORT localabstract:android-ui-mcp` before each bridge call.

## Limitations

- `android_screenshot` writes `/tmp/android-ui-mcp/current-screen.png` by default. Use `retain=true` only when you want historical screenshots.
- `adb shell input text` has limited Unicode support on some Android builds.
- App-name launch is localization-sensitive. Fast matching uses package/activity-derived aliases; pass `resolveLabels=true` to allow APK label parsing with local `aapt`. `applicationId` launch is deterministic.
- `FLAG_SECURE` apps can return black screenshots.
- WebView, OpenGL, and game screens may expose little or no accessibility tree.
