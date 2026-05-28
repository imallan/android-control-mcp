#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if [ "${ANDROID_SERIAL:-}" = "" ]; then
  devices="$(
    adb devices |
      awk 'NR > 1 && $2 == "device" { print $1 }'
  )"
  device_count="$(printf '%s\n' "$devices" | awk 'NF { count++ } END { print count + 0 }')"

  case "$device_count" in
    0)
      echo "android-ui-mcp: no authorized Android devices found. Connect a device or set ANDROID_SERIAL." >&2
      exit 1
      ;;
    1)
      ANDROID_SERIAL="$(printf '%s\n' "$devices" | awk 'NF { print; exit }')"
      export ANDROID_SERIAL
      ;;
    *)
      echo "android-ui-mcp: multiple Android devices found. Set ANDROID_SERIAL to choose one:" >&2
      printf '%s\n' "$devices" >&2
      exit 1
      ;;
  esac
fi

exec node "$repo_dir/desktop-mcp/src/server.ts"
