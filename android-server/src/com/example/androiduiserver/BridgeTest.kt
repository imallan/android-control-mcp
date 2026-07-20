@file:Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")

package com.example.androiduiserver

import android.content.Context
import android.content.ContextWrapper
import android.app.ActivityOptions
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.os.Binder
import android.graphics.Rect
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.PowerManager
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.KeyEvent
import android.view.InputEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.android.uiautomator.core.UiDevice
import com.android.uiautomator.testrunner.UiAutomatorTestCase
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.lang.StringBuilder
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap
import java.util.UUID

class BridgeTest : UiAutomatorTestCase() {
  private lateinit var device: UiDevice
  private val wakeLockToken = Binder()
  private var wakeLockHeld = false
  @Volatile private var running = false
  private var probeDisplay: VirtualDisplay? = null
  private var probeImageReader: ImageReader? = null
  private val displaySessions = LinkedHashMap<String, DisplaySession>()

  override fun setUp() {
    super.setUp()
    device = uiDevice
    device.setCompressedLayoutHeirarchy(false)
    acquireWakeLock()
    device.wakeUp()
  }

  override fun tearDown() {
    releaseDisplaySessions()
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

  private fun releaseDisplaySessions() {
    for (session in displaySessions.values.toList()) {
      session.release()
    }
    displaySessions.clear()
    probeDisplay?.release()
    probeDisplay = null
    probeImageReader?.close()
    probeImageReader = null
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
      "dumpCompact" -> dumpCompact(request)
      "dumpXml" -> dumpXml(request)
      "tap" -> tap(request)
      "inputText" -> inputText(request)
      "performAction" -> performAction(request)
      "longPress" -> longPress(request)
      "currentApp" -> currentApp()
      "listApps" -> listApps()
      "launchApp" -> launchApp(request)
      "swipe" -> swipe(request)
      "key" -> key(request)
      "probeVirtualDisplay" -> probeVirtualDisplay(request)
      "createVirtualDisplay" -> createVirtualDisplay(request)
      "destroyVirtualDisplay" -> destroyVirtualDisplay(request)
      "listDisplays" -> listDisplays()
      "captureFrame" -> captureFrame(request)
      "exit" -> {
        releaseDisplaySessions()
        running = false
        bool("success", true)
      }
      else -> throw IllegalArgumentException("unknown method: $method")
    }
  }

