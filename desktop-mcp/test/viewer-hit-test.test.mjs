import test from "node:test";
import assert from "node:assert/strict";
import { cycleIndex, hitCandidates, sameHit } from "../viewer/hit-test.js";

const entry = (overrides) => ({
  ref: "a1",
  role: "element",
  source: "accessibility",
  bounds: [0, 0, 100, 100],
  windowIndex: 0,
  depth: 0,
  actionable: false,
  ...overrides
});

test("Viewer hit testing prefers actionable deep targets over covering containers", () => {
  const ranked = hitCandidates([
    entry({ ref: "a1", role: "scrollable", bounds: [0, 0, 1080, 2400], actionable: true, depth: 1 }),
    entry({ ref: "a2", role: "button", bounds: [300, 400, 700, 520], actionable: true, depth: 6 }),
    entry({ ref: "o1", role: "text", source: "ocr", bounds: [330, 420, 680, 500], depth: 0 })
  ], { x: 500, y: 460 });
  assert.deepEqual(ranked.map((item) => item.ref), ["a2", "a1", "o1"]);
});

test("Viewer hit testing prioritizes secondary windows", () => {
  const ranked = hitCandidates([
    entry({ ref: "a1", role: "button", actionable: true, depth: 8 }),
    entry({ ref: "a2", role: "text", windowIndex: 1, depth: 2 })
  ], { x: 50, y: 50 });
  assert.equal(ranked[0].ref, "a2");
});

test("Viewer repeated hit detection and layer cycling are deterministic", () => {
  const candidates = [entry({ ref: "a1" }), entry({ ref: "a2" })];
  const previous = { point: { x: 50, y: 50 }, candidates, index: 0 };
  assert.equal(sameHit(previous, { x: 55, y: 54 }, candidates), true);
  assert.equal(sameHit(previous, { x: 80, y: 80 }, candidates), false);
  assert.equal(cycleIndex(0, 2, 1), 1);
  assert.equal(cycleIndex(0, 2, -1), 1);
});
