import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";

const deviceId = process.env.ANDROID_SERIAL;
if (!deviceId) throw new Error("Set ANDROID_SERIAL to an Android 14+ device serial.");

// Start from a deterministic task state; Settings otherwise restores its last search activity.
execFileSync("adb", ["-s", deviceId, "shell", "am", "force-stop", "com.android.settings"]);
execFileSync("adb", ["-s", deviceId, "shell", "am", "force-stop", "com.google.android.settings.intelligence"]);

const server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url), stdio: ["pipe", "pipe", "inherit"] });
const lines = readline.createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;

lines.on("line", (line) => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (entry) {
    pending.delete(response.id);
    entry.resolve(response);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool(name, arguments_, expectError = false) {
  const response = await request("tools/call", { name, arguments: { deviceId, ...arguments_ } });
  assert.equal(Boolean(response.result?.isError), expectError, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

let sessionId;
try {
  await request("initialize");
  const physical = await tool("android_screenshot", {});
  assert.equal(physical.displayId, 0);
  assert.ok(physical.width > 0 && physical.height > 0);
  const physicalBefore = await tool("android_current_app", {});

  const created = await tool("android_create_virtual_display", {
    width: 1024,
    height: 768,
    dpi: 240,
    displayImePolicy: 0
  });
  sessionId = created.sessionId;
  assert.equal(created.success, true);
  assert.equal(created.displayImePolicyApplied, true);
  const displays = await tool("android_list_displays", {});
  assert.ok(displays.displays.some((display) => display.sessionId === sessionId && display.mcpOwned === true));

  const launched = await tool("android_launch_app", { sessionId, applicationId: "com.android.settings" });
  assert.equal(launched.displayId, created.displayId);
  const physicalAfterVirtualLaunch = await tool("android_current_app", {});
  assert.equal(physicalAfterVirtualLaunch.packageName, physicalBefore.packageName);
  const wait = await tool("android_wait_for_package", { sessionId, packageName: "com.android.settings", timeoutMs: 5000 });
  assert.equal(wait.success, true);

  const screenshot = await tool("android_screenshot", { sessionId, timeoutMs: 5000 });
  assert.deepEqual([screenshot.width, screenshot.height], [1024, 768]);
  const ocr = await tool("android_ocr_screen", { sessionId, ocrEngine: "apple-vision", maxNodes: 10 });
  assert.equal(ocr.sessionId, sessionId);
  assert.deepEqual([ocr.width, ocr.height], [1024, 768]);

  const semantic = await tool("android_get_semantic_screen", {
    sessionId,
    ocrMode: "off",
    visionMode: "off",
    includeScreenshot: false,
    maxNodes: 80
  });
  assert.equal(semantic.sessionId, sessionId);
  assert.ok(semantic.accessibilityNodeCount > 0);
  const search = semantic.nodes.find((node) => node.resourceId === "com.android.settings:id/search_action_bar");
  assert.ok(search?.ref);

  const tapped = await tool("android_tap_ref", { sessionId, snapshotId: semantic.snapshotId, ref: search.ref, stableTimeoutMs: 2500 });
  assert.equal(tapped.success, true);
  const searchReady = await tool("android_wait_for_text", {
    sessionId,
    text: "Search settings",
    role: "textbox",
    timeoutMs: 5000,
    pollIntervalMs: 200
  });
  assert.equal(searchReady.success, true);
  const textbox = searchReady.currentSnapshot.nodes.find((node) => node.editable === true);
  assert.ok(textbox?.ref);
  const filled = await tool("android_fill_ref", {
    sessionId,
    snapshotId: searchReady.currentSnapshot.snapshotId,
    ref: textbox.ref,
    text: "battery",
    stableTimeoutMs: 2500
  });
  assert.equal(filled.success, true);
  await tool("android_key", { sessionId, key: "BACK" });
  await tool("android_swipe", { sessionId, x1: 512, y1: 650, x2: 512, y2: 250, durationMs: 300 });

  const mismatch = await tool("android_tap_ref", {
    displayId: 0,
    snapshotId: semantic.snapshotId,
    ref: search.ref,
    returnSnapshot: false
  });
  assert.equal(mismatch.status, "ref_not_found");

  const replaced = await tool("android_create_virtual_display", { width: 800, height: 600, dpi: 160 });
  const recreatedError = await tool("android_screenshot", { sessionId }, true);
  assert.equal(recreatedError.data.status, "virtual_display_recreated");
  sessionId = replaced.sessionId;

  await tool("android_bridge_exit", {});
  const restartError = await tool("android_screenshot", { sessionId }, true);
  assert.equal(restartError.data.status, "bridge_restarted");
  sessionId = undefined;

  await tool("android_launch_app", { applicationId: "com.android.settings" });
  const defaultWait = await tool("android_wait_for_package", { packageName: "com.android.settings", timeoutMs: 5000 });
  assert.equal(defaultWait.success, true);
  const defaultSemantic = await tool("android_get_semantic_screen", {
    ocrMode: "off",
    visionMode: "off",
    includeScreenshot: false,
    maxNodes: 80
  });
  assert.equal(defaultSemantic.displayId, 0);
  assert.ok(defaultSemantic.accessibilityNodeCount > 0);
  const defaultSearch = defaultSemantic.nodes.find((node) => node.resourceId === "com.android.settings:id/search_action_bar");
  assert.ok(defaultSearch?.ref);
  const defaultTapped = await tool("android_tap_ref", {
    snapshotId: defaultSemantic.snapshotId,
    ref: defaultSearch.ref,
    stableTimeoutMs: 2500
  });
  assert.equal(defaultTapped.success, true);
  const defaultSearchReady = await tool("android_wait_for_text", {
    text: "Search settings",
    role: "textbox",
    timeoutMs: 5000,
    pollIntervalMs: 200
  });
  assert.equal(defaultSearchReady.success, true);
  const defaultTextbox = defaultSearchReady.currentSnapshot.nodes.find((node) => node.editable === true);
  assert.ok(defaultTextbox?.ref);
  const defaultFilled = await tool("android_fill_ref", {
    snapshotId: defaultSearchReady.currentSnapshot.snapshotId,
    ref: defaultTextbox.ref,
    text: "battery",
    stableTimeoutMs: 2500
  });
  assert.equal(defaultFilled.success, true);
  await tool("android_key", { key: "BACK" });

  const destroyTarget = await tool("android_create_virtual_display", { width: 800, height: 600, dpi: 160 });
  await tool("android_destroy_virtual_display", { sessionId: destroyTarget.sessionId });
  const destroyedError = await tool("android_screenshot", { sessionId: destroyTarget.sessionId }, true);
  assert.equal(destroyedError.data.status, "virtual_display_not_found");

  process.stdout.write("headless virtual display e2e: PASS\n");
} finally {
  if (sessionId) {
    await tool("android_destroy_virtual_display", { sessionId }).catch(() => undefined);
  }
  server.kill();
}
