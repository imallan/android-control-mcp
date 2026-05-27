#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SDK_ROOT=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/Volumes/数据/Android/sdk}}
PLATFORM=${ANDROID_PLATFORM:-android-36}
BUILD_TOOLS=${ANDROID_BUILD_TOOLS:-37.0.0}

ANDROID_JAR="$SDK_ROOT/platforms/$PLATFORM/android.jar"
UIAUTOMATOR_JAR="$SDK_ROOT/platforms/$PLATFORM/uiautomator.jar"
D8="$SDK_ROOT/build-tools/$BUILD_TOOLS/d8"

OUT_DIR="$ROOT_DIR/build"
CLASSES_DIR="$OUT_DIR/classes"
DEX_DIR="$OUT_DIR/dex"
RAW_JAR="$OUT_DIR/android-ui-server-classes.jar"
FINAL_JAR="$OUT_DIR/android-ui-server.jar"
SOURCES_FILE="$OUT_DIR/sources.txt"
STUB_DIR="$OUT_DIR/stubs"

rm -rf "$OUT_DIR"
mkdir -p "$CLASSES_DIR" "$DEX_DIR" "$STUB_DIR/junit/framework"
find "$ROOT_DIR/src" -name '*.java' | sort | sed "s/'/'\\\\''/g; s/.*/'&'/" > "$SOURCES_FILE"
cat > "$STUB_DIR/junit/framework/TestCase.java" <<'EOF'
package junit.framework;

public class TestCase {
  protected void setUp() throws Exception {}
  protected void tearDown() throws Exception {}
}
EOF
printf "'%s'\n" "$STUB_DIR/junit/framework/TestCase.java" >> "$SOURCES_FILE"

javac \
  -source 8 \
  -target 8 \
  -bootclasspath "$ANDROID_JAR" \
  -classpath "$UIAUTOMATOR_JAR" \
  -d "$CLASSES_DIR" \
  @"$SOURCES_FILE"

rm -rf "$CLASSES_DIR/junit"
jar cf "$RAW_JAR" -C "$CLASSES_DIR" .
"$D8" \
  --classpath "$ANDROID_JAR" \
  --classpath "$UIAUTOMATOR_JAR" \
  --min-api 23 \
  --output "$DEX_DIR" \
  "$RAW_JAR"

jar cf "$FINAL_JAR" -C "$DEX_DIR" classes.dex
printf '%s\n' "$FINAL_JAR"
