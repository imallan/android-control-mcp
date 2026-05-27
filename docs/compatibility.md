# Compatibility Notes

- `uiautomator dump` exposes the accessibility/semantics tree, not the full rendered view tree.
- Jetpack Compose internals, WebView content, OpenGL surfaces, games, and video may be partially or completely absent from the accessibility tree.
- `FLAG_SECURE` can block screenshots and produce black images.
- OEM ROMs may alter shell output, break `uiautomator`, or restrict input injection.
- `adb shell input text` is not a robust Unicode input method on all devices.