  @Throws(Exception::class)
  private fun dumpCompact(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val target = resolveDisplayTarget(request)
    val nodes = ArrayList<Any>()
    val roots = rootNodes(target.displayId)
    val packageNames = roots.mapNotNull { root -> root.packageName?.toString()?.takeIf { it.isNotBlank() } }.distinct()
    val packageName = packageNames.firstOrNull { it != "com.android.systemui" } ?: packageNames.firstOrNull().orEmpty()
    for (root in roots) {
      try {
        collectCompactNodes(root, nodes, 0)
      } finally {
        root.recycle()
      }
    }

    return linkedMapOf(
      "ok" to true,
      "packageName" to packageName,
      "packageNames" to packageNames,
      "width" to target.width,
      "height" to target.height,
      "displayId" to target.displayId,
      "sessionId" to target.sessionId,
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
  private fun rootNodes(displayId: Int = 0): List<AccessibilityNodeInfo> {
    device.waitForIdle(500)
    val bridge = invokeNoArg(device, "getAutomatorBridge") ?: throw IllegalStateException("missing automator bridge")
    val roots = ArrayList<AccessibilityNodeInfo>()
    val activeRoot =
      if (displayId == 0) invokeNoArg(bridge, "getRootInActiveWindow") as AccessibilityNodeInfo?
      else null

    if (activeRoot != null) {
      roots.add(activeRoot)
    }

    val uiAutomation = readField(bridge, "mUiAutomation")
    if (uiAutomation == null) {
      if (activeRoot != null) return roots
      throw IllegalStateException("missing ui automation")
    }
    enableInteractiveWindows(uiAutomation)
    val windows = try {
      allAccessibilityWindows(uiAutomation, displayId)
    } catch (error: Throwable) {
      // Window enumeration is an enhancement for display 0. Some OEM
      // UiAutomation implementations do not expose getWindows even after
      // FLAG_RETRIEVE_INTERACTIVE_WINDOWS is enabled, so retain the active
      // root rather than failing an otherwise usable compact dump.
      if (activeRoot != null) return roots
      throw error
    }

    try {
      if (activeRoot != null) {
        val activeWindowId = activeRoot.windowId
        if (activeWindowId == UNDEFINED_WINDOW_ID) {
          return roots
        }

        // PopupWindow, PopupMenu, Spinner dropdowns, and anchored dialogs can
        // live in secondary accessibility windows. Include only windows whose
        // parent chain reaches the active window. Unrelated top-level windows
        // from split-screen apps and system UI therefore remain excluded.
        for (window in windows
          .asSequence()
          .filter { it.displayId == displayId && it.id != activeWindowId }
          .filter { isDescendantWindowOf(it, activeWindowId) }
          .sortedBy { it.layer }) {
          window.root?.let { roots.add(it) }
        }
        return roots
      }

      // Preserve the existing fallback when there is no active root, and for
      // non-default displays where all windows on that display are relevant.
      for (window in windows) {
        if (window.displayId != displayId) continue
        window.root?.let { roots.add(it) }
      }
      return roots
    } finally {
      recycleWindows(windows)
    }
  }

  private fun isDescendantWindowOf(window: AccessibilityWindowInfo, ancestorWindowId: Int): Boolean {
    var parent = window.parent
    var depth = 0
    while (parent != null && depth < MAX_WINDOW_PARENT_DEPTH) {
      val parentId = parent.id
      if (parentId == ancestorWindowId) {
        parent.recycle()
        return true
      }
      val next = parent.parent
      parent.recycle()
      parent = next
      depth += 1
    }
    parent?.recycle()
    return false
  }

  private fun recycleWindows(windows: List<AccessibilityWindowInfo>) {
    for (window in windows) {
      window.recycle()
    }
  }

  private fun enableInteractiveWindows(uiAutomation: Any) {
    try {
      val getServiceInfo = uiAutomation.javaClass.getMethod("getServiceInfo")
      val info = getServiceInfo.invoke(uiAutomation) ?: return
      val flagsField = info.javaClass.getField("flags")
      val flags = flagsField.getInt(info)
      if (flags.and(0x40) == 0) {
        flagsField.setInt(info, flags.or(0x40)) // FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        val setServiceInfo = uiAutomation.javaClass.getMethod("setServiceInfo", info.javaClass)
        setServiceInfo.invoke(uiAutomation, info)
        SystemClock.sleep(100)
      }
    } catch (_: Throwable) {
      // Continue with the existing UiAutomation service configuration.
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun allAccessibilityWindows(uiAutomation: Any, displayId: Int): List<AccessibilityWindowInfo> {
    if (displayId != 0) {
      try {
        val method = uiAutomation.javaClass.getMethod("getWindowsOnAllDisplays")
        val sparse = method.invoke(uiAutomation) ?: return emptyList()
        val sparseClass = sparse.javaClass
        val size = sparseClass.getMethod("size").invoke(sparse) as Int
        val valueAt = sparseClass.getMethod("valueAt", Int::class.javaPrimitiveType)
        val windows = ArrayList<AccessibilityWindowInfo>()
        for (index in 0 until size) {
          val value = valueAt.invoke(sparse, index) as? List<AccessibilityWindowInfo> ?: continue
          windows.addAll(value)
        }
        return windows
      } catch (_: NoSuchMethodException) {
        // Android 14+ exposes this API; retain a conservative fallback for OEM variants.
      }
    }
    val getWindows = uiAutomation.javaClass.getMethod("getWindows")
    return getWindows.invoke(uiAutomation) as List<AccessibilityWindowInfo>
  }

  @Throws(Exception::class)
  private fun dumpXml(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val target = resolveDisplayTarget(request)
    if (target.displayId != 0) {
      throw IllegalArgumentException("display_not_supported: XML dump is only available for display 0")
    }
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
      val success = performOnMatchingNode(selector, resolveDisplayTarget(request).displayId) { node ->
        setNodeText(node, text, "selected node")
      }
      if (!success) {
        throw IllegalArgumentException("no accessibility node matched the provided selector")
      }
    } else {
      performOnFocusedInput(resolveDisplayTarget(request).displayId) { node ->
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
      performOnMatchingNode(selector, resolveDisplayTarget(request).displayId) { node ->
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
    val target = resolveDisplayTarget(request)
    val success = if (target.displayId == 0) {
      longTap(x, y) || device.swipe(x, y, x + 1, y + 1, steps)
    } else {
      injectSwipe(target.displayId, x, y, x, y, steps)
    }
    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to success, "x" to x, "y" to y, "steps" to steps, "displayId" to target.displayId, "sessionId" to target.sessionId)
  }

  private fun tap(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val x = intParam(request, "x")
    val y = intParam(request, "y")
    val target = resolveDisplayTarget(request)
    val success = if (target.displayId == 0) device.click(x, y) else injectTap(target.displayId, x, y)
    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to success, "x" to x, "y" to y, "displayId" to target.displayId, "sessionId" to target.sessionId)
  }

  private fun swipe(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val x1 = intParam(request, "x1")
    val y1 = intParam(request, "y1")
    val x2 = intParam(request, "x2")
    val y2 = intParam(request, "y2")
    val steps = intParam(request, "steps", 24)
    val target = resolveDisplayTarget(request)
    val success = if (target.displayId == 0) device.swipe(x1, y1, x2, y2, steps) else injectSwipe(target.displayId, x1, y1, x2, y2, steps)
    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to success, "steps" to steps, "displayId" to target.displayId, "sessionId" to target.sessionId)
  }

  private fun key(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val keyCode = keyCode(request["key"])
    val target = resolveDisplayTarget(request)
    val success = if (target.displayId == 0) device.pressKeyCode(keyCode) else injectKey(target.displayId, keyCode)
    return linkedMapOf("ok" to true, "success" to success, "displayId" to target.displayId, "sessionId" to target.sessionId)
  }

  private fun injectTap(displayId: Int, x: Int, y: Int): Boolean {
    val downTime = SystemClock.uptimeMillis()
    val down = motionEvent(displayId, downTime, downTime, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat())
    val up = motionEvent(displayId, downTime, downTime + 20, MotionEvent.ACTION_UP, x.toFloat(), y.toFloat())
    return try {
      injectInputEvent(down) && injectInputEvent(up)
    } finally {
      down.recycle()
      up.recycle()
    }
  }

  private fun injectSwipe(displayId: Int, x1: Int, y1: Int, x2: Int, y2: Int, steps: Int): Boolean {
    val count = steps.coerceAtLeast(1)
    val downTime = SystemClock.uptimeMillis()
    var success = true
    for (index in 0..count) {
      val fraction = index.toFloat() / count.toFloat()
      val action = if (index == 0) MotionEvent.ACTION_DOWN else if (index == count) MotionEvent.ACTION_UP else MotionEvent.ACTION_MOVE
      val event = motionEvent(displayId, downTime, downTime + index * 5L, action, x1 + (x2 - x1) * fraction, y1 + (y2 - y1) * fraction)
      try {
        success = injectInputEvent(event) && success
      } finally {
        event.recycle()
      }
    }
    return success
  }

  private fun injectKey(displayId: Int, keyCode: Int): Boolean {
    val downTime = SystemClock.uptimeMillis()
    val down = KeyEvent(downTime, downTime, KeyEvent.ACTION_DOWN, keyCode, 0)
    val up = KeyEvent(downTime, downTime + 20, KeyEvent.ACTION_UP, keyCode, 0)
    setInputEventDisplayId(down, displayId)
    setInputEventDisplayId(up, displayId)
    return injectInputEvent(down) && injectInputEvent(up)
  }

  private fun motionEvent(displayId: Int, downTime: Long, eventTime: Long, action: Int, x: Float, y: Float): MotionEvent {
    val event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0)
    event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
    setInputEventDisplayId(event, displayId)
    return event
  }

  private fun setInputEventDisplayId(event: InputEvent, displayId: Int) {
    val method = InputEvent::class.java.getDeclaredMethod("setDisplayId", Int::class.javaPrimitiveType)
    method.isAccessible = true
    method.invoke(event, displayId)
  }

  private fun injectInputEvent(event: InputEvent): Boolean {
    val errors = ArrayList<String>()
    for (className in listOf("android.hardware.input.InputManagerGlobal", "android.hardware.input.InputManager")) {
      try {
        val type = Class.forName(className)
        val instance = type.getDeclaredMethod("getInstance").invoke(null)
        val method = type.methods.firstOrNull { candidate ->
          candidate.name == "injectInputEvent" && candidate.parameterCount == 2
        } ?: throw NoSuchMethodException("injectInputEvent")
        return method.invoke(instance, event, 2) as Boolean
      } catch (error: Throwable) {
        errors.add("$className: ${error.cause?.message ?: error.message}")
      }
    }
    try {
      val serviceManager = Class.forName("android.os.ServiceManager")
      val binder = serviceManager.getDeclaredMethod("getService", String::class.java).invoke(null, "input") as android.os.IBinder
      val stub = Class.forName("android.hardware.input.IInputManager\$Stub")
      val service = stub.getDeclaredMethod("asInterface", android.os.IBinder::class.java).invoke(null, binder)
      val method = service.javaClass.methods.firstOrNull { candidate ->
        candidate.name == "injectInputEvent" && candidate.parameterCount == 2
      } ?: throw NoSuchMethodException("IInputManager.injectInputEvent")
      return method.invoke(service, event, 2) as Boolean
    } catch (error: Throwable) {
      errors.add("IInputManager: ${error.cause?.message ?: error.message}")
    }
    throw IllegalStateException("input injection unavailable: ${errors.joinToString(" | ")}")
  }

  @Throws(Exception::class)
  private fun probeVirtualDisplay(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val width = intParam(request, "width", 1024)
    val height = intParam(request, "height", 768)
    val dpi = intParam(request, "dpi", 160)

    var step = "init"

    try {
      // Step 1: Try DisplayManager via ServiceManager (app_process path)
      step = "serviceManager"
      val smClass = Class.forName("android.os.ServiceManager")
      val getService = smClass.getDeclaredMethod("getService", String::class.java)
      val displayBinder = getService.invoke(null, "display") as? android.os.IBinder
        ?: throw NullPointerException("display service binder is null")
      val iDisplayManagerStub = Class.forName("android.hardware.display.IDisplayManager\$Stub")
      val asInterface = iDisplayManagerStub.getDeclaredMethod("asInterface", android.os.IBinder::class.java)
      val displayService = asInterface.invoke(null, displayBinder)

      // Try getting existing display IDs
      step = "getDisplayIds"
      val existingIds = try {
        val dmgClass = Class.forName("android.hardware.display.DisplayManagerGlobal")
        val getInstance = dmgClass.getDeclaredMethod("getInstance")
        val dmg = getInstance.invoke(null)
        val getDisplayIds = dmg.javaClass.getMethod("getDisplayIds")
        (getDisplayIds.invoke(dmg) as IntArray).toList()
      } catch (_: Exception) {
        emptyList<Int>()
      }

      // Step 2: Try ActivityThread systemMain() approach
      step = "ActivityThread.systemMain"
      var contextFound = false
      var ctx: Context? = null
      try {
        val atClass = Class.forName("android.app.ActivityThread")
        val systemMain = atClass.getMethod("systemMain")
        val at = systemMain.invoke(null)
        val getSystemContext = atClass.getMethod("getSystemContext")
        ctx = getSystemContext.invoke(at) as Context
        contextFound = true
      } catch (_: Exception) {
        // Fall through to next approach
      }

      // Step 3: Try AppGlobals.getInitialApplication
      if (!contextFound) {
        step = "AppGlobals"
        try {
          val agClass = Class.forName("android.app.AppGlobals")
          val getInitialApplication = agClass.getMethod("getInitialApplication")
          val app = getInitialApplication.invoke(null)
          if (app != null) {
            ctx = (app as Context).applicationContext
            contextFound = ctx != null
          }
        } catch (_: Exception) {
          // Fall through
        }
      }

      if (!contextFound || ctx == null) {
        throw IllegalStateException("No Context available: ActivityThread.currentActivityThread=null, systemMain failed, AppGlobals failed")
      }

      // Step 4: Wrap context with shell identity (matching uiautomator process UID)
      step = "FakeContext"
      val shellCtx = object : android.content.ContextWrapper(ctx) {
        override fun getPackageName(): String = "com.android.shell"
        override fun getOpPackageName(): String = "com.android.shell"
      }

      // Step 5: Construct DisplayManager with shell context
      step = "DisplayManager newInstance"
      val dmConstructor = android.hardware.display.DisplayManager::class.java
        .getDeclaredConstructor(Context::class.java)
      dmConstructor.isAccessible = true
      val dm = dmConstructor.newInstance(shellCtx)

      // Step 5: Create ImageReader and VirtualDisplay
      step = "ImageReader"
      val imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)

      step = "createVirtualDisplay"
      val flags = (1 shl 0)  // PUBLIC
        .or(1 shl 1)  // PRESENTATION
        .or(1 shl 3)  // OWN_CONTENT_ONLY
        .or(1 shl 6)  // SUPPORTS_TOUCH
        .or(1 shl 7)  // ROTATES_WITH_CONTENT
        .or(1 shl 10) // TRUSTED (API 33+)
        .or(1 shl 11) // OWN_DISPLAY_GROUP (API 33+)
        .or(1 shl 12) // ALWAYS_UNLOCKED (API 33+)
        .or(1 shl 13) // TOUCH_FEEDBACK_DISABLED (API 33+)
        .or(1 shl 14) // OWN_FOCUS (API 34+)
        .or(1 shl 15) // DEVICE_DISPLAY_GROUP (API 34+)
      val vd = dm.createVirtualDisplay("mcp-probe", width, height, dpi, imageReader.surface, flags)

      step = "getDisplayId"
      val displayId = vd.display.displayId
      val displayName = vd.display.name ?: ""

      probeDisplay = vd
      probeImageReader = imageReader

      return linkedMapOf(
        "ok" to true,
        "created" to true,
        "displayId" to displayId,
        "displayName" to displayName,
        "width" to width,
        "height" to height,
        "dpi" to dpi,
        "existingDisplayIds" to existingIds,
        "contextClass" to (ctx as Any).javaClass.name,
        "contextPackage" to ctx.packageName
      )
    } catch (e: Exception) {
      return linkedMapOf(
        "ok" to true,
        "created" to false,
        "step" to step,
        "errorType" to e.javaClass.simpleName,
        "errorMessage" to e.message,
        "errorCause" to (e.cause?.javaClass?.simpleName ?: ""),
        "errorCauseMessage" to (e.cause?.message ?: "")
      )
    }
  }

  @Throws(Exception::class)
  private fun createVirtualDisplay(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val width = intParam(request, "width", 1280)
    val height = intParam(request, "height", 960)
    val dpi = intParam(request, "dpi", 160)
    val systemDecorations = request["systemDecorations"]?.toBooleanStrictOrNull() ?: true
    val destroyContentOnRemoval = request["destroyContentOnRemoval"]?.toBooleanStrictOrNull() ?: true
    val displayImePolicy = request["displayImePolicy"]?.toIntOrNull()
    if (width <= 0 || height <= 0 || dpi <= 0) {
      throw IllegalArgumentException("width, height, and dpi must be positive")
    }

    releaseDisplaySessions()

    val imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3)
    try {
      val dm = shellDisplayManager()
      val flags = virtualDisplayFlags(systemDecorations, destroyContentOnRemoval)
      val sessionId = "vd-${UUID.randomUUID()}"
      val vd = dm.createVirtualDisplay("mcp-$sessionId", width, height, dpi, imageReader.surface, flags)
        ?: throw IllegalStateException("createVirtualDisplay returned null")
      val displayId = vd.display.displayId
      val session = DisplaySession(
        sessionId = sessionId,
        displayId = displayId,
        virtualDisplay = vd,
        imageReader = imageReader,
        width = width,
        height = height,
        dpi = dpi,
        flags = flags,
        createdAtMs = SystemClock.uptimeMillis()
      )
      displaySessions[sessionId] = session
      val imePolicyError = if (displayImePolicy != null) {
        try {
          setDisplayImePolicy(displayId, displayImePolicy)
          null
        } catch (error: Throwable) {
          "${error.javaClass.simpleName}: ${error.cause?.message ?: error.message}"
        }
      } else null
      return linkedMapOf(
        "ok" to true,
        "success" to true,
        "sessionId" to sessionId,
        "displayId" to displayId,
        "width" to width,
        "height" to height,
        "dpi" to dpi,
        "flags" to flags,
        "systemDecorations" to systemDecorations,
        "destroyContentOnRemoval" to destroyContentOnRemoval,
        "displayImePolicy" to displayImePolicy,
        "displayImePolicyApplied" to (displayImePolicy != null && imePolicyError == null),
        "displayImePolicyError" to imePolicyError,
        "displayName" to (vd.display.name ?: "")
      )
    } catch (error: Throwable) {
      imageReader.close()
      throw error
    }
  }

