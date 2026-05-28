# Android Control MCP

Android UI automation bridge for MCP.

This repository implements an Android UI MCP bridge. The desktop MCP server exposes tools over MCP stdio and delegates UIAutomator operations to a persistent on-device bridge started with `uiautomator runtest`.

## Layout

```text
android-server/   Kotlin UIAutomator process server
desktop-mcp/      TypeScript MCP stdio server
docs/             Architecture, protocol, and compatibility notes
scripts/          Helper scripts
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
