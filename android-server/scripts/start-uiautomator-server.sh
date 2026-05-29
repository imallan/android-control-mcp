#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_FIRST=0
JAR_PATH=
DEVICE_JAR=/data/local/tmp/android-ui-server.jar
HOST_PORT=${ANDROID_UI_MCP_PORT:-27183}

usage() {
  cat >&2 <<EOF
Usage: $0 [--build] [jar-path]

Options:
  -b, --build   Build the UIAutomator jar before starting the bridge.
  -h, --help    Show this help.

If jar-path is omitted, the script uses:
  $ROOT_DIR/build/android-ui-server.jar
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -b|--build)
      BUILD_FIRST=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [ "$JAR_PATH" != "" ]; then
        echo "Unexpected extra argument: $1" >&2
        usage
        exit 2
      fi
      JAR_PATH=$1
      shift
      ;;
  esac
done

if [ "$#" -gt 0 ]; then
  if [ "$JAR_PATH" != "" ] || [ "$#" -gt 1 ]; then
    echo "Unexpected extra argument: $1" >&2
    usage
    exit 2
  fi
  JAR_PATH=$1
fi

if [ "$JAR_PATH" = "" ]; then
  JAR_PATH="$ROOT_DIR/build/android-ui-server.jar"
fi

if [ "$BUILD_FIRST" -eq 1 ]; then
  "$ROOT_DIR/scripts/build-uiautomator-jar.sh"
fi

adb push "$JAR_PATH" "$DEVICE_JAR" >/dev/null
adb forward "tcp:$HOST_PORT" localabstract:android-ui-mcp >/dev/null

exec adb shell uiautomator runtest "$DEVICE_JAR" \
  -c com.example.androiduiserver.BridgeTest#testServe
