# Protocol

## Phase 1

The desktop MCP server exposes standard MCP `tools/list` and `tools/call` over stdio. Tool results are returned as JSON text content.

## Phase 2 Preview

The Android persistent server will use newline-delimited JSON over an adb-forwarded socket.

Request:

```json
{
  "id": 1,
  "method": "tap",
  "params": {
    "x": 540,
    "y": 1200
  }
}
```

Response:

```json
{
  "id": 1,
  "success": true
}
```

Desktop forwarding:

```sh
adb forward tcp:27183 localabstract:android-ui-mcp
```
