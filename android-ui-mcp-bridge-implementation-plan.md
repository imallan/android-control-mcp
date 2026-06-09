# Android UI MCP Bridge — Implementation Plan

> **Current status (2026-06-09):** Phase 1–3 are complete. Phase 4 text OCR
> fallback v1 (Tesseract + Apple Vision) is implemented; OCR cache and
> CV/object detection (OpenCV, YOLO, PaddleOCR) are **not** implemented.
> Actual tool names and startup differ from the early Phase 2/3
> recommendations below — see inline notes.

## Goal

Build an Android automation bridge that allows an LLM (through MCP) to:

- Read current Android screen screenshots
- Read current layout/accessibility tree
- Simulate:
  - tap
  - swipe
  - key events
  - text input
- Operate continuously in an agent loop

Target architecture:

```text
LLM
 ↓ MCP
Desktop MCP Server
 ↓ adb forward/socket
Android Shell Process Server
 ↓
Android System APIs / shell commands
```

---

## Phase 0 — Design Principles

### Core Philosophy

Avoid:

```text
LLM → adb shell every action
```

Prefer:

```text
LLM → MCP → persistent Android server
```

Reason:

- lower latency
- fewer adb roundtrips
- more stable streaming
- easier future expansion

---

## Phase 1 — MVP Without Android Jar

### Objective

Validate the MCP interaction loop before building the Android-side server.

Architecture:

```text
LLM
 ↓
MCP Server
 ↓
Local adb commands
```

---

## Tools to Implement

### android_screenshot

Implementation:

```sh
adb exec-out screencap -p
```

Return:

```json
{
  "imagePath": "/tmp/current-screen.png",
  "width": 1080,
  "height": 2400
}
```

---

### android_dump_tree

Implementation:

```sh
adb shell uiautomator dump /sdcard/window.xml
adb exec-out cat /sdcard/window.xml
```

Return:

```json
{
  "xml": "<hierarchy>...</hierarchy>"
}
```

---

### android_tap

Implementation:

```sh
adb shell input tap X Y
```

---

### android_swipe

Implementation:

```sh
adb shell input swipe X1 Y1 X2 Y2 DURATION
```

---

### android_input_text

Implementation:

```sh
adb shell input text "hello"
```

Need escaping handling for:

- spaces
- unicode
- quotes

---

### android_key

Implementation:

```sh
adb shell input keyevent KEYCODE_BACK
```

Support:

- BACK
- HOME
- ENTER
- APP_SWITCH
- DEL

---

## Recommended MCP Stack

Possible implementations:

| Language | Recommendation |
| --- | --- |
| TypeScript | Best overall |
| Python | Fast prototyping |
| Kotlin/JVM | Best Android ecosystem integration |

Recommendation:

- TypeScript for MCP server
- Kotlin for Android-side server later

---

## Deliverables

MCP server executable

Example:

```sh
npm run start
```

Tools exposed:

- android_screenshot
- android_dump_tree
- android_tap
- android_swipe
- android_input_text
- android_key

---

## Phase 2 — Android Persistent Server

### Objective

Remove repeated adb shell invocation overhead.

---

## Android Server Architecture

### Startup Flow

Push server jar:

```sh
adb push android-ui-server.jar /data/local/tmp/
```

> **Actual implementation:** The server is started with
> `uiautomator runtest /data/local/tmp/android-ui-server.jar -c com.example.androiduiserver.BridgeTest#testServe`,
> not `app_process / com.example.androiduiserver.Main` as originally sketched below.

Start process:

```sh
adb shell CLASSPATH=/data/local/tmp/android-ui-server.jar \
app_process / com.example.androiduiserver.Main
```

---

## Process Identity

Server runs as:

```text
uid = shell
```

This is critical.

Enables:

- uiautomator dump
- input injection
- many system-level shell capabilities

No root required.

---

## Socket Communication

### Android Side

Create:

```kotlin
LocalServerSocket("android-ui-mcp")
```

---

### Desktop Side

Use:

```sh
adb forward tcp:27183 localabstract:android-ui-mcp
```

Desktop MCP connects to:

```text
localhost:27183
```

---

## Communication Protocol

Recommendation:

Use newline-delimited JSON.

Example:

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

---

## Android Server Capabilities

### Screenshot

MVP

Internally execute:

```sh
screencap -p
```

Return raw PNG bytes.

---

### Future Optimization

Replace with:

- SurfaceControl
- MediaProjection
- ImageReader

Avoid shell process spawn.

---

### Layout Tree

