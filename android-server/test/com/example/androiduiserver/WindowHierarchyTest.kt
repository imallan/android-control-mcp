package com.example.androiduiserver

private class FakeWindow(val id: Int) {
  var parent: FakeWindow? = null
}

private fun assertOwned(
  window: FakeWindow,
  activeWindowId: Int,
  maxParentDepth: Int = 32,
  expected: Boolean
) {
  val released = ArrayList<Int>()
  val actual = isWindowInActiveHierarchy(
    window = window,
    activeWindowId = activeWindowId,
    maxParentDepth = maxParentDepth,
    idOf = { it.id },
    parentOf = { it.parent },
    release = { released.add(it.id) }
  )
  check(actual == expected) {
    "window=${window.id} active=$activeWindowId expected=$expected actual=$actual released=$released"
  }
}

private fun activeWindowIsOwnedWithoutWalkingParents() {
  val active = FakeWindow(1).apply { parent = FakeWindow(99) }
  var parentRead = false
  val owned = isWindowInActiveHierarchy(
    window = active,
    activeWindowId = 1,
    maxParentDepth = 32,
    idOf = { it.id },
    parentOf = {
      parentRead = true
      it.parent
    },
    release = { error("active window must not be released") }
  )
  check(owned)
  check(!parentRead)
}

private fun directAndTransitiveChildrenAreOwned() {
  val active = FakeWindow(1)
  val direct = FakeWindow(2).apply { parent = active }
  val nested = FakeWindow(3).apply { parent = direct }
  assertOwned(direct, activeWindowId = 1, expected = true)
  assertOwned(nested, activeWindowId = 1, expected = true)
}

private fun unrelatedTopLevelWindowIsRejected() {
  val unrelated = FakeWindow(20)
  assertOwned(unrelated, activeWindowId = 1, expected = false)
}

private fun parentCycleIsRejected() {
  val first = FakeWindow(30)
  val second = FakeWindow(31)
  first.parent = second
  second.parent = first
  assertOwned(first, activeWindowId = 1, expected = false)
}

private fun depthLimitIsEnforced() {
  val active = FakeWindow(1)
  val parent = FakeWindow(2).apply { this.parent = active }
  val child = FakeWindow(3).apply { this.parent = parent }
  assertOwned(child, activeWindowId = 1, maxParentDepth = 1, expected = false)
  assertOwned(child, activeWindowId = 1, maxParentDepth = 2, expected = true)
}

fun main() {
  activeWindowIsOwnedWithoutWalkingParents()
  directAndTransitiveChildrenAreOwned()
  unrelatedTopLevelWindowIsRejected()
  parentCycleIsRejected()
  depthLimitIsEnforced()
  println("WindowHierarchyTest: PASS")
}
