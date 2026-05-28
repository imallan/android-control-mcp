# Android Server

Phase 2 prototype: a persistent UIAutomator process that exposes a newline-delimited JSON
RPC socket from inside Android's UIAutomator test runtime.

This is intentionally closer to Android UIAutomator test performance than the Phase 1
desktop loop:

```text
desktop MCP -> adb shell uiautomator dump
```

The prototype starts once with `uiautomator runtest`, keeps `UiDevice` alive, and serves
commands over `localabstract:android-ui-mcp`.

## Build

```sh
android-server/scripts/build-uiautomator-jar.sh
```

The script delegates to the repository Gradle wrapper:

```sh
./gradlew :android-server:buildUiautomatorJar
```

The Gradle task still uses the local Android SDK directly:

- `platforms/android-36/android.jar`
- `platforms/android-36/uiautomator.jar`
- `build-tools/37.0.0/d8`
- Android Studio's bundled Kotlin compiler by default:
  `/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc`

Override with:

```sh
ANDROID_SDK_ROOT=/path/to/sdk ANDROID_PLATFORM=android-36.1 ANDROID_BUILD_TOOLS=36.1.0 KOTLINC=/path/to/kotlinc \
  android-server/scripts/build-uiautomator-jar.sh
```

## Start

In one terminal:

```sh
android-server/scripts/start-uiautomator-server.sh
```

This does:

```sh
adb push android-server/build/android-ui-server.jar /data/local/tmp/android-ui-server.jar
adb forward tcp:27183 localabstract:android-ui-mcp
adb shell uiautomator runtest /data/local/tmp/android-ui-server.jar \
  -c com.example.androiduiserver.BridgeTest#testServe
```

## Try RPC

In another terminal:

```sh
node android-server/client/rpc.mjs ping
node android-server/client/rpc.mjs dumpCompact
node android-server/client/rpc.mjs swipe x1=720 y1=2600 x2=720 y2=850 steps=24
node android-server/client/rpc.mjs tap x=720 y=1200
node android-server/client/rpc.mjs key key=BACK
node android-server/client/rpc.mjs inputText text=Promotion targetText=Search
node android-server/client/rpc.mjs performAction action=long_click targetText=Search
```

Responses include Android-side `elapsedMs` and the client-side `hostElapsedMs`.

Example smoke test from this repository/device:

```json
{
  "ok": true,
  "nodeCount": 81,
  "elapsedMs": 40,
  "hostElapsedMs": 44
}
```

## Protocol

Requests are one JSON object per line:

```json
{"method":"dumpCompact"}
```

Responses are one JSON object per line:

```json
{"ok":true,"packageName":"com.xingin.xhs","width":1440,"height":3120,"nodes":[],"nodeCount":0,"elapsedMs":432}
```

Supported methods:

- `ping`
- `dumpCompact`
- `dumpXml`
- `tap`
- `inputText`
- `performAction`
- `swipe`
- `key`
- `exit`

## Why this is faster

This removes repeated `adb shell` process startup and avoids writing dumps to
`/sdcard/window.xml`. `dumpCompact` directly traverses `AccessibilityNodeInfo` inside the
same persistent UIAutomator process and returns only compact node fields.

`dumpXml` is kept only as a compatibility/debug method. It still uses
`UiDevice.dumpWindowHierarchy`, so it is slower and less reliable on modern Android builds
than `dumpCompact`.
