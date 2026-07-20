import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { __test } from "../src/server.ts";

const node = (overrides) => ({ id: "n", bounds: [0, 0, 100, 40], center: [50, 20], source: "accessibility", ...overrides });

test("semantic ranking prioritizes editable action targets", () => {
  const ranked = __test.rankSemanticNodes([
    node({ id: "label", text: "Label" }),
    node({ id: "field", className: "android.widget.EditText", actions: ["set_text"], clickable: true })
  ]);
  assert.equal(ranked[0].id, "field");
  assert.equal(ranked[0].role, "textbox");
  assert.equal(ranked[0].editable, true);
});

test("semantic merge deduplicates OCR overlapping accessibility text", () => {
  const merged = __test.mergeSemanticNodes(
    [node({ id: "a", text: "Settings" })],
    [node({ id: "o", text: "Settings", source: "ocr", confidence: 90 })],
    [],
    10
  );
  assert.equal(merged.filter((item) => item.text === "Settings").length, 1);
  assert.equal(merged[0].source, "accessibility");
});

test("compact accessibility metadata survives semantic conversion", () => {
  const [item] = __test.compactNodes({
    nodes: [{
      text: "Wi-Fi",
      bounds: "[0,120][1080,220]",
      clickable: true,
      checkable: true,
      checked: false,
      depth: 4,
      windowIndex: 1,
      collectionScope: 2,
      collectionItem: { rowIndex: 3, rowSpan: 1, columnIndex: 0, columnSpan: 1, heading: false }
    }]
  });
  assert.equal(item.depth, 4);
  assert.equal(item.windowIndex, 1);
  assert.equal(item.collectionScope, 2);
  assert.equal(item.collectionItem.rowIndex, 3);
  assert.equal(item.checked, false);
});

