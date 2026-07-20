const sourcePriority = { accessibility: 0, ocr: 1, vision: 2 };

export function hitCandidates(entries, point) {
  return entries
    .filter((entry) => containsPoint(entry.bounds, point))
    .sort((left, right) => compareCandidates(left, right, point));
}

export function containsPoint(bounds, point) {
  const [left, top, right, bottom] = bounds;
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

export function sameHit(previous, point, candidates, tolerance = 12) {
  if (!previous?.point || previous.candidates.length !== candidates.length) return false;
  if (Math.hypot(previous.point.x - point.x, previous.point.y - point.y) > tolerance) return false;
  return previous.candidates.every((entry, index) => entry.ref === candidates[index].ref);
}

export function cycleIndex(index, length, direction = 1) {
  if (length <= 0) return -1;
  return (index + direction + length) % length;
}

function compareCandidates(left, right, point) {
  return (right.windowIndex ?? 0) - (left.windowIndex ?? 0)
    || Number(right.actionable === true) - Number(left.actionable === true)
    || (sourcePriority[left.source] ?? 9) - (sourcePriority[right.source] ?? 9)
    || (right.depth ?? 0) - (left.depth ?? 0)
    || boundsArea(left.bounds) - boundsArea(right.bounds)
    || centerDistance(left.bounds, point) - centerDistance(right.bounds, point)
    || String(left.ref).localeCompare(String(right.ref));
}

function boundsArea(bounds) {
  return Math.max(1, bounds[2] - bounds[0]) * Math.max(1, bounds[3] - bounds[1]);
}

function centerDistance(bounds, point) {
  return Math.hypot((bounds[0] + bounds[2]) / 2 - point.x, (bounds[1] + bounds[3]) / 2 - point.y);
}
