# OCR/CV Fallback Plan

## Summary

Add a local vision fallback to the Android MCP for apps whose accessibility tree is empty or too sparse, such as WeChat. The default strategy is to prefer the accessibility tree and run OCR/CV only when the tree is not useful. The result returned to the LLM should be a compact list of actionable nodes, not the whole image or raw OCR text.

Confirmed local dependencies:

- `tesseract`
- OCR language packs: `chi_sim`, `chi_tra`, and `eng`
- Apple Vision through a local Swift helper on macOS
- macOS `sips` for lightweight crop and resize operations
- No current Python CV, PIL, or OpenCV dependency; v1 should avoid large model or Python image-stack requirements

## Tools

### `android_get_semantic_screen`

Runs screenshot capture, compact accessibility dump, sparse-tree detection, and OCR fallback when needed.

Example response:

```json
{
  "imagePath": "/tmp/android-ui-mcp/current-screen.png",
  "width": 1440,
  "height": 3120,
  "treeUsable": false,
  "nodes": [
    {
      "id": "ocr:12",
      "text": "Search",
      "bounds": [1270, 155, 1406, 291],
      "center": [1338, 223],
      "clickable": true,
      "source": "ocr",
      "confidence": 87
    }
  ]
}
```

Defaults:

- Return at most 80 nodes.
- Truncate long text to 80 characters.
- Filter out low-confidence OCR results.
- Do not include raw XML or raw OCR output unless explicitly requested for debugging.

### `android_ocr_screen`

Debug and special-case tool that runs OCR directly.

Input:

```json
{
  "roi": [0, 0, 1440, 3120],
  "langs": "chi_sim+eng",
  "maxNodes": 80,
  "minConfidence": 45,
  "retain": false
}
```

Full-screen OCR should work by default, but agents should pass a region of interest when possible to reduce latency and token output.

## Sparse-Tree Detection

Treat the accessibility tree as sparse when any of these are true:

- The XML contains only the root node.
- The compact tree has fewer than 3 useful text or content-description nodes.
- The current package is a known weak-accessibility app, such as `com.tencent.mm`.
- The tree has nodes but no readable or actionable nodes.

## Local OCR Implementation

The initial implementation uses Tesseract TSV output:

```sh
tesseract image stdout -l chi_sim+eng --psm 6 tsv
```

Parse these TSV fields:

- `text`
- `conf`
- `left`
- `top`
- `width`
- `height`

Use `sips` to create ROI crops. By default, temporary crops should overwrite:

```text
/tmp/android-ui-mcp/ocr-crop.png
```

When `retain: true`, keep screenshots and crops in a unique temp directory.

The Apple Vision implementation uses `desktop-mcp/apple-vision-ocr.swift`, compiled on first use with `swiftc`. It returns JSON nodes with text, confidence, and pixel bounds. Apple Vision is the default OCR backend. For Chinese UI screenshots, `langs: "chi_sim+eng"` is mapped to Apple Vision's `zh-Hans` because mixed `zh-Hans,en-US` recognition produced worse Chinese output in early testing.

## Performance And Token Strategy

- Return compact nodes only, not complete OCR prose.
- Merge adjacent words on the same line into phrases.
- Filter tiny nodes, low-confidence nodes, and obvious OCR noise.
- Deduplicate repeated text and highly overlapping bounds.
- Prefer OCR over targeted regions such as the top bar, bottom navigation, and visible content area.
- Use full-screen OCR only when targeted OCR is insufficient.
- Cache the last OCR result by screenshot path and modification time. This is planned, not implemented in the initial version.
- Invalidate the cache after any action that changes UI state. This is planned, not implemented in the initial version.

## Test Plan

WeChat:

- Launch `com.tencent.mm`.
- Confirm `android_dump_tree` is sparse.
- Confirm `android_get_semantic_screen` triggers OCR fallback.
- Confirm returned OCR nodes are readable and below the default node limit.

Xiaohongshu:

- Confirm the accessibility tree is usable.
- Confirm `android_get_semantic_screen` prefers accessibility nodes.
- Confirm OCR does not run by default unless `forceOcr: true` is passed.

Gmail:

- Confirm the accessibility tree is usable.
- Confirm search, compose, and bottom-tab nodes appear in merged semantic output.

Performance:

- Confirm the tree-usable path does not run OCR.
- Confirm ROI OCR is faster than full-screen OCR.
- Confirm consecutive unchanged screenshots hit the OCR cache.

## Assumptions

- v1 runs completely locally and does not upload screenshots.
- v1 does not add OpenCV, PaddleOCR, YOLO, or cloud OCR.
- CV object detection can be a later optional phase, disabled by default.
- For weak-accessibility apps, the fallback goal is to read visible text and estimate click positions, not reconstruct the full view tree.
- The most reliable click strategy remains: prefer accessibility bounds; use OCR bounds centers only when accessibility nodes are unavailable.
