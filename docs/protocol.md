# Protocol

## MCP

The desktop MCP server exposes standard MCP `tools/list` and `tools/call` over stdio. Tool results are returned as JSON text content.

Bridge-backed MCP tools:

- `android_list_devices`
- `android_bridge_ping`
- `android_bridge_exit`
- `android_capabilities`
- `android_trace_start`
- `android_trace_stop`
- `android_trace_status`
- `android_create_virtual_display`
- `android_destroy_virtual_display`
- `android_list_displays`
- `android_current_app`
- `android_wait_for_package`
- `android_wait_for_text`
- `android_wait_for_ref_gone`
- `android_wait_for_screen_change`
- `android_get_semantic_screen`
- `android_get_ui_outline`
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
- `android_open_notifications`
- `android_open_quick_settings`
- `android_close_keyboard`
- `android_grant_permission_dialog`
- `android_open_recents`
- `android_switch_recent_app`
- `android_perform_action`
- `android_long_press`
- `android_list_apps`
- `android_launch_app`

ADB-backed MCP tools:

- `android_screenshot`
- `android_ocr_screen`

Display 0 screenshots are ADB-backed. When `sessionId` or a non-zero MCP-owned
`displayId` is supplied, screenshot/OCR capture is bridge-backed through the virtual
display's ImageReader.

Device-backed tools accept optional `deviceId`, using the ADB serial. If omitted,
the server uses `ANDROID_SERIAL` when set, otherwise auto-selects only when exactly
one authorized device is connected. With no authorized devices it returns
`no_device`; with multiple authorized devices it returns `ambiguous_device`.
The desktop MCP server starts one UIAutomator bridge per selected device on demand.

Display-capable tools accept exactly one of `sessionId` or `displayId`. Omitting both
targets display 0. `sessionId` is preferred because Android can reuse numeric display
IDs. Virtual display snapshots include display identity in `snapshotId`; ref actions
reject a different target. Lifecycle failures use `virtual_display_not_found`,
`virtual_display_recreated`, or `bridge_restarted`.

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
- `depth`, `windowIndex`: compact hierarchy and owning-window position.
- `collection`, `collectionItem`, `collectionScope`: list/grid structure used for stable-in-snapshot row aliases.
- `checkable`, `checked`, `focused`, `selected`, `enabled`: relevant accessibility state when exposed.

`android_get_ui_outline` runs the same semantic collection pipeline and creates the
same cached snapshot, but returns a compact `outline` string instead of the full node
array. Primary-window nodes are zoned into `[Top]`, `[Content]`, and `[Bottom]`;
secondary accessibility windows receive their own sections. Lines retain `aN`, `oN`,
and `vN` refs. Collection items can additionally receive `#N` aliases (or `#N@scope`
when multiple collections are present); aliases are outline labels, while action tools
continue to accept the adjacent snapshot ref. `includeEntries` defaults to `false`,
`includeScreenshot` defaults to `false`, and `maxLines` defaults to `80`.

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

Mutating tools accept an optional `after` object with `waitForText` and/or
`waitForPackage`, plus timeout/poll settings. The tool result includes the nested
wait results and reports `success: false` when a requested postcondition times out.
`android_wait_for_ref_gone` binds the original accessibility ref to its device and
display/session and waits until conservative relocation can no longer find it.

## OCR Cache

OCR results are cached in a bounded process-local LRU keyed by image bytes, engine,
languages, confidence, crop offset, and ROI-derived image. Results expose
`ocrCached`. Restarting the desktop MCP clears the cache.

## Trace Capture

`android_trace_start`, `android_trace_status`, and `android_trace_stop` manage one
active local trace. Each non-trace tool records sanitized input, result/error,
elapsed time, semantic context present in the result, and a copied screenshot when
`imagePath` is returned. The default directory is
the OS temporary directory's `android-ui-mcp/traces/<trace-id>/`; override its root with
`ANDROID_MCP_TRACE_DIR`.

## Capability Groups

Groups are `core`, `ocr`, `apps`, `debug`, `trace`, and `vision`. By default all are
enabled. Set comma-separated `ANDROID_MCP_CAPABILITIES` before server startup to
restrict exposed/callable tools. `tools/list` also accepts a `capabilities` array for
request-time filtering, and each tool carries its group in `_meta`.

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
- `createVirtualDisplay`
- `destroyVirtualDisplay`
- `listDisplays`
- `captureFrame`

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
