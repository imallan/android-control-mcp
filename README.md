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
android-server/scripts/start-uiautomator-server.sh
```

In another terminal:

```sh
cd desktop-mcp
npm run build
npm run start
```

Requirements:

- Node.js 24+
- `adb` available on `PATH`
- One authorized Android device, or `ANDROID_SERIAL` set

The MCP server has no npm dependencies; it runs directly on Node 24's TypeScript support.

## Install in Codex

Install the desktop MCP server globally with the Codex CLI:

```sh
codex mcp add android-ui-mcp \
  -- "/Users/allan/Documents/Codex/misc/Android Control MCP/scripts/start-desktop-mcp.sh"
```

The launcher auto-selects the connected Android device when exactly one device is authorized. If multiple devices are connected, set a serial explicitly:

```sh
adb devices
codex mcp remove android-ui-mcp
codex mcp add android-ui-mcp \
  --env ANDROID_SERIAL=<device-serial> \
  -- "/Users/allan/Documents/Codex/misc/Android Control MCP/scripts/start-desktop-mcp.sh"
```

Keep the Android-side bridge running before using the MCP tools:

```sh
android-server/scripts/start-uiautomator-server.sh
```

Restart or reload Codex after installing the MCP server. Codex discovers MCP tools when a session starts, so newly installed tools usually appear in a fresh thread.