test("UI outline zones nodes, assigns scoped list aliases, and preserves refs compactly", () => {
  const nodes = __test.mergeSemanticNodes([
    node({ id: "title", text: "Settings", bounds: [20, 20, 400, 100], center: [210, 60] }),
    node({ id: "wifi", text: "Network & internet", clickable: true, bounds: [20, 300, 1000, 420], center: [510, 360], collectionScope: 1, collectionItem: { rowIndex: 0, rowSpan: 1, columnIndex: 0, columnSpan: 1 } }),
    node({ id: "apps", text: "Apps", clickable: true, bounds: [20, 440, 1000, 560], center: [510, 500], collectionScope: 1, collectionItem: { rowIndex: 1, rowSpan: 1, columnIndex: 0, columnSpan: 1 } }),
    node({ id: "save", text: "Save", clickable: true, className: "android.widget.Button", bounds: [800, 2200, 1040, 2320], center: [920, 2260] }),
    node({ id: "dialog", text: "Allow", clickable: true, className: "android.widget.Button", bounds: [360, 900, 720, 1020], center: [540, 960], windowIndex: 1 })
  ], [], [], 20);
  const snapshot = { deviceId: "test", displayId: 0, snapshotId: "s", screenSignature: "x", actionableSignature: "y", width: 1080, height: 2400, nodes, nodeCount: nodes.length };
  const rendered = __test.renderUiOutline(snapshot, 20);
  assert.match(rendered.outline, /^\[Window 2\]/);
  assert.match(rendered.outline, /\[Top\]/);
  assert.match(rendered.outline, /\[Content\]/);
  assert.match(rendered.outline, /\[Bottom\]/);
  assert.match(rendered.outline, /#1 button \"Network & internet\"/);
  assert.match(rendered.outline, /#2 button \"Apps\"/);
  for (const item of nodes.filter((value) => value.clickable)) {
    assert.match(rendered.outline, new RegExp(`\\b${item.ref}\\b`));
  }
  assert.ok(rendered.outline.length <= JSON.stringify(nodes).length * 0.5);
});

test("UI outline line limit prioritizes actionable nodes", () => {
  const snapshot = {
    deviceId: "test", displayId: 0, snapshotId: "s", screenSignature: "x", actionableSignature: "y", width: 100, height: 200,
    nodes: [node({ ref: "a1", text: "Passive" }), node({ ref: "a2", text: "Action", clickable: true })], nodeCount: 2
  };
  const rendered = __test.renderUiOutline(snapshot, 1);
  assert.match(rendered.outline, /a2/);
  assert.doesNotMatch(rendered.outline, /a1/);
  assert.equal(rendered.truncated, true);
});

test("UI outline retains unlabeled actionable accessibility refs", () => {
  const snapshot = {
    deviceId: "test", displayId: 0, snapshotId: "s", screenSignature: "x", actionableSignature: "y", width: 100, height: 200,
    nodes: [node({ ref: "a1", text: undefined, clickable: true })], nodeCount: 1
  };
  const rendered = __test.renderUiOutline(snapshot, 10);
  assert.match(rendered.outline, /a1 element \"unlabeled\" \[clickable\]/);
});

test("UI outline tool schema defaults to a compact response", () => {
  const tool = __test.toolDefinition("android_get_ui_outline");
  assert.equal(tool.inputSchema.properties.includeScreenshot.default, false);
  assert.equal(tool.inputSchema.properties.includeEntries.default, false);
  assert.equal(tool.inputSchema.properties.maxLines.default, 80);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test("Viewer companion tools are debug-scoped and safe by default", () => {
  const start = __test.toolDefinition("android_viewer_start");
  assert.equal(__test.capabilityGroupForTool("android_viewer_start"), "debug");
  assert.equal(start.inputSchema.properties.port.default, 0);
  assert.equal(start.inputSchema.properties.allowActions.default, false);
  assert.equal(__test.toolDefinition("android_viewer_status").inputSchema.additionalProperties, false);
  assert.equal(__test.toolDefinition("android_viewer_stop").inputSchema.additionalProperties, false);
});

test("stale ref relocation rejects ambiguous duplicate text", () => {
  const original = node({ id: "old", text: "Allow", role: "button", className: "android.widget.Button" });
  const relocated = __test.relocateAccessibilityNode(original, [
    node({ id: "one", text: "Allow", role: "button", className: "android.widget.Button" }),
    node({ id: "two", text: "Allow", role: "button", className: "android.widget.Button", bounds: [0, 50, 100, 90] })
  ]);
  assert.equal(relocated.status, "stale_ref_ambiguous");
  assert.equal(relocated.candidates.length, 2);
});

test("after conditions require a real condition", () => {
  assert.equal(__test.afterConditions({}), undefined);
  assert.throws(() => __test.afterConditions({ after: {} }), /waitForText/);
  assert.equal(__test.afterConditions({ after: { waitForPackage: "example" } }).waitForPackage, "example");
});

test("capability groups and trace sanitization are deterministic", () => {
  assert.equal(__test.capabilityGroupForTool("android_trace_start"), "trace");
  assert.equal(__test.capabilityGroupForTool("android_ocr_screen"), "ocr");
  assert.equal(__test.capabilityGroupForTool("android_launch_app"), "apps");
  assert.deepEqual(__test.sanitizeTraceValue({ text: "secret", pngBase64: "abc" }), { text: "[redacted:6]", pngBase64: "[omitted]" });
  assert.deepEqual(__test.sanitizeTraceValue({ url: "http://127.0.0.1:1234/#token=secret" }), { url: "http://127.0.0.1:1234/#token=[redacted]" });
});

test("trace lifecycle writes sanitized local events", async () => {
  const traceId = `unit-${process.pid}-${Date.now()}`;
  const started = await __test.androidTraceStart({ traceId });
  await __test.recordTraceEvent("android_input_text", { text: "secret" }, { success: true }, undefined, 12);
  const status = await __test.androidTraceStatus();
  assert.equal(status.status, "trace_active");
  assert.equal(status.step, 1);
  const stopped = await __test.androidTraceStop();
  assert.equal(stopped.status, "trace_stopped");
  assert.equal(stopped.stepCount, 1);
  const events = await readFile(`${started.directory}/events.jsonl`, "utf8");
  assert.match(events, /\[redacted:6\]/);
  assert.doesNotMatch(events, /secret/);
});
