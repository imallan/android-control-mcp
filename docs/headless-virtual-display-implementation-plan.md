# Headless Virtual Display Implementation Plan

## Completion Status

Phases 0–5 are complete as of 2026-07-12 and were exercised end-to-end on the
Android 17 / API 37 `Pixel_10` emulator. Verified operations include create/list,
Settings launch on a secondary display, 1024×768 ImageReader screenshot, filtered
semantic accessibility, ref tap, accessibility text fill, swipe, Back, display-0
regression capture, explicit destroy, replacement, and bridge-restart recovery.
Host checks include the Android bridge build, desktop syntax check, display/session
unit tests, and `git diff --check`.

## Goal

Add an MCP-supported mode that creates a secondary Android virtual display, launches an app onto that display, and runs normal MCP observe/interact operations against that display without requiring the app to occupy the physical device screen.

This should be treated as a display-scoped automation session. The virtual display is owned by the Android bridge process, so if the bridge exits or crashes, the display and all cached state for it are invalid.

## Reference Behavior

scrcpy implements this using Android-side APIs rather than shell-only commands:

- Create a persistent `VirtualDisplay` from the Android server process.
- Keep the `VirtualDisplay` object alive for the session lifetime.
- Capture frames from the virtual display surface.
- Wait until the virtual display ID is known.
- Launch apps with `ActivityOptions.setLaunchDisplayId(displayId)`.
- Inject touch and key events with the target display ID set on the input event.

Useful upstream files:

- `server/src/main/java/com/genymobile/scrcpy/video/NewDisplayCapture.java`
- `server/src/main/java/com/genymobile/scrcpy/wrappers/DisplayManager.java`
- `server/src/main/java/com/genymobile/scrcpy/control/Controller.java`
- `server/src/main/java/com/genymobile/scrcpy/device/Device.java`
- `doc/virtual-display.md`

## Original MCP Limitations (resolved by this implementation)

The current bridge and desktop server assume the default display in several places:

- `BridgeTest.launchApp()` uses `monkey -p ...`, which cannot target a display.
- `tap`, `swipe`, `longPress`, and `key` use `UiDevice` default-display helpers.
- `android_screenshot` uses `adb exec-out screencap -p`, which captures the default display.
- Accessibility root collection is not display-scoped.
- Snapshot refs do not encode or validate display identity.

## Target User-Facing Model

Add explicit display/session tools first, then thread display targeting through existing tools.

Initial tools:

- `android_create_virtual_display`
  - Inputs: `width`, `height`, optional `dpi`, optional `systemDecorations`, optional `destroyContentOnRemoval`, optional `displayImePolicy`.
  - Output: `displayId`, `width`, `height`, `dpi`, `sessionId`.
- `android_destroy_virtual_display`
  - Inputs: `sessionId` or `displayId`.
  - Output: `success`.
- `android_list_displays`
  - Output: display IDs, sizes, density, flags, and whether each display is MCP-owned.
- `android_launch_app`
  - Add optional `displayId` or `sessionId`.
- Existing observation and input tools
  - Add optional `displayId` or `sessionId`.
  - Default remains the physical display `0`.

`sessionId` should be preferred in user-facing responses because virtual display IDs are device-local and can be reused after display destruction.

## Android Bridge Changes

### 1. Add Display Session Registry

Create a bridge-side registry that stores MCP-owned virtual displays:

```text
sessionId -> {
  displayId,
  virtualDisplay,
  imageReader,
  surface,
  width,
  height,
  dpi,
  flags,
  createdAt
}
```

The registry must hold strong references to `VirtualDisplay` objects. Releasing the object or killing the bridge process destroys the display.

First implementation scope: support one MCP-owned virtual display per device. This keeps lifecycle, stale-session handling, and snapshot identity simple while the hidden Android APIs are still being validated.

### 2. Create Virtual Display

Implement a Kotlin equivalent of scrcpy's display creation path. Confirmed working approach from Phase 0 probe:

