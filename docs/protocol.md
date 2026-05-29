# Protocol

## MCP

The desktop MCP server exposes standard MCP `tools/list` and `tools/call` over stdio. Tool results are returned as JSON text content.

Bridge-backed MCP tools:

- `android_bridge_ping`
- `android_bridge_exit`
- `android_get_semantic_screen`
- `android_dump_tree`
- `android_dump_compact`
- `android_tap`
- `android_tap_ref`
- `android_swipe`
- `android_input_text`
- `android_key`
- `android_perform_action`
- `android_long_press`
- `android_list_apps`
- `android_launch_app`

ADB-backed MCP tools:

- `android_screenshot`
- `android_ocr_screen`

`android_get_semantic_screen` combines ADB screenshot capture with bridge-backed compact tree access. Its `ocrMode` parameter controls OCR fallback:

- `auto`: run OCR only when the accessibility tree is sparse or known to be unreliable.
- `force`: always run OCR and merge OCR nodes with accessibility nodes.
- `off`: return accessibility nodes only.

`android_get_semantic_screen` returns a `snapshotId`, `screenSignature`, and compact semantic nodes. Each returned node includes a snapshot-local `ref`:

- Accessibility refs use `a1`, `a2`, `a3`, etc.
- OCR refs use `o1`, `o2`, `o3`, etc.
- Refs are stable only within the returned snapshot. They are not permanent element IDs.
- Ref-based action tools pass both `snapshotId` and `ref`, then reject or relocate stale refs when the screen has changed.

Semantic nodes may also include:

- `role`: best-effort role inferred from Android class names, actions, and OCR source.
- `editable`: whether the node appears to support text editing.
- `score`: usefulness score for agent selection and default ordering.

`android_tap_ref` taps a cached accessibility node by `snapshotId` and `ref`:

```json
{
  "snapshotId": "screen:...",
  "ref": "a2",
  "returnSnapshot": true
}
```

Behavior:

- `fresh`: current `screenSignature` matches the cached snapshot, so the cached accessibility node center is tapped.
- `relocated`: the screen changed, but exactly one current accessibility node matched conservatively and was tapped.
- `expired_snapshot`: the snapshot is no longer in the in-memory cache.
- `ref_not_found`: the ref does not exist in that snapshot.
- `unsupported_ref_source`: OCR refs are observation-only and cannot be tapped by ref in v1.
- `stale_ref_not_found`: the screen changed and no safe accessibility match was found.
- `stale_ref_ambiguous`: the screen changed and multiple current accessibility nodes matched, so no tap was sent.

Relocation only considers accessibility nodes. OCR nodes can help the agent understand a sparse screen, but they are not action targets for `android_tap_ref` in v1.

OCR-backed tools accept `ocrEngine`:

- `apple-vision`: local Apple Vision text recognition through the Swift helper, macOS-only, default.
- `tesseract`: local Tesseract TSV output, portable fallback.

## Android Bridge

The Android persistent server uses newline-delimited JSON over an adb-forwarded socket.

Supported bridge methods:

- `ping`
- `exit`
- `dumpXml`
- `dumpCompact`
- `tap`
- `swipe`
- `inputText`
- `performAction`
- `longPress`
- `key`
- `listApps`
- `launchApp`

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
