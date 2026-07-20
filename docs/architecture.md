# Architecture

## Current Architecture

```text
LLM
 ↓ MCP stdio
Desktop MCP Server
 ↓ adb forward tcp:27183
Android UIAutomator Bridge
 ↓
Android shell/UIAutomator APIs
```

The desktop MCP server remains the MCP stdio process. It refreshes the `adb forward`
mapping and sends newline-delimited JSON requests to the Android-side bridge for
UIAutomator operations.

On display 0, compact accessibility snapshots contain the active window plus secondary
windows whose accessibility parent chain reaches it, such as popup menus, dropdowns,
and anchored dialogs. Unrelated top-level windows from split-screen apps are excluded.
Non-default virtual displays continue to include all accessibility windows assigned to
their display.

Direct ADB commands are still used for capabilities not yet implemented by the bridge:
screenshot capture.

Text input, app listing, and app launch now run through the Android bridge. The bridge
still uses Android shell/UIAutomator facilities internally where appropriate, but those
operations avoid a new desktop-side `adb shell` process per MCP call.

## Earlier MVP

```text
LLM
 ↓ MCP stdio
Desktop MCP Server
 ↓ adb commands
Android device
```