- Get system Context via `ActivityThread.systemMain().getSystemContext()` (NOT `currentActivityThread()` — returns null in UIAutomator).
- Wrap in `ContextWrapper` overriding `getPackageName()` and `getOpPackageName()` to return `"com.android.shell"`.
- Construct `android.hardware.display.DisplayManager` via its hidden `(Context)` constructor.
- Create an `ImageReader` as the rendering surface.
- Call `createVirtualDisplay(name, width, height, dpi, surface, flags)`.
- Target Android 14+ only.
- Flags must include: `PUBLIC`, `PRESENTATION`, `OWN_CONTENT_ONLY`, `SUPPORTS_TOUCH`, `ROTATES_WITH_CONTENT`, `TRUSTED`, `OWN_DISPLAY_GROUP`, `ALWAYS_UNLOCKED`, `TOUCH_FEEDBACK_DISABLED`, `OWN_FOCUS`, `DEVICE_DISPLAY_GROUP`.
- Without these flags, the display is created but immediately destroyed by the system.
- Store `VirtualDisplay` and `ImageReader` as strong references in the bridge (class fields, not locals).
- Keep `systemDecorations` configurable.
- Keep `destroyContentOnRemoval` configurable.

The ImageReader surface doubles as the screenshot capture source (see Phase 1).

### 3. Launch Apps on Target Display

Replace display-targeted launch with Android framework APIs. `am start --display <id>` from shell is blocked (`SecurityException: Permission Denial` for uid 2000 on non-default displays). Launch must happen inside the bridge process:

- Resolve app launch intent from `PackageManager.getLaunchIntentForPackage()` or leanback intent.
- Add `Intent.FLAG_ACTIVITY_NEW_TASK`.
- Create `ActivityOptions.makeBasic()`.
- Call `setLaunchDisplayId(displayId)`.
- Start from inside the bridge with launch options, NOT via `am start` shell command.
- Add a focused launch probe before hardening the public tool because `IActivityManager` / `IActivityTaskManager` method signatures vary across Android releases. Prefer the simplest working Android 14+ route, such as `Context.startActivity(intent, options.toBundle())`, then fall back to hidden activity-manager reflection only if needed.

Keep the existing `monkey` launch as fallback only for display `0`.

### 4. Display-Scoped Input Injection

Add bridge methods for display-scoped input:

- `tap(displayId, x, y)`
- `swipe(displayId, x1, y1, x2, y2, steps)`
- `longPress(displayId, x, y, steps)`
- `key(displayId, keyCode)`
- optionally `inputText(displayId, text)` for key-event text fallback

Use `InputManager.injectInputEvent()` and set the display ID on `MotionEvent` / `KeyEvent` for non-default displays. Keep current `UiDevice` helpers for default display compatibility until the new path is stable.

### 5. Display-Scoped Accessibility

Update compact dump and XML dump logic to accept a display target:

- Prefer `UiAutomation.getWindows()` and filter windows by `AccessibilityWindowInfo.getDisplayId()` where available.
- For `displayId != 0`, do not use the active-root shortcut; it is default-focus oriented and can silently return nodes from the wrong display.
- Fall back to active root only when targeting default display.
- Include `displayId` in dump responses and node refs.
- First implementation may scope XML dump to display `0` only. The display-scoped path should focus on compact dump and semantic screen, because `UiDevice.dumpWindowHierarchy()` is default-display oriented.

Expected risk: some Android 14+ builds or OEM builds may expose incomplete accessibility windows for virtual displays.

### 6. Display-Scoped Screenshot

`screencap -d <displayId>` is **not reliable** (fails on Android 17 for all display IDs). Screenshot capture must be bridge-owned.

Implemented as part of Phase 1 (Virtual Display Screenshot Pipeline):

- **Display 0:** keep the existing `adb exec-out screencap -p` path for the first implementation. `SurfaceControl.screenshot()` can be probed later, but it is not a prerequisite for virtual-display support.
- **Virtual displays (N > 0):** `ImageReader.acquireLatestImage()` → Image → PNG.
- Virtual display capture uses the bridge RPC response: `{ pngBase64, width, height, displayId, sessionId }`.
- Normalize output to the existing screenshot result shape: `imagePath`, `width`, `height`, `displayId`, `sessionId`.

Image conversion requirements:

- Wait for the first frame with a bounded timeout.
- Always close acquired `Image` objects.
- Handle `rowStride` / `pixelStride` padding when converting RGBA planes to a `Bitmap`.
- Avoid `maxImages` leaks by draining stale frames or always closing superseded images.
- Return a clear timeout or stale-session error if no frame is available.

### 7. Lifecycle and Cleanup

Add cleanup behavior:

- `android_bridge_exit` releases all MCP-owned virtual displays.
- Bridge process teardown releases all displays naturally.
- Desktop server invalidates cached snapshots when bridge reconnects.
- Destroying a virtual display invalidates refs for that `sessionId`.

Return clear errors for stale sessions:

- `virtual_display_not_found`
- `virtual_display_recreated`
- `bridge_restarted`
- `display_not_supported`

