# Protocol

## MCP

The desktop MCP server exposes standard MCP `tools/list` and `tools/call` over stdio. Tool results are returned as JSON text content.

Bridge-backed MCP tools:

- `android_bridge_ping`
- `android_bridge_exit`
- `android_current_app`
- `android_wait_for_package`
- `android_wait_for_text`
- `android_wait_for_screen_change`
- `android_get_semantic_screen`
- `android_dump_tree`
- `android_dump_compact`
- `android_tap`
- `android_tap_ref`
- `android_fill_ref`
- `android_long_press_ref`
- `android_perform_action_ref`
- `android_tap_text`
- `android_tap_content_desc`
- `android_click`
- `android_fill_near_label`
- `android_swipe`
- `android_input_text`
- `android_key`
- `android_go_home`
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

`android_get_semantic_screen` returns a `snapshotId`, `screenSignature`, `actionableSignature`, and compact semantic nodes. Each returned node includes a snapshot-local `ref`:

- Accessibility refs use `a1`, `a2`, `a3`, etc.
- OCR refs use `o1`, `o2`, `o3`, etc.
- Refs are stable only within the returned snapshot. They are not permanent element IDs.
- Ref-based action tools pass both `snapshotId` and `ref`, then reject or relocate stale refs when the screen has changed.

Semantic nodes may also include:

- `role`: best-effort role inferred from Android class names, actions, and OCR source.
- `editable`: whether the node appears to support text editing.
- `score`: usefulness score for agent selection and default ordering.

Action tools that return `currentSnapshot`, including coordinate, ref, and locator taps, support stable snapshot waiting:

- `returnSnapshot`: include post-action context, default `true`.
- `waitForStable`: wait for a stable post-action accessibility snapshot before returning, default `true`.
- `stableTimeoutMs`: maximum stable wait, default `1500`.
- `stablePollIntervalMs`: stable wait poll interval, default `150`.

Stable waiting first checks strict `screenSignature` equality across consecutive snapshots. If full signatures keep changing, for example on an animated pager, it falls back to `actionableSignature`, which only considers actionable accessibility nodes with coarse bounds. Responses include `snapshotStable`, `stability` (`strict`, `actionable`, `timeout`, or `not_requested`), and `snapshotWaitElapsedMs`.

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

`android_fill_ref`, `android_long_press_ref`, and `android_perform_action_ref` use the same `snapshotId` + `ref` stale handling as `android_tap_ref` and reject OCR refs.

`android_fill_ref` only fills nodes that resolve to `editable: true` or `role: "textbox"`. It sends accessibility `inputText` with a selector derived from the resolved node.

`android_long_press_ref` long-presses the resolved node center through the Android bridge.

`android_perform_action_ref` sends an accessibility action with a selector derived from the resolved node. The action may be one of the common predefined names, such as `click`, `long_click`, `scroll_forward`, `scroll_backward`, `expand`, `collapse`, `dismiss`, `set_selection`, or `set_text`, or a custom action label exposed by that accessibility node in `actions`.

Convenience actions operate on the current accessibility snapshot and do not use OCR nodes as action targets:

- `android_tap_text`: taps the unique node matching `text`, with optional `role` and `fuzzy`.
- `android_tap_content_desc`: taps the unique node matching `contentDesc`, with optional `role` and `fuzzy`.
- `android_click`: taps the unique node matching a small locator containing any of `resourceId`, `text`, `contentDesc`, `role`, or `className`.
- `android_fill_near_label`: fills the unique editable node spatially associated with a unique label.

If a convenience action finds no match, it returns `success: false` with a `*_not_found` status and the current snapshot. If multiple nodes match, it returns `success: false` with a `*_ambiguous` status and candidate refs, without sending an input event.

Wait and recovery tools:

- `android_current_app`: returns the current foreground package name.
- `android_wait_for_package`: polls `android_current_app` until `packageName` matches.
- `android_wait_for_text`: polls current accessibility snapshots until text appears.
- `android_wait_for_screen_change`: polls accessibility snapshots until `screenSignature` changes from a supplied `snapshotId`, supplied `screenSignature`, or an initial baseline captured by the tool.

Wait tools accept `timeoutMs` and `pollIntervalMs` and return `success: true` when the condition is met, otherwise `success: false` with a timeout status and the latest observed state.

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
- `currentApp`
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
