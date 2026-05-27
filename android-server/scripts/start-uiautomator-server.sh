#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JAR_PATH=${1:-"$ROOT_DIR/build/android-ui-server.jar"}
DEVICE_JAR=/data/local/tmp/android-ui-server.jar
HOST_PORT=${ANDROID_UI_MCP_PORT:-27183}

adb push "$JAR_PATH" "$DEVICE_JAR" >/dev/null
adb forward "tcp:$HOST_PORT" localabstract:android-ui-mcp >/dev/null

exec adb shell uiautomator runtest "$DEVICE_JAR" \
  -c com.example.androiduiserver.BridgeTest#testServe