MVP

Internally execute:

```sh
uiautomator dump
```

Return XML string.

---

### Future Optimization

Directly access:

- UiAutomation
- Accessibility APIs

Benefits:

- lower latency
- avoid temp files
- richer metadata

---

### Input Injection

MVP

Use shell commands:

```sh
input tap
input swipe
input keyevent
```

---

### Future Optimization

Use:

```text
InputManager.injectInputEvent()
```

Benefits:

- lower latency
- smoother gestures
- multi-touch support

---

## Phase 3 — LLM Agent Loop

### Standard Interaction Pattern

1. get screenshot
2. get layout tree
3. analyze UI
4. decide action
5. perform tap/swipe
6. repeat

---

## Recommended MCP Tool Design

> **Actual tool names** used in the implementation differ from the early
> recommendations below: `android_get_screen` → `android_screenshot`,
> `android_get_tree` → `android_dump_tree` / `android_dump_compact` /
> `android_get_semantic_screen`.

### android_get_screen

Returns:

```json
{
  "imagePath": "...",
  "width": 1080,
  "height": 2400
}
```

---

### android_get_tree

Returns:

```json
{
  "xml": "..."
}
```

---

### android_tap

Input:

```json
{
  "x": 100,
  "y": 200
}
```

---

### android_swipe

Input:

```json
{
  "x1": 100,
  "y1": 1200,
  "x2": 100,
  "y2": 300,
  "durationMs": 300
}
```

---

### android_input_text

Input:

```json
{
  "text": "hello world"
}
```

---

## Phase 4 — Advanced Features

> **Status:** Text OCR fallback v1 (Tesseract TSV + Apple Vision via
> `android_ocr_screen` and `android_get_semantic_screen` with `ocrMode`) is
> implemented. The following are **not yet implemented:** OCR cache,
> CV/object detection (OpenCV, YOLO, PaddleOCR), Android-side screenshot
> capture in the bridge, and `FLAG_SECURE` detection.

### OCR Integration

Necessary for:

- WeChat mini-programs
- games
- OpenGL pages
- video surfaces

Recommended stack:

| Purpose | Tool |
| --- | --- |
| OCR | Tesseract / PaddleOCR |
| CV | OpenCV |
| Object Detection | YOLO |

---

## Semantic UI Understanding

Build merged model:

```text
Accessibility Tree
+
Screenshot OCR
+
CV Detection
```

Unified node model:

```json
{
  "text": "...",
  "bounds": [x1, y1, x2, y2],
  "clickable": true,
  "source": "accessibility|ocr|cv"
}
```

---

## Streaming Screenshots

Future optimization:

- scrcpy-like H264 streaming

Instead of repeated screenshots.

Potential stack:

- MediaCodec
- H264 encoder
- adb socket tunnel

---

## Known Limitations

### Accessibility Tree != Real View Tree

`uiautomator dump` exposes:

- Accessibility/Semantics tree

NOT:

- Compose internal hierarchy
- actual View tree
- render tree

---

## FLAG_SECURE

Apps may block screenshots:

- banking apps
- DRM video apps
- some enterprise apps

Result:

- black screenshot

---

## WebView / OpenGL / Games

May expose almost no layout tree.

Need OCR/CV fallback.

---

## OEM Compatibility

Some OEM ROMs may:

- break uiautomator
- inject shell noise
- restrict input injection

Need compatibility testing.

---

## Suggested Repository Structure

```text
android-ui-mcp/
├── android-server/
│   ├── kotlin/
│   └── build.gradle.kts
│
├── desktop-mcp/
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
│
├── docs/
│   ├── protocol.md
│   ├── architecture.md
│   └── compatibility.md
│
└── scripts/
    ├── start-server.sh
    └── adb-forward.sh
```

---

## Recommended Initial Milestone

### Week 1

> **Note:** The original week milestones pre-date implementation. Phase 1–3
> are complete; Phase 4 text OCR is partially implemented.

Deliver:

- MCP server
- screenshot tool
- layout dump tool
- tap/swipe/input
- successful LLM interaction loop

No Android jar yet.

---

### Week 2

Deliver:

- persistent Android server
- socket protocol
- adb forward
- lower latency

---

### Week 3

Deliver:

- OCR integration
- semantic node merging
- robust navigation agent

---

## Success Criteria

System should be capable of:

LLM autonomously:

- opening apps
- navigating settings
- scrolling feeds
- clicking buttons
- filling forms
- reading screen state

using only:

- screenshot + accessibility tree + MCP tools
