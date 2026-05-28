@file:Suppress("DEPRECATION")

package com.example.androiduiserver

import android.graphics.Rect
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.SystemClock
import android.os.Bundle
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.android.uiautomator.core.UiDevice
import com.android.uiautomator.testrunner.UiAutomatorTestCase
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.FileReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.lang.reflect.Method
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap

class BridgeTest : UiAutomatorTestCase() {
  private lateinit var device: UiDevice
  @Volatile private var running = false

  @Throws(Exception::class)
  fun testServe() {
    device = uiDevice
    device.setCompressedLayoutHeirarchy(false)
    running = true

    val server = LocalServerSocket(SOCKET_NAME)
    try {
      while (running) {
        val socket = server.accept()
        handleClient(socket)
      }
    } finally {
      server.close()
    }
  }

  @Throws(IOException::class)
  private fun handleClient(socket: LocalSocket) {
    try {
      val reader = BufferedReader(InputStreamReader(socket.inputStream, StandardCharsets.UTF_8))
      val writer = BufferedWriter(OutputStreamWriter(socket.outputStream, StandardCharsets.UTF_8))
      var line: String?
      while (running) {
        line = reader.readLine()
        if (line == null) {
          break
        }

        val start = SystemClock.uptimeMillis()
        val response: LinkedHashMap<String, Any?> =
          try {
            dispatch(MiniJson.parseObject(line))
          } catch (error: Throwable) {
            linkedMapOf(
              "ok" to false,
              "error" to "${error.javaClass.simpleName}: ${error.message}"
            )
          }
        response["elapsedMs"] = SystemClock.uptimeMillis() - start
        writer.write(MiniJson.stringify(response))
        writer.write("\n")
        writer.flush()
      }
    } finally {
      socket.close()
    }
  }

  @Throws(Exception::class)
  private fun dispatch(request: Map<String, String>): LinkedHashMap<String, Any?> {
    return when (val method = request["method"] ?: throw IllegalArgumentException("missing method")) {
      "ping" -> ok("pong", "pong")
      "dumpCompact" -> dumpCompact()
      "dumpXml" -> dumpXml()
      "tap" -> bool("success", device.click(intParam(request, "x"), intParam(request, "y")))
      "inputText" -> inputText(request)
      "performAction" -> performAction(request)
      "swipe" -> {
        val success =
          device.swipe(
            intParam(request, "x1"),
            intParam(request, "y1"),
            intParam(request, "x2"),
            intParam(request, "y2"),
            intParam(request, "steps", 24)
          )
        device.waitForIdle(500)
        bool("success", success)
      }
      "key" -> bool("success", device.pressKeyCode(keyCode(request["key"])))
      "exit" -> {
        running = false
        bool("success", true)
      }
      else -> throw IllegalArgumentException("unknown method: $method")
    }
  }

  @Throws(Exception::class)
  private fun dumpCompact(): LinkedHashMap<String, Any?> {
    val nodes = ArrayList<Any>()
    val roots = rootNodes()
    for (root in roots) {
      try {
        collectCompactNodes(root, nodes, 0)
      } finally {
        root.recycle()
      }
    }

    return linkedMapOf(
      "ok" to true,
      "packageName" to device.currentPackageName,
      "width" to device.displayWidth,
      "height" to device.displayHeight,
      "nodes" to nodes,
      "nodeCount" to nodes.size
    )
  }

  @Throws(Exception::class)
  private fun rootNodes(): List<AccessibilityNodeInfo> {
    device.waitForIdle(500)
    val bridge = invokeNoArg(device, "getAutomatorBridge") ?: throw IllegalStateException("missing automator bridge")
    val roots = ArrayList<AccessibilityNodeInfo>()

    val activeRoot = invokeNoArg(bridge, "getRootInActiveWindow") as AccessibilityNodeInfo?
    if (activeRoot != null) {
      roots.add(activeRoot)
      return roots
    }

    val uiAutomation = readField(bridge, "mUiAutomation") ?: throw IllegalStateException("missing ui automation")
    val getWindows = uiAutomation.javaClass.getMethod("getWindows")
    @Suppress("UNCHECKED_CAST")
    val windows = getWindows.invoke(uiAutomation) as List<AccessibilityWindowInfo>
    for (window in windows) {
      val root = window.root
      if (root != null) {
        roots.add(root)
      }
    }
    return roots
  }

  @Throws(Exception::class)
  private fun dumpXml(): LinkedHashMap<String, Any?> {
    return linkedMapOf("ok" to true, "xml" to dumpXmlString())
  }

  @Throws(Exception::class)
  private fun dumpXmlString(): String {
    device.waitForIdle(500)
    device.dumpWindowHierarchy(DUMP_FILE.absolutePath)
    val builder = StringBuilder()
    val reader = BufferedReader(FileReader(DUMP_FILE))
    try {
      var line: String?
      while (true) {
        line = reader.readLine()
        if (line == null) {
          break
        }
        builder.append(line)
      }
    } finally {
      reader.close()
    }
    return builder.toString()
  }

