# Android Control MCP

Android UI automation bridge for MCP.

This repository currently implements the Phase 1 MVP from `android-ui-mcp-bridge-implementation-plan.md`: a desktop MCP server that calls local `adb` commands for screenshots, accessibility tree dumps, taps, swipes, text input, and key events.

## Layout

```text
android-server/   Phase 2 placeholder for the Android shell process server
desktop-mcp/      Phase 1 TypeScript MCP stdio server
docs/             Architecture, protocol, and compatibility notes
scripts/          Helper scripts
```

## Run the MVP

```sh
cd desktop-mcp
npm run build
npm run start
```

Requirements:

- Node.js 24+
- `adb` available on `PATH`
- One authorized Android device, or `ANDROID_SERIAL` set

The MVP has no npm dependencies; it runs directly on Node 24's TypeScript support.
