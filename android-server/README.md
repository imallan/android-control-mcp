# Android Server

Placeholder for Phase 2.

The target implementation is a Kotlin/JVM jar pushed to `/data/local/tmp/` and started as shell uid:

```sh
adb push android-ui-server.jar /data/local/tmp/
adb shell CLASSPATH=/data/local/tmp/android-ui-server.jar app_process / com.example.androiduiserver.Main
```

It will create:

```kotlin
LocalServerSocket("android-ui-mcp")
```

The desktop side will connect through:

```sh
adb forward tcp:27183 localabstract:android-ui-mcp
```
