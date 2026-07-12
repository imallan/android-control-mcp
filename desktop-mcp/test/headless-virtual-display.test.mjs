import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/server.ts";

test("display targeting accepts exactly one identity", () => {
  assert.deepEqual(__test.displayTargetParams({}), {});
  assert.deepEqual(__test.displayTargetParams({ sessionId: "vd-1" }), { sessionId: "vd-1" });
  assert.deepEqual(__test.displayTargetParams({ displayId: 3 }), { displayId: 3 });
  assert.throws(() => __test.displayTargetParams({ sessionId: "vd-1", displayId: 3 }), /only one/);
  assert.throws(() => __test.displayTargetParams({ displayId: -1 }), /non-negative integer/);
});

test("snapshot identity includes display session", () => {
  const compact = { displayId: 3, sessionId: "vd-1", width: 100, height: 100, packageName: "example", nodes: [] };
  const first = __test.createSemanticSnapshot("device", compact, []);
  const second = __test.createSemanticSnapshot("device", { ...compact, sessionId: "vd-2" }, []);
  assert.equal(first.displayId, 3);
  assert.equal(first.sessionId, "vd-1");
  assert.notEqual(first.snapshotId.split(":")[2], second.snapshotId.split(":")[2]);
});

test("bridge restart marks owned sessions stale", () => {
  __test.activeVirtualSessions.clear();
  __test.staleVirtualSessions.clear();
  __test.activeVirtualSessions.set("vd-1", "device-a");
  __test.activeVirtualSessions.set("vd-2", "device-b");
  __test.invalidateVirtualSessions("device-a", "bridge_restarted");
  assert.equal(__test.activeVirtualSessions.has("vd-1"), false);
  assert.equal(__test.activeVirtualSessions.get("vd-2"), "device-b");
  assert.equal(__test.staleVirtualSessions.get("vd-1"), "bridge_restarted");
});
