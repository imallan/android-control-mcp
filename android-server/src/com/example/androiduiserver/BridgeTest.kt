@file:Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")

package com.example.androiduiserver

import android.os.Binder
import android.graphics.Rect
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.PowerManager
import android.os.Bundle
import android.os.SystemClock
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
import java.lang.StringBuilder
import java.lang.reflect.Method
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap

class BridgeTest : UiAutomatorTestCase() {
  private lateinit var device: UiDevice
  private val wakeLockToken = Binder()
  private var wakeLockHeld = false
  @Volatile private var running = false

  override fun setUp() {
    super.setUp()
    device = uiDevice
    device.setCompressedLayoutHeirarchy(false)
    acquireWakeLock()
    device.wakeUp()
  }

  override fun tearDown() {
    releaseWakeLock()
    super.tearDown()
  }

  @Throws(Exception::class)
  fun testServe() {
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

  @Throws(Exception::class)
  private fun acquireWakeLock() {
    val powerManager = powerService()
    val acquireWakeLock =
      powerManager.javaClass.methods.firstOrNull { method ->
        method.name == "acquireWakeLockWithUid" && method.parameterCount == 7
      } ?: throw NoSuchMethodException("acquireWakeLockWithUid")

    acquireWakeLock.invoke(
      powerManager,
      wakeLockToken,
      PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
      "AndroidUiMcp:BridgeTest",
      "com.example.androiduiserver",
      android.os.Process.myUid(),
      0,
      null
    )
    wakeLockHeld = true
  }

  private fun releaseWakeLock() {
    if (!wakeLockHeld) {
      return
    }
    wakeLockHeld = false
    val powerManager = powerService()
    val releaseWakeLock =
      powerManager.javaClass.methods.firstOrNull { method ->
        method.name == "releaseWakeLock" && method.parameterCount == 2
      } ?: throw NoSuchMethodException("releaseWakeLock")
    releaseWakeLock.invoke(powerManager, wakeLockToken, 0)
  }

  @Throws(Exception::class)
  private fun powerService(): Any {
    val serviceManager = Class.forName("android.os.ServiceManager")
    val getService = serviceManager.getDeclaredMethod("getService", String::class.java)
    val binder = getService.invoke(null, "power") as? android.os.IBinder
      ?: throw IllegalStateException("missing power service binder")
    val stubClass = Class.forName("android.os.IPowerManager\$Stub")
    val asInterface = stubClass.getDeclaredMethod("asInterface", android.os.IBinder::class.java)
    return asInterface.invoke(null, binder)
      ?: throw IllegalStateException("missing power service interface")
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
      "longPress" -> longPress(request)
      "currentApp" -> currentApp()
      "listApps" -> listApps()
      "launchApp" -> launchApp(request)
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

  private fun currentApp(): LinkedHashMap<String, Any?> {
    return linkedMapOf(
      "ok" to true,
      "packageName" to device.currentPackageName
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

    if (selector.hasAnyField()) {
      val success = performOnMatchingNode(selector) { node ->
        setNodeText(node, text, "selected node")
      }
      if (!success) {
        throw IllegalArgumentException("no accessibility node matched the provided selector")
      }
    } else {
      performOnFocusedInput { node ->
        setNodeText(node, text, "focused node")
      }
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

    var performedActionLabel: String? = null
    val success =
      performOnMatchingNode(selector) { node ->
        val customAction = resolveCustomAction(node, actionName)
        val predefinedActionId = actionId(actionName)
        val performed = if (customAction != null) {
          performedActionLabel = actionLabel(customAction.id, customAction.label?.toString()) ?: actionName
          node.performAction(customAction.id)
        } else if (predefinedActionId == AccessibilityNodeInfo.ACTION_SET_TEXT) {
          val text = request["text"] ?: ""
          val arguments = Bundle()
          arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
          performedActionLabel = actionLabel(predefinedActionId, actionName) ?: actionName
          node.performAction(predefinedActionId, arguments)
        } else if (predefinedActionId != null) {
          performedActionLabel = actionLabel(predefinedActionId, actionName) ?: actionName
          node.performAction(predefinedActionId)
        } else {
          throw IllegalArgumentException("unknown action for selected node: $actionName")
        }
        if (!performed) {
          throw IllegalStateException("selected node rejected $actionName")
        }
      }
    if (!success) {
      throw IllegalArgumentException("no accessibility node matched the provided selector")
    }

    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to true, "action" to (performedActionLabel ?: actionName))
  }

  @Throws(Exception::class)
  private fun longPress(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val x = intParam(request, "x")
    val y = intParam(request, "y")
    val steps = intParam(request, "steps", 130)
    val success = longTap(x, y) || device.swipe(x, y, x + 1, y + 1, steps)
    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to success, "x" to x, "y" to y, "steps" to steps)
  }

  private fun listApps(): LinkedHashMap<String, Any?> {
    val apps = launcherApps()
    return linkedMapOf(
      "ok" to true,
      "apps" to apps,
      "count" to apps.size
    )
  }

  private fun launchApp(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val applicationId = request["applicationId"] ?: throw IllegalArgumentException("missing applicationId")
    val app = launcherApps().find { it["applicationId"] == applicationId }
      ?: throw IllegalArgumentException("no launcher app found for applicationId: $applicationId")
    shellCommand("monkey -p ${shellQuote(applicationId)} -c android.intent.category.LAUNCHER 1")
    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to true, "launched" to app)
  }

  private fun launcherApps(): List<LinkedHashMap<String, Any?>> {
    val output = shellCommand(
      "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER"
    )
    return output
      .lineSequence()
      .map { it.trim() }
      .filter { line -> line.contains("/") && !line.startsWith("Activity #") }
      .mapNotNull { line ->
        val parts = line.split("/", limit = 2)
        val applicationId = parts.getOrNull(0)?.takeIf { it.isNotBlank() && !it.contains(" ") } ?: return@mapNotNull null
        val rawActivityName = parts.getOrNull(1)?.takeIf { it.isNotBlank() && !it.contains(" ") } ?: return@mapNotNull null
        val activityName = if (rawActivityName.startsWith(".")) "$applicationId$rawActivityName" else rawActivityName
        val derivedName = deriveAppName(applicationId, activityName)
        val app = linkedMapOf<String, Any?>(
          "applicationId" to applicationId,
          "activityName" to activityName,
          "componentName" to "$applicationId/$rawActivityName",
          "name" to derivedName,
          "labelSource" to "derived",
          "aliases" to listOf(
            derivedName,
            lastPackageSegment(applicationId),
            lastClassSegment(activityName),
            camelToWords(lastClassSegment(activityName)),
            applicationId
          ).filter { it.isNotBlank() }.distinct()
        )
        app
      }
      .sortedWith(
        compareBy<LinkedHashMap<String, Any?>>(
          { it["name"] as String },
          { it["applicationId"] as String }
        )
      )
      .toList()
  }

  @Throws(Exception::class)
  private fun shellCommand(command: String): String {
    val process = Runtime.getRuntime().exec(arrayOf("/system/bin/sh", "-c", command))
    val stdout = StringBuilder()
    val reader = BufferedReader(InputStreamReader(process.inputStream, StandardCharsets.UTF_8))
    try {
      while (true) {
        val line = reader.readLine() ?: break
        stdout.append(line).append('\n')
      }
    } finally {
      reader.close()
    }
    val exitCode = process.waitFor()
    if (exitCode != 0) {
      val stderr = BufferedReader(InputStreamReader(process.errorStream, StandardCharsets.UTF_8)).use { it.readText() }
      throw IllegalStateException("shell command failed ($exitCode): $stderr")
    }
    return stdout.toString()
  }

  private fun longTap(x: Int, y: Int): Boolean {
    return try {
      val bridge = invokeNoArg(device, "getAutomatorBridge") ?: return false
      val controller =
        try {
          invokeNoArg(bridge, "getInteractionController")
        } catch (_: Exception) {
          readField(bridge, "mInteractionController")
        } ?: return false
      val method = controller.javaClass.getDeclaredMethod("longTapNoSync", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
      method.isAccessible = true
      method.invoke(controller, x, y) as? Boolean ?: false
    } catch (_: Exception) {
      false
    }
  }

  private fun setNodeText(node: AccessibilityNodeInfo, text: String, label: String) {
    val arguments = Bundle()
    arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
      throw IllegalStateException("$label rejected set_text")
    }
  }

  @Throws(Exception::class)
  private fun performOnFocusedInput(onFocus: (AccessibilityNodeInfo) -> Unit) {
    val roots = rootNodes()
    for (root in roots) {
      try {
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && supportsSetText(focused)) {
          try {
            onFocus(focused)
            return
          } finally {
            focused.recycle()
          }
        }
        focused?.recycle()

        val focusedEditable = findFocusedEditable(root)
        if (focusedEditable != null) {
          try {
            onFocus(focusedEditable)
            return
          } finally {
            focusedEditable.recycle()
          }
        }
      } finally {
        root.recycle()
      }
    }
    throw IllegalArgumentException("no focused input node found")
  }

