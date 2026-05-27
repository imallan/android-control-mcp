# OCR/CV Fallback 设计计划

## Summary

为 Android MCP 增加本地视觉 fallback，用于微信这类 accessibility tree 为空或过稀疏的页面。默认策略是：优先用 accessibility tree；只有 tree 不够用时才触发本地 OCR/CV；返回给 LLM 的不是整图或完整 OCR 文本，而是精简后的可操作节点列表，控制 token 和延迟。

本机已确认可用：

- `tesseract`
- 中文/英文语言包：`chi_sim`、`chi_tra`、`eng`
- macOS `sips` 可做轻量裁剪/缩放
- 当前无 Python CV/PIL/OpenCV 依赖，所以 v1 不引入大模型或 Python 图像栈

## Key Changes

- 新增 MCP tool：`android_get_semantic_screen`
  - 内部执行：screenshot + dump tree + sparse-tree 检测 + OCR fallback
  - 返回统一节点：

```json
{
  "imagePath": "...",
  "width": 1440,
  "height": 3120,
  "treeUsable": false,
  "nodes": [
    {
      "id": "ocr:12",
      "text": "搜索",
      "bounds": [1270, 155, 1406, 291],
      "center": [1338, 223],
      "clickable": true,
      "source": "ocr|accessibility|merged",
      "confidence": 87
    }
  ]
}
```

  - 默认最多返回 `80` 个节点；长文本截断到 `80` 字符；低置信度 OCR 默认过滤。

- 新增 MCP tool：`android_ocr_screen`
  - 面向调试和特殊场景，只跑 OCR。
  - 参数：

```json
{
  "roi": [x1, y1, x2, y2],
  "langs": "chi_sim+eng",
  "maxNodes": 80,
  "minConfidence": 45,
  "retain": false
}
```

  - 默认 OCR 全屏，但推荐由 agent 传 ROI，减少延迟和 token。

- sparse-tree 判定规则：
  - XML 只有根节点，或有效 text/content-desc 节点少于 `3`
  - 当前 package 属于已知弱 accessibility app，例如 `com.tencent.mm`
  - tree 有节点但无可点击/可读节点时，也触发 OCR

- 本地 OCR 实现：
  - 使用 `tesseract image stdout -l chi_sim+eng --psm 6 tsv`
  - 解析 TSV 的 `text/conf/left/top/width/height`
  - 用 `sips` 生成 ROI 临时图，默认覆盖 `/tmp/android-ui-mcp/ocr-crop.png`
  - `retain:true` 时才保留唯一截图/裁剪图

## Performance And Token Strategy

- 默认不把 OCR 原文整段返回，只返回去重、合并、排序后的节点。
- OCR 结果合并规则：
  - 同一行相邻文字块合并为 phrase
  - 太小、太低置信度、纯噪声节点过滤
  - 重复文本和高度重叠 bounds 去重
- 默认优先跑顶部栏、底部导航、中心内容三类 ROI；全屏 OCR 只在必要时使用。
- 缓存最近一次 screenshot 的 OCR 结果：
  - 如果 image path 和 mtime 未变，直接复用 OCR nodes
  - 执行动作后缓存失效
- token 控制：
  - `android_get_semantic_screen` 默认返回节点，不返回 XML
  - 需要调试时才允许 `includeRawTree` 或 `includeRawOcr`
  - 大字段默认关闭

## Test Plan

- 微信：
  - launch `com.tencent.mm`
  - `android_dump_tree` 只有根节点
  - `android_get_semantic_screen` 自动触发 OCR fallback
  - 返回可读 OCR nodes，且不超过默认节点上限

- 小红书：
  - accessibility tree 可用
  - `android_get_semantic_screen` 优先使用 tree nodes
  - 不默认跑 OCR，除非 `forceOcr:true`

- Gmail：
  - tree 可用
  - 搜索框、写邮件按钮、底部 tab 能进入 merged nodes

- Performance:
  - tree 可用路径不跑 OCR
  - ROI OCR 明显快于全屏 OCR
  - 连续两次无变化截图命中缓存

## Assumptions

- v1 完全本地运行，不调用云 OCR，不上传截图。
- v1 不引入 OpenCV/PaddleOCR/YOLO；先用 Tesseract + lightweight heuristics。
- 真正的 CV object detection 作为 Phase 2，可选接入本地模型，但默认关闭。
- 对微信这类页面，fallback 目标是“能读出文字和估算点击位置”，不是还原完整 View tree。
- 最稳点击策略仍是：优先 accessibility bounds；没有 tree 时使用 OCR bounds center。
