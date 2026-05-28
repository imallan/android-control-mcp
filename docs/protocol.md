# Protocol

## MCP

The desktop MCP server exposes standard MCP `tools/list` and `tools/call` over stdio. Tool results are returned as JSON text content.

Bridge-backed MCP tools:

- `android_bridge_ping`
- `android_bridge_exit`
- `android_dump_tree`
- `android_dump_compact`
- `android_tap`
- `android_swipe`
- `android_key`
- `android_perform_action`
- `android_long_press`

ADB-backed MCP tools:

- `android_screenshot`
- `android_list_apps`
- `android_launch_app`

## Android Bridge

The Android persistent server uses newline-delimited JSON over an adb-forwarded socket.

Request:

```json
{
  "method": "tap",
  "x": 540,
  "y": 1200
}
```

Response:

```json
{
  "ok": true,
  "success": true
}
```

Desktop forwarding:

```sh
adb forward tcp:27183 localabstract:android-ui-mcp
```