  @Throws(Exception::class)
  private fun inputText(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val text = request["text"] ?: throw IllegalArgumentException("missing text")
    val selector = selectorFromRequest(request)
    if (!selector.hasAnyField()) {
      throw IllegalArgumentException("inputText requires a target selector when used inside the bridge")
    }

    val success = performOnMatchingNode(selector) { node ->
      val arguments = Bundle()
      arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
      if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
        throw IllegalStateException("selected node rejected set_text")
      }
    }
    if (!success) {
      throw IllegalArgumentException("no accessibility node matched the provided selector")
    }

    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to true, "text" to text)
  }

  @Throws(Exception::class)
  private fun performAction(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val actionName = request["action"] ?: throw IllegalArgumentException("missing action")
    val selector = selectorFromRequest(request)
    if (!selector.hasAnyField()) {
      throw IllegalArgumentException("performAction requires a target selector")
    }

    val actionId = actionId(actionName)
      ?: throw IllegalArgumentException("unknown action: $actionName")

    val success =
      performOnMatchingNode(selector) { node ->
        val customAction = resolveCustomAction(node, actionName)
        val performed = if (customAction != null) {
          node.performAction(customAction.id)
        } else if (actionId == AccessibilityNodeInfo.ACTION_SET_TEXT) {
          val text = request["text"] ?: ""
          val arguments = Bundle()
          arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
          node.performAction(actionId, arguments)
        } else {
          node.performAction(actionId)
        }
        if (!performed) {
          throw IllegalStateException("selected node rejected $actionName")
        }
      }
    if (!success) {
      throw IllegalArgumentException("no accessibility node matched the provided selector")
    }

    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to true, "action" to actionLabel(actionId, request["action"]))
  }

  @Throws(Exception::class)
  private fun performOnMatchingNode(selector: NodeSelector, onMatch: (AccessibilityNodeInfo) -> Unit): Boolean {
    val roots = rootNodes()
    val state = MatchState()
    for (root in roots) {
      try {
        if (traverseAndAct(root, selector, onMatch, state)) {
          return true
        }
      } finally {
        root.recycle()
      }
    }
    return false
  }

  @Throws(Exception::class)
  private fun traverseAndAct(
    node: AccessibilityNodeInfo?,
    selector: NodeSelector,
    onMatch: (AccessibilityNodeInfo) -> Unit,
    state: MatchState
  ): Boolean {
    if (node == null) {
      return false
    }

    if (matchesSelector(node, selector)) {
      state.seen += 1
      if (state.seen == selector.occurrence) {
        onMatch(node)
        return true
      }
    }

    val childCount = node.childCount
    for (index in 0 until childCount) {
      val child = node.getChild(index)
      if (child != null) {
        try {
          if (traverseAndAct(child, selector, onMatch, state)) {
            return true
          }
        } finally {
          child.recycle()
        }
      }
    }
    return false
  }

  private fun selectorFromRequest(request: Map<String, String>): NodeSelector {
    return NodeSelector(
      text = request["targetText"],
      contentDesc = request["targetContentDesc"],
      resourceId = request["targetResourceId"],
      className = request["targetClassName"],
      bounds = request["targetBounds"],
      occurrence = request["targetOccurrence"]?.toIntOrNull() ?: 1
    )
  }

  private fun matchesSelector(node: AccessibilityNodeInfo, selector: NodeSelector): Boolean {
    if (selector.text != null && node.text?.toString() != selector.text) {
      return false
    }
    if (selector.contentDesc != null && node.contentDescription?.toString() != selector.contentDesc) {
      return false
    }
    if (selector.resourceId != null && node.viewIdResourceName != selector.resourceId) {
      return false
    }
    if (selector.className != null && node.className?.toString() != selector.className) {
      return false
    }
    if (selector.bounds != null) {
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      if (rectToString(bounds) != selector.bounds) {
        return false
      }
    }
    return true
  }

  private fun resolveCustomAction(
    node: AccessibilityNodeInfo,
    actionName: String
  ): AccessibilityNodeInfo.AccessibilityAction? {
    val requested = normalizeActionName(actionName)
    for (action in node.actionList) {
      val label = actionLabel(action.id, action.label?.toString()) ?: continue
      val normalizedLabel = normalizeActionName(label)
      if (normalizedLabel == requested || normalizedLabel.contains(requested) || requested.contains(normalizedLabel)) {
        return action
      }
    }
    return null
  }

  private data class MatchState(var seen: Int = 0)

  companion object {
    private const val SOCKET_NAME = "android-ui-mcp"
    private val DUMP_FILE = File("/sdcard/android-ui-mcp-window.xml")

    private data class NodeSelector(
      val text: String? = null,
      val contentDesc: String? = null,
      val resourceId: String? = null,
      val className: String? = null,
      val bounds: String? = null,
      val occurrence: Int = 1
    ) {
      fun hasAnyField(): Boolean {
        return text != null || contentDesc != null || resourceId != null || className != null || bounds != null
      }
    }

    private fun collectCompactNodes(node: AccessibilityNodeInfo?, out: MutableList<Any>, depth: Int) {
      if (node == null || depth > 80) {
        return
      }

      val text = node.text?.toString().orEmpty()
      val contentDesc = node.contentDescription?.toString().orEmpty()
      val hasReadableText = text.isNotEmpty() || contentDesc.isNotEmpty()
      val hasAction = node.isClickable || node.isScrollable

      if (hasReadableText || hasAction) {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val compact = LinkedHashMap<String, Any?>()
        putIfPresent(compact, "text", text)
        putIfPresent(compact, "contentDesc", contentDesc)
        putIfPresent(compact, "resourceId", node.viewIdResourceName)
        putIfPresent(compact, "className", node.className?.toString())
        compact["bounds"] = rectToString(bounds)
        if (node.isClickable) compact["clickable"] = true
        if (node.isScrollable) compact["scrollable"] = true
        val actions = node.actionList
          .mapNotNull { action -> actionLabel(action.id, action.label?.toString()) }
        if (actions.isNotEmpty()) {
          compact["actions"] = actions
        }
        out.add(compact)
      }

      val childCount = node.childCount
      for (index in 0 until childCount) {
        val child = node.getChild(index)
        if (child != null) {
          try {
            collectCompactNodes(child, out, depth + 1)
          } finally {
            child.recycle()
          }
        }
      }
    }

    @Throws(Exception::class)
    private fun invokeNoArg(target: Any, methodName: String): Any? {
      val method = findNoArgMethod(target.javaClass, methodName)
      method.isAccessible = true
      return method.invoke(target)
    }

    @Throws(NoSuchMethodException::class)
    private fun findNoArgMethod(type: Class<*>, methodName: String): Method {
      var current: Class<*>? = type
      while (current != null) {
        try {
          return current.getDeclaredMethod(methodName)
        } catch (_: NoSuchMethodException) {
          current = current.superclass
        }
      }
      throw NoSuchMethodException("${type.name}.$methodName []")
    }

    @Throws(Exception::class)
    private fun readField(target: Any, fieldName: String): Any? {
      val field = target.javaClass.getDeclaredField(fieldName)
      field.isAccessible = true
      return field.get(target)
    }

    private fun rectToString(rect: Rect): String {
      return "[${rect.left},${rect.top}][${rect.right},${rect.bottom}]"
    }

    private fun actionLabel(actionId: Int, label: String?): String? {
      if (!label.isNullOrBlank()) {
        return label
      }
      return when (actionId) {
        AccessibilityNodeInfo.ACTION_CLICK -> "click"
        AccessibilityNodeInfo.ACTION_LONG_CLICK -> "long_click"
        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> "scroll_forward"
        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> "scroll_backward"
        AccessibilityNodeInfo.ACTION_EXPAND -> "expand"
        AccessibilityNodeInfo.ACTION_COLLAPSE -> "collapse"
        AccessibilityNodeInfo.ACTION_DISMISS -> "dismiss"
        AccessibilityNodeInfo.ACTION_SET_SELECTION -> "set_selection"
        AccessibilityNodeInfo.ACTION_SET_TEXT -> "set_text"
        else -> null
      }
    }

    private fun actionId(actionName: String): Int? {
      return when (normalizeActionName(actionName)) {
        "click" -> AccessibilityNodeInfo.ACTION_CLICK
        "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
        "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        "expand" -> AccessibilityNodeInfo.ACTION_EXPAND
        "collapse" -> AccessibilityNodeInfo.ACTION_COLLAPSE
        "dismiss" -> AccessibilityNodeInfo.ACTION_DISMISS
        "set_selection" -> AccessibilityNodeInfo.ACTION_SET_SELECTION
        "set_text" -> AccessibilityNodeInfo.ACTION_SET_TEXT
        else -> null
      }
    }

    private fun normalizeActionName(actionName: String): String {
      return actionName.trim().lowercase().replace(' ', '_').replace('-', '_')
    }

    private fun ok(key: String, value: Any?): LinkedHashMap<String, Any?> {
      return linkedMapOf("ok" to true, key to value)
    }

    private fun bool(key: String, value: Boolean): LinkedHashMap<String, Any?> {
      return ok(key, value)
    }

    private fun intParam(request: Map<String, String>, key: String): Int {
      return intParam(request, key, null)
    }

    private fun intParam(request: Map<String, String>, key: String, defaultValue: Int?): Int {
      val value = request[key]
      if (value == null && defaultValue != null) {
        return defaultValue
      }
      if (value == null) {
        throw IllegalArgumentException("missing $key")
      }
      return value.toInt()
    }

    private fun keyCode(key: String?): Int {
      return when (key) {
        "BACK" -> KeyEvent.KEYCODE_BACK
        "HOME" -> KeyEvent.KEYCODE_HOME
        "ENTER" -> KeyEvent.KEYCODE_ENTER
        "APP_SWITCH" -> KeyEvent.KEYCODE_APP_SWITCH
        "DEL" -> KeyEvent.KEYCODE_DEL
        else -> throw IllegalArgumentException("unknown key: $key")
      }
    }

    private fun putIfPresent(map: MutableMap<String, Any?>, key: String, value: String?) {
      if (!value.isNullOrEmpty()) {
        map[key] = value
      }
    }
  }
}
