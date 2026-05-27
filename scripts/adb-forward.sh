#!/usr/bin/env sh
set -eu

adb forward tcp:27183 localabstract:android-ui-mcp