## Desktop MCP Changes

### 1. Schema Updates

Add `displayId` and `sessionId` to device-backed tools:

- observation: screenshot, OCR, semantic screen, dump tree, dump compact
- input: tap, tap ref, fill ref, click, swipe, long press, key
- waits: wait for package, wait for text, wait for screen change
- app: launch app, current app if display-scoped detection is implemented

Only one of `displayId` or `sessionId` should be accepted per call.

### 2. Ref and Snapshot Identity

Include display identity in refs and snapshots:

```text
snapshotId = screen:<deviceId>:<sessionId-or-displayId>:<timestamp>:<signature>
ref = a1 bound to snapshotId and display target
```

`android_tap_ref` and `android_fill_ref` must reject refs from a different display/session.

### 3. Session Resolution

Add a resolver:

```text
input sessionId -> bridge displayId
input displayId -> displayId
omitted -> 0
```

The resolver should call the bridge when needed so stale sessions fail before input is injected.

### 4. Semantic Screen Merge

Make `android_get_semantic_screen` pass the same display target to:

- screenshot
- accessibility dump
- OCR
- vision detection

Never merge OCR from one display with accessibility nodes from another.

## Compatibility Matrix

Minimum viable target:

- Android 14+ only.
- Android 14+ is required because the first implementation depends on `OWN_FOCUS` and `DEVICE_DISPLAY_GROUP` for persistent, focusable, touch-capable virtual displays.

Tested:

- ✅ **Android 17 (API 37) emulator:** Virtual display creation confirmed. System registration via VirtualDisplayAdapter, layerstack, active input viewport. `screencap -d` not functional. `am start --display` blocked by shell permissions.

Unsupported or degraded cases:

- Android versions before 14 are out of scope for the first implementation.
- Apps may refuse secondary displays or move activities back to display `0`.
- `FLAG_SECURE` apps may still block visual capture.
- OEM ROMs may block hidden APIs used by virtual display or input injection.
- IME behavior may appear on the physical display unless display IME policy is set and supported.

## Phase 0: Feasibility Probe Results

**Test device:** Android 17 (API 37) emulator.

### 0.1 Virtual Display Creation — ✅ CONFIRMED

Virtual display CAN be created from within a `uiautomator runtest` process. Logcat confirms full system registration:

```
DisplayManagerService: Virtual Display: creating DisplayDevice with VirtualDisplayAdapter
SurfaceFlinger: Creating virtual display: mcp-probe
DisplayDeviceRepository: Display device added: "mcp-probe"
  uniqueId="virtual:com.android.shell,2000,mcp-probe,3", 1024 x 768, 160dpi
  FLAG_TRUSTED, FLAG_OWN_FOCUS, FLAG_OWN_DISPLAY_GROUP, ...
DisplayDevice: [N] Layerstack set to N
VirtualDisplayAdapter: state UNKNOWN -> ON
InputManager-JNI: Viewport added, isActive: true
Owner: com.android.shell (uid 2000)
```

The probe code is in `BridgeTest.probeVirtualDisplay()` and the MCP tool `android_probe_virtual_display`.

### 0.2 Context Acquisition

| Approach | Result |
|----------|--------|
| `ActivityThread.currentActivityThread()` | **Returns null** — UIAutomator process has no ActivityThread instance |
| `ActivityThread.systemMain()` | **Works** — returns a system Context + ContextImpl |
| `AppGlobals.getInitialApplication()` | Not needed; systemMain() sufficient |

The Context must be wrapped to claim `com.android.shell` identity:

```kotlin
val shellCtx = object : ContextWrapper(ctx) {
    override fun getPackageName() = "com.android.shell"
    override fun getOpPackageName() = "com.android.shell"
}
val dm = DisplayManager::class.java
    .getDeclaredConstructor(Context::class.java)
    .newInstance(shellCtx)
```

Without this wrapper: `SecurityException: packageName must match the owner uid`.

### 0.3 Required Display Flags

Minimal flags (`PUBLIC \| PRESENTATION \| OWN_CONTENT_ONLY`) cause the display to be created but **immediately destroyed by the system**. On the Android 17 probe device, the persistent display required the full Android 14+ flag set:

