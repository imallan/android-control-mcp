# Architecture

## Phase 1 MVP

```text
LLM
 ↓ MCP stdio
Desktop MCP Server
 ↓ adb commands
Android device
```

The MVP validates the agent loop before introducing Android-side persistent infrastructure.

## Phase 2 Target

```text
LLM
 ↓ MCP
Desktop MCP Server
 ↓ adb forward tcp:27183
Android Shell Process Server
 ↓
Android shell/system APIs
```

The Android server runs as uid `shell` via `app_process`, enabling screenshot, UIAutomator, and input capabilities without root.