  @Throws(Exception::class)
  private fun destroyVirtualDisplay(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val session = resolveDisplaySession(request, requireVirtual = true)
    displaySessions.remove(session.sessionId)
    session.release()
    return linkedMapOf(
      "ok" to true,
      "success" to true,
      "sessionId" to session.sessionId,
      "displayId" to session.displayId
    )
  }

  @Throws(Exception::class)
  private fun listDisplays(): LinkedHashMap<String, Any?> {
    val ownedByDisplayId = displaySessions.values.associateBy { it.displayId }
    val displays = ArrayList<Any>()
    for (display in shellDisplayManager().displays) {
      val owned = ownedByDisplayId[display.displayId]
      val item = linkedMapOf<String, Any?>(
        "displayId" to display.displayId,
        "name" to (display.name ?: ""),
        "flags" to display.flags,
        "mcpOwned" to (owned != null)
      )
      if (owned != null) {
        item["sessionId"] = owned.sessionId
        item["width"] = owned.width
        item["height"] = owned.height
        item["dpi"] = owned.dpi
        item["createdAtMs"] = owned.createdAtMs
      }
      displays.add(item)
    }
    return linkedMapOf(
      "ok" to true,
      "success" to true,
      "displays" to displays,
      "count" to displays.size,
      "ownedCount" to displaySessions.size
    )
  }