```
VIRTUAL_DISPLAY_FLAG_PUBLIC             = 1 << 0
VIRTUAL_DISPLAY_FLAG_PRESENTATION       = 1 << 1
VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY   = 1 << 3
VIRTUAL_DISPLAY_FLAG_SUPPORTS_TOUCH     = 1 << 6
VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT = 1 << 7
VIRTUAL_DISPLAY_FLAG_TRUSTED            = 1 << 10
VIRTUAL_DISPLAY_FLAG_OWN_DISPLAY_GROUP  = 1 << 11
VIRTUAL_DISPLAY_FLAG_ALWAYS_UNLOCKED    = 1 << 12
VIRTUAL_DISPLAY_FLAG_TOUCH_FEEDBACK_DISABLED = 1 << 13
VIRTUAL_DISPLAY_FLAG_OWN_FOCUS          = 1 << 14
VIRTUAL_DISPLAY_FLAG_DEVICE_DISPLAY_GROUP = 1 << 15
```

### 0.4 Display Persistence

VirtualDisplay and ImageReader references **must be held as class fields** in the bridge. Local variables go out of scope after the probe method returns, allowing GC to collect them. With strong references stored in `BridgeTest.probeDisplay` and `BridgeTest.probeImageReader`, the display persists.

### 0.5 Screenshot Capture — `screencap -d` NOT RELIABLE

`adb shell screencap -d <displayId> -p` fails with `Display Id 'N' is not valid` on Android 17 for **all** display IDs including 0. The `-d` flag is not universally supported.

**Conclusion:** ImageReader-based capture from the bridge is the primary path for virtual display screenshots. The first implementation should keep the existing display-0 `adb exec-out screencap -p` path and add bridge capture only for MCP-owned virtual displays.

### 0.6 App Launch — Shell Permission Denied

`adb shell am start --display <id>` fails with:
```
SecurityException: Permission Denial: starting Intent ... from null (uid=2000) with launchDisplayId=N
```

Shell UID cannot launch activities on non-default displays via the `am` command. The launch must be performed **inside the bridge** using the hidden `IActivityManager.startActivity()` API via reflection, with `ActivityOptions.setLaunchDisplayId(displayId)`.

### 0.7 No Existing UIAutomator + VirtualDisplay Implementations

A search across GitHub, StackOverflow, and uiautomator2 (the largest UIAutomator automation library) found **zero** existing implementations of virtual display creation from a UIAutomator instrumentation context. This is a novel integration point.

## Implementation Phases

All phase exit criteria below have been met on the API 37 reference emulator.

### Phase 1: Display Session Management + Virtual Screenshot

Start with the smallest end-to-end vertical slice: create a bridge-owned virtual display, keep it alive, and capture its frames through the bridge. Do not replace the default-display screenshot path in this phase.

**Approach for display 0:**
- Keep `adb exec-out screencap -p` in `server.ts`.
- Optionally add a private probe for `SurfaceControl.screenshot()` later, but do not make it part of the first virtual-display path.

**Approach for virtual displays:**
- Use `ImageReader.acquireLatestImage()` on the VD's attached ImageReader
- Convert `Image` to PNG bytes

**Shared output:**
- Bridge RPC response: `{ pngBase64, width, height, displayId, sessionId }`
- `android_screenshot` calls bridge `captureFrame` only when `sessionId` or non-zero `displayId` is provided
- Same file write path: `current-screen.png` in the temp directory

**Bridge method:**
```
captureFrame(displayId):
  displayId == 0 → unsupported in bridge for v1; desktop keeps ADB screencap
  displayId == N → ImageReader[displayId].acquireLatestImage() → PNG
```

**Exit criteria:**
- Create/list/destroy works on Android 14+.
- `android_screenshot` without a display target continues to return a valid display-0 PNG through the existing ADB path.
- `android_screenshot` with `sessionId` returns a valid virtual-display PNG through bridge RPC.
- Virtual screenshot dimensions match the target display.
- Screenshot file paths and return shape remain compatible with existing OCR and semantic-screen code.

### Phase 2: Launch App on Virtual Display

- Add a focused bridge probe for Android 14+ app launch on the virtual display.
- Resolve app launch intent via `PackageManager.getLaunchIntentForPackage()`.
- `ActivityOptions.makeBasic().setLaunchDisplayId(displayId)`.
- `Intent.FLAG_ACTIVITY_NEW_TASK`.
- Prefer `Context.startActivity(intent, options.toBundle())` if it works from the shell-owned bridge context.
- Fall back to Android 14-compatible hidden activity-manager reflection only if needed.
- Keep existing `monkey` launch as fallback only for display `0`.

**Exit criteria:**
- Launch Settings or another known app onto the virtual display.
- Confirm via `dumpsys activity activities` that the activity is on the target display.
- Physical display remains on launcher or another app.

