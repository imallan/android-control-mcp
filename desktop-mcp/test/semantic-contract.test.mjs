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