  private fun findFocusedEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    if (node == null) {
      return null
    }
    if (node.isFocused && supportsSetText(node)) {
      return AccessibilityNodeInfo.obtain(node)
    }

    val childCount = node.childCount
    for (index in 0 until childCount) {
      val child = node.getChild(index)
      if (child != null) {
        try {
          val match = findFocusedEditable(child)
          if (match != null) {
            return match
          }
        } finally {
          child.recycle()
        }
      }
    }
    return null
  }

  private fun supportsSetText(node: AccessibilityNodeInfo): Boolean {
    return node.actionList.any { action -> action.id == AccessibilityNodeInfo.ACTION_SET_TEXT }
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
      val actions = node.actionList
        .mapNotNull { action -> actionLabel(action.id, action.label?.toString()) }
      val hasReadableText = text.isNotEmpty() || contentDesc.isNotEmpty()
      val hasAction = node.isClickable || node.isScrollable || actions.isNotEmpty()

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

    private fun shellQuote(value: String): String {
      return "'${value.replace("'", "'\\''")}'"
    }

    private fun deriveAppName(applicationId: String, activityName: String): String {
      val activityWords = camelToWords(lastClassSegment(activityName))
        .split(Regex("\\s+"))
        .filter { word -> word !in setOf("Activity", "Launcher", "Main", "Home", "Shell", "List", "Conversation") }
      if (activityWords.isNotEmpty() && activityWords.size <= 3) {
        return activityWords.joinToString(" ")
      }
      return titleCase(lastPackageSegment(applicationId).replace(Regex("[_-]+"), " "))
    }

    private fun lastPackageSegment(applicationId: String): String {
      return applicationId.split('.').filter { it.isNotBlank() }.lastOrNull() ?: applicationId
    }

    private fun lastClassSegment(activityName: String): String {
      return activityName.split('.').filter { it.isNotBlank() }.lastOrNull()?.replace(Regex("\\$.*$"), "") ?: activityName
    }

    private fun camelToWords(value: String): String {
      return value
        .replace(Regex("([a-z0-9])([A-Z])"), "$1 $2")
        .replace(Regex("[_-]+"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
    }

    private fun titleCase(value: String): String {
      return value
        .split(Regex("\\s+"))
        .filter { it.isNotBlank() }
        .joinToString(" ") { word -> word.replaceFirstChar { char -> char.uppercase() } }
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