  @Throws(Exception::class)
  private fun captureFrame(request: Map<String, String>): LinkedHashMap<String, Any?> {
    val session = resolveDisplaySession(request, requireVirtual = true)
    val timeoutMs = intParam(request, "timeoutMs", 2_000)
    val pngBase64 = captureVirtualDisplayPngBase64(session, timeoutMs)
    return linkedMapOf(
      "ok" to true,
      "success" to true,
      "pngBase64" to pngBase64,
      "width" to session.width,
      "height" to session.height,
      "displayId" to session.displayId,
      "sessionId" to session.sessionId
    )
  }

  @Throws(Exception::class)
  private fun captureVirtualDisplayPngBase64(session: DisplaySession, timeoutMs: Int): String {
    val deadline = SystemClock.uptimeMillis() + timeoutMs.coerceAtLeast(1)
    var latest: android.media.Image? = null
    while (SystemClock.uptimeMillis() <= deadline) {
      val image = session.imageReader.acquireLatestImage()
      if (image != null) {
        latest?.close()
        latest = image
        break
      }
      SystemClock.sleep(25)
    }
    val image = latest ?: return session.lastPngBase64 ?: throw IllegalStateException("virtual display frame timeout")
    try {
      val encoded = imageToPngBase64(image, session.width, session.height)
      session.lastPngBase64 = encoded
      return encoded
    } finally {
      image.close()
    }
  }

