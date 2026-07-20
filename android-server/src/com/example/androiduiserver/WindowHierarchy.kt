package com.example.androiduiserver

internal fun <T> isWindowInActiveHierarchy(
  window: T,
  activeWindowId: Int,
  maxParentDepth: Int,
  idOf: (T) -> Int,
  parentOf: (T) -> T?,
  release: (T) -> Unit
): Boolean {
  require(maxParentDepth > 0) { "maxParentDepth must be positive" }
  if (idOf(window) == activeWindowId) {
    return true
  }

  var current = parentOf(window)
  var depth = 0
  val seenWindowIds = HashSet<Int>()
  while (current != null && depth < maxParentDepth) {
    val currentId = idOf(current)
    if (currentId == activeWindowId) {
      release(current)
      return true
    }
    if (!seenWindowIds.add(currentId)) {
      release(current)
      return false
    }

    val next = parentOf(current)
    release(current)
    current = next
    depth += 1
  }

  current?.let(release)
  return false
}
