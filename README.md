# Android Control MCP

Android UI automation bridge for MCP.

This repository implements an Android UI MCP bridge. The desktop MCP server exposes tools over MCP stdio and delegates UIAutomator operations to a persistent on-device bridge started with `uiautomator runtest`.

## Layout

```text
android-server/   Kotlin UIAutomator process server
desktop-mcp/      TypeScript MCP stdio server
docs/             Architecture, protocol, and compatibility notes
scripts/          Helper scripts and MCP launchers
```

## Run

```sh
android-server/scripts/build-uiautomator-jar.sh
cd desktop-mcp
npm run build
npm run start
```

Requirements:

- Node.js 24+
- `adb` available on `PATH`
- `android-server/build/android-ui-server.jar` built before the first bridge-backed tool call

Android 14+ devices can run display-scoped headless sessions. Create a session with
`android_create_virtual_display`, pass its `sessionId` to launch, observation, wait,
and input tools, then release it with `android_destroy_virtual_display`. The default
display remains display `0` when no target is supplied.

The server also supports local sanitized traces, capability-group filtering,
post-action wait conditions, cached OCR, ref-disappearance waits, and Android system
workflow helpers for notifications, Quick Settings, keyboard, permissions, and recents.
For token-efficient agent observation, `android_get_ui_outline` returns a zoned text
outline while preserving the same snapshot-local refs used by semantic actions.

The MCP server has no npm dependencies; it runs directly on Node 24's TypeScript support. It can start with no Android device connected. When a device-backed tool is called, the server discovers connected devices and starts the on-device UIAutomator bridge automatically.

## Install in Codex

Install the desktop MCP server globally with the Codex CLI:

```sh
codex mcp add android-ui-mcp \
  -- "/Users/allan/Documents/Codex/misc/Android Control MCP/scripts/start-desktop-mcp.sh"
```

Use `android_list_devices` to see connected devices. Most Android tools accept an optional `deviceId` equal to the ADB serial. If exactly one authorized device is connected, `deviceId` can be omitted. If multiple devices are connected, pass `deviceId` on each tool call or set `ANDROID_SERIAL` as a default:

```sh
adb devices
codex mcp remove android-ui-mcp
codex mcp add android-ui-mcp \
  --env ANDROID_SERIAL=<device-serial> \
  -- "/Users/allan/Documents/Codex/misc/Android Control MCP/scripts/start-desktop-mcp.sh"
```

The Android-side bridge is normally managed by the MCP server. The manual bridge launcher remains useful for debugging:

```sh
android-server/scripts/start-uiautomator-server.sh
```

Restart or reload Codex after installing the MCP server. Codex discovers MCP tools when a session starts, so newly installed tools usually appear in a fresh thread.