  private fun imageToPngBase64(image: android.media.Image, width: Int, height: Int): String {
    val plane = image.planes.firstOrNull() ?: throw IllegalStateException("image has no planes")
    val buffer = plane.buffer
    val pixelStride = plane.pixelStride
    val rowStride = plane.rowStride
    if (pixelStride <= 0 || rowStride <= 0) {
      throw IllegalStateException("invalid image stride")
    }
    val rowPadding = rowStride - pixelStride * width
    val bitmapWidth = width + (rowPadding / pixelStride)
    val padded = Bitmap.createBitmap(bitmapWidth, height, Bitmap.Config.ARGB_8888)
    padded.copyPixelsFromBuffer(buffer)
    val bitmap = if (bitmapWidth == width) padded else Bitmap.createBitmap(padded, 0, 0, width, height)
    if (bitmap !== padded) {
      padded.recycle()
    }
    val out = ByteArrayOutputStream()
    try {
      if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
        throw IllegalStateException("failed to encode PNG")
      }
      return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    } finally {
      bitmap.recycle()
      out.close()
    }
  }

  @Throws(Exception::class)
  private fun resolveDisplaySession(request: Map<String, String>, requireVirtual: Boolean): DisplaySession {
    val sessionId = request["sessionId"]
    val displayId = request["displayId"]?.toIntOrNull()
    if (sessionId != null && displayId != null) {
      throw IllegalArgumentException("provide only one of sessionId or displayId")
    }
    if (sessionId != null) {
      return displaySessions[sessionId] ?: throw IllegalArgumentException("virtual_display_not_found: $sessionId")
    }
    if (displayId != null) {
      if (displayId == 0 && requireVirtual) {
        throw IllegalArgumentException("display_not_supported: bridge capture for display 0 is not implemented")
      }
      return displaySessions.values.firstOrNull { it.displayId == displayId }
        ?: throw IllegalArgumentException("virtual_display_not_found: displayId=$displayId")
    }
    if (requireVirtual) {
      throw IllegalArgumentException("missing sessionId or displayId")
    }
    throw IllegalArgumentException("missing display target")
  }

  @Throws(Exception::class)
  private fun displayTargetOrNull(request: Map<String, String>): Int? {
    val sessionId = request["sessionId"]
    val displayId = request["displayId"]?.toIntOrNull()
    if (sessionId != null && displayId != null) {
      throw IllegalArgumentException("provide only one of sessionId or displayId")
    }
    if (sessionId != null) {
      return displaySessions[sessionId]?.displayId ?: throw IllegalArgumentException("virtual_display_not_found: $sessionId")
    }
    return displayId
  }

  private fun resolveDisplayTarget(request: Map<String, String>): DisplayTarget {
    val sessionId = request["sessionId"]
    val rawDisplayId = request["displayId"]
    if (sessionId != null && rawDisplayId != null) {
      throw IllegalArgumentException("provide only one of sessionId or displayId")
    }
    if (sessionId != null) {
      val session = displaySessions[sessionId]
        ?: throw IllegalArgumentException("virtual_display_not_found: $sessionId")
      return DisplayTarget(session.displayId, session.sessionId, session.width, session.height)
    }
    val displayId = rawDisplayId?.toIntOrNull()
      ?: if (rawDisplayId == null) 0 else throw IllegalArgumentException("invalid displayId")
    if (displayId == 0) {
      return DisplayTarget(0, null, device.displayWidth, device.displayHeight)
    }
    val session = displaySessions.values.firstOrNull { it.displayId == displayId }
      ?: throw IllegalArgumentException("virtual_display_not_found: displayId=$displayId")
    return DisplayTarget(session.displayId, session.sessionId, session.width, session.height)
  }

  @Throws(Exception::class)
  private fun shellContext(): Context {
    val ctx = systemContext().createPackageContext("com.android.shell", 0)
    return object : ContextWrapper(ctx) {
      override fun getPackageName(): String = "com.android.shell"
      override fun getOpPackageName(): String = "com.android.shell"
    }
  }

  @Throws(Exception::class)
  private fun shellDisplayManager(): DisplayManager {
    val constructor = DisplayManager::class.java.getDeclaredConstructor(Context::class.java)
    constructor.isAccessible = true
    return constructor.newInstance(shellContext())
  }

  @Throws(Exception::class)
  private fun systemContext(): Context {
    val atClass = Class.forName("android.app.ActivityThread")
    val systemMain = atClass.getMethod("systemMain")
    val at = systemMain.invoke(null)
    val getSystemContext = atClass.getMethod("getSystemContext")
    return getSystemContext.invoke(at) as Context
  }

  private fun setDisplayImePolicy(displayId: Int, policy: Int) {
    val serviceManager = Class.forName("android.os.ServiceManager")
    val binder = serviceManager.getDeclaredMethod("getService", String::class.java).invoke(null, "window") as android.os.IBinder
    val stub = Class.forName("android.view.IWindowManager\$Stub")
    val service = stub.getDeclaredMethod("asInterface", android.os.IBinder::class.java).invoke(null, binder)
    val method = service.javaClass.methods.firstOrNull { it.name == "setDisplayImePolicy" && it.parameterCount == 2 }
      ?: throw NoSuchMethodException("setDisplayImePolicy")
    method.invoke(service, displayId, policy)
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
    val displayId = displayTargetOrNull(request)
    if (displayId == null || displayId == 0) {
      shellCommand("monkey -p ${shellQuote(applicationId)} -c android.intent.category.LAUNCHER 1")
    } else {
      launchAppOnDisplay(applicationId, displayId)
    }
    device.waitForIdle(500)
    return linkedMapOf("ok" to true, "success" to true, "launched" to app, "displayId" to (displayId ?: 0))
  }

  @Throws(Exception::class)
  private fun launchAppOnDisplay(applicationId: String, displayId: Int) {
    val ctx = shellContext()
    val intent = ctx.packageManager.getLaunchIntentForPackage(applicationId)
      ?: throw IllegalArgumentException("no launch intent for applicationId: $applicationId")
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val options = ActivityOptions.makeBasic()
    options.launchDisplayId = displayId
    try {
      ctx.startActivity(intent, options.toBundle())
    } catch (error: SecurityException) {
      startActivityWithActivityTaskManager(ctx, intent, options.toBundle())
    }
  }

  @Throws(Exception::class)
  private fun startActivityWithActivityTaskManager(ctx: Context, intent: Intent, options: Bundle) {
    val resolvedType = intent.resolveTypeIfNeeded(ctx.contentResolver)
    val errors = ArrayList<String>()
    for (serviceName in listOf("activity_task", "activity")) {
      val service = activityService(serviceName) ?: continue
      val methods = service.javaClass.methods
        .filter { method -> method.name == "startActivityAsUser" || method.name == "startActivity" }
        .sortedBy { method -> if (method.name == "startActivityAsUser") 0 else 1 }
      for (method in methods) {
        try {
          method.isAccessible = true
          val args = activityStartArgs(method.parameterTypes, intent, resolvedType, options)
          method.invoke(service, *args)
          return
        } catch (error: InvocationTargetException) {
          errors.add("${serviceName}.${method.name}/${method.parameterCount}: ${error.cause?.javaClass?.simpleName}: ${error.cause?.message}")
        } catch (error: Throwable) {
          errors.add("${serviceName}.${method.name}/${method.parameterCount}: ${error.javaClass.simpleName}: ${error.message}")
        }
      }
    }
    throw IllegalStateException("display launch failed via ActivityTaskManager: ${errors.joinToString(" | ")}")
  }

  private fun activityStartArgs(parameterTypes: Array<Class<*>>, intent: Intent, resolvedType: String?, options: Bundle): Array<Any?> {
    var stringIndex = 0
    var intIndex = 0
    return Array(parameterTypes.size) { index ->
      val type = parameterTypes[index]
      when {
        Intent::class.java.isAssignableFrom(type) -> intent
        Bundle::class.java.isAssignableFrom(type) -> options
        type == String::class.java -> {
          val value = when (stringIndex) {
            0 -> "com.android.shell"
            2 -> resolvedType
            else -> null
          }
          stringIndex += 1
          value
        }
        type == Int::class.javaPrimitiveType -> {
          val value = when (intIndex) {
            0 -> -1
            1 -> 0
            else -> 0
          }
          intIndex += 1
          value
        }
        else -> null
      }
    }
  }

  private fun activityService(serviceName: String): Any? {
    return try {
      if (serviceName == "activity_task") {
        val activityTaskManager = Class.forName("android.app.ActivityTaskManager")
        activityTaskManager.getDeclaredMethod("getService").invoke(null)
      } else {
        val serviceManager = Class.forName("android.os.ServiceManager")
        val getService = serviceManager.getDeclaredMethod("getService", String::class.java)
        val binder = getService.invoke(null, serviceName) as? android.os.IBinder ?: return null
        val stubClass = Class.forName("android.app.IActivityManager\$Stub")
        val asInterface = stubClass.getDeclaredMethod("asInterface", android.os.IBinder::class.java)
        asInterface.invoke(null, binder)
      }
    } catch (_: Throwable) {
      null
    }
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
  private fun performOnFocusedInput(displayId: Int, onFocus: (AccessibilityNodeInfo) -> Unit) {
    val roots = rootNodes(displayId)
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
  private fun performOnMatchingNode(selector: NodeSelector, displayId: Int, onMatch: (AccessibilityNodeInfo) -> Unit): Boolean {
    val roots = rootNodes(displayId)
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

  private data class DisplayTarget(
    val displayId: Int,
    val sessionId: String?,
    val width: Int,
    val height: Int
  )

  private data class DisplaySession(
    val sessionId: String,
    val displayId: Int,
    val virtualDisplay: VirtualDisplay,
    val imageReader: ImageReader,
    val width: Int,
    val height: Int,
    val dpi: Int,
    val flags: Int,
    val createdAtMs: Long,
    var lastPngBase64: String? = null
  ) {
    fun release() {
      virtualDisplay.release()
      imageReader.close()
    }
  }

  companion object {
    private const val MAX_WINDOW_PARENT_DEPTH = 32
    private const val UNDEFINED_WINDOW_ID = -1
    private const val SOCKET_NAME = "android-ui-mcp"
    private val DUMP_FILE = File("/sdcard/android-ui-mcp-window.xml")

    private fun virtualDisplayFlags(systemDecorations: Boolean = true, destroyContentOnRemoval: Boolean = true): Int {
      var flags = (1 shl 0)  // PUBLIC
        .or(1 shl 1)  // PRESENTATION
        .or(1 shl 3)  // OWN_CONTENT_ONLY
        .or(1 shl 6)  // SUPPORTS_TOUCH
        .or(1 shl 7)  // ROTATES_WITH_CONTENT
        .or(1 shl 10) // TRUSTED
        .or(1 shl 11) // OWN_DISPLAY_GROUP
        .or(1 shl 12) // ALWAYS_UNLOCKED
        .or(1 shl 13) // TOUCH_FEEDBACK_DISABLED
        .or(1 shl 14) // OWN_FOCUS
        .or(1 shl 15) // DEVICE_DISPLAY_GROUP
      if (destroyContentOnRemoval) flags = flags.or(1 shl 8)
      if (systemDecorations) flags = flags.or(1 shl 9)
      return flags
    }

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
      var type: Class<*>? = target.javaClass
      while (type != null) {
        try {
          val field = type.getDeclaredField(fieldName)
          field.isAccessible = true
          return field.get(target)
        } catch (_: NoSuchFieldException) {
          type = type.superclass
        }
      }
      throw NoSuchFieldException("No field $fieldName in ${target.javaClass.name} hierarchy")
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
        "ESCAPE" -> KeyEvent.KEYCODE_ESCAPE
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