### Phase 3: Observe Virtual Display

- Implement display-filtered compact tree with `UiAutomation.getWindows()`.
- For virtual displays, reject or omit XML dump until a display-scoped XML path exists.
- Thread display targeting through `android_get_semantic_screen`.
- Ensure screenshot, accessibility dump, OCR, and vision detection all use the same display target.

Exit criteria:

- `android_get_semantic_screen` returns screenshot dimensions matching the virtual display.
- Accessibility refs belong only to the virtual display.
- OCR fallback runs against the virtual display screenshot.

### Phase 4: Interact With Virtual Display

- Implement display-scoped tap/swipe/key using `InputManager`.
- Add display/session parameters to desktop input tools.
- Reject cross-display refs.

Exit criteria:

- Tap, swipe, back, and text entry work against an app on the virtual display while the physical display remains on a different app.

### Phase 5: Robustness and Recovery

- Add stale-session errors.
- Invalidate display-scoped snapshots on bridge reconnect.
- Add cleanup on explicit destroy and bridge exit.
- Document known Android/OEM limitations.

Exit criteria:

- Killing the bridge makes subsequent session calls fail clearly.
- Recreating a virtual display and relaunching the app restores operation.
- Default-display tools continue to behave as before.

### Deferred Work

- Replace display-0 screenshots with a bridge-side `SurfaceControl` pipeline after a dedicated Android 14+ probe confirms it is reliable.
- Support multiple MCP-owned virtual displays per device.
- Add a display-scoped XML dump if a reliable API path is found.
- Add explicit display IME policy controls after text entry behavior is verified.

## Test Plan

Unit or host-side checks:

- TypeScript input validation for `displayId` / `sessionId`.
- Snapshot/ref display binding.
- Stale-session error normalization.
- Default-display screenshot fallback remains unchanged when no display target is provided.

Android bridge checks:

- Build with `./gradlew :android-server:buildUiautomatorJar`.
- Create/list/destroy display.
- Capture virtual-display screenshot.
- Launch app to display.
- Inject tap/key to display.
- Dump accessibility for display.

Manual integration checks:

1. Start bridge.
2. Create `1024x768/240` virtual display.
3. Launch `com.android.settings` onto it.
4. Keep physical display on launcher or another app.
5. Capture semantic screen for the virtual display.
6. Tap a Settings item by ref.
7. Press Back on the virtual display.
8. Kill bridge process.
9. Confirm session calls return stale/bridge-restarted errors.
10. Recreate display and relaunch Settings.

Regression checks:

- `android_launch_app` without display target still launches on default display.
- Existing `android_tap_ref`, `android_input_text`, and `android_get_semantic_screen` still work on display `0`.
- `android_screenshot` default behavior and file paths remain unchanged.

## Open Questions

Resolved by Phase 0 probe:

- ✅ **Can `uiautomator runtest` create virtual displays?** Yes — confirmed on Android 17 emulator via `ActivityThread.systemMain()` + ContextWrapper("com.android.shell") + full flags.
- ✅ **Is `screencap -d <displayId>` reliable?** No — fails on Android 17 for all display IDs. ImageReader capture from bridge is the primary path.
- ✅ **Does shell `am start --display` work?** No — blocked by SecurityException for non-default displays. Must use bridge-side `IActivityManager.startActivity()` with `ActivityOptions.setLaunchDisplayId()`.

Still open:

- OEM compatibility beyond the API 37 reference emulator remains device-dependent.
- `SurfaceControl.screenshot()` for display 0 remains deferred; display 0 intentionally keeps ADB screencap.

Resolved during implementation:

- Virtual display accessibility is available through `getWindowsOnAllDisplays()` after enabling `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`.
- `destroyContentOnRemoval` defaults to true and remains configurable.
- Display-scoped input works through `InputManagerGlobal`/`IInputManager` with `InputEvent.setDisplayId()`.
- `Context.startActivity(intent, options)` works on the reference emulator, with activity-manager reflection retained as fallback.
- Display IME policy is configurable through the `IWindowManager` binder.

## Recommended Defaults

- Support one MCP-owned virtual display per device in the first implementation.
- Default size: `1280x960`.
- Default density: `160` unless the caller provides one.
- Default `systemDecorations`: true.
- Default `destroyContentOnRemoval`: true.
- Default IME policy: leave system default; callers may explicitly select local or fallback policy.
- Treat Android 14 as the minimum supported version for headless operation.
