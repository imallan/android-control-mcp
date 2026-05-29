# Compatibility Notes

- `uiautomator dump` exposes the accessibility/semantics tree, not the full rendered view tree.
- Jetpack Compose internals, WebView content, OpenGL surfaces, games, and video may be partially or completely absent from the accessibility tree.
- `FLAG_SECURE` can block screenshots and produce black images.
- OEM ROMs may alter shell output, break `uiautomator`, or restrict input injection.
- Accessibility `ACTION_SET_TEXT` is more reliable than `adb shell input text`, but text input still depends on each target node supporting editable accessibility actions.
- Apps with sparse accessibility trees can use OCR fallback for visible text and estimated click centers, but icon-only controls and visual grouping are not detected yet.
