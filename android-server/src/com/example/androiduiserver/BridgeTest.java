package com.example.androiduiserver;

import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.SystemClock;
import android.util.Xml;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import com.android.uiautomator.core.UiDevice;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

import org.xmlpull.v1.XmlPullParser;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.StringReader;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BridgeTest extends UiAutomatorTestCase {
  private static final String SOCKET_NAME = "android-ui-mcp";
  private static final File DUMP_FILE = new File("/sdcard/android-ui-mcp-window.xml");

  private UiDevice device;
  private volatile boolean running;

  public void testServe() throws Exception {
    device = getUiDevice();
    device.setCompressedLayoutHeirarchy(false);
    running = true;

    LocalServerSocket server = new LocalServerSocket(SOCKET_NAME);
    try {
      while (running) {
        LocalSocket socket = server.accept();
        handleClient(socket);
      }
    } finally {
      server.close();
    }
  }

  private void handleClient(LocalSocket socket) throws IOException {
    try {
      BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
      BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
      String line;
      while ((line = reader.readLine()) != null && running) {
        long start = SystemClock.uptimeMillis();
        Map<String, Object> response;
        try {
          Map<String, String> request = MiniJson.parseObject(line);
          response = dispatch(request);
        } catch (Throwable error) {
          response = new LinkedHashMap<String, Object>();
          response.put("ok", false);
          response.put("error", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        response.put("elapsedMs", SystemClock.uptimeMillis() - start);
        writer.write(MiniJson.stringify(response));
        writer.write("\n");
        writer.flush();
      }
    } finally {
      socket.close();
    }
  }

  private Map<String, Object> dispatch(Map<String, String> request) throws Exception {
    String method = request.get("method");
    if (method == null) {
      throw new IllegalArgumentException("missing method");
    }
    if ("ping".equals(method)) {
      return ok("pong", "pong");
    }
    if ("dumpCompact".equals(method)) {
      return dumpCompact();
    }
    if ("dumpXml".equals(method)) {
      return dumpXml();
    }
    if ("tap".equals(method)) {
      return bool("success", device.click(intParam(request, "x"), intParam(request, "y")));
    }
    if ("swipe".equals(method)) {
      boolean success = device.swipe(
          intParam(request, "x1"),
          intParam(request, "y1"),
          intParam(request, "x2"),
          intParam(request, "y2"),
          intParam(request, "steps", 24));
      device.waitForIdle(500);
      return bool("success", success);
    }
    if ("key".equals(method)) {
      return bool("success", device.pressKeyCode(keyCode(request.get("key"))));
    }
    if ("exit".equals(method)) {
      running = false;
      return bool("success", true);
    }
    throw new IllegalArgumentException("unknown method: " + method);
  }

  private Map<String, Object> dumpCompact() throws Exception {
    List<Object> nodes = new ArrayList<Object>();
    List<AccessibilityNodeInfo> roots = getRootNodes();
    for (AccessibilityNodeInfo root : roots) {
      collectCompactNodes(root, nodes, 0);
      root.recycle();
    }

    Map<String, Object> response = new LinkedHashMap<String, Object>();
    response.put("ok", true);
    response.put("packageName", device.getCurrentPackageName());
    response.put("width", device.getDisplayWidth());
    response.put("height", device.getDisplayHeight());
    response.put("nodes", nodes);
    response.put("nodeCount", nodes.size());
    return response;
  }

  private List<AccessibilityNodeInfo> getRootNodes() throws Exception {
    device.waitForIdle(500);
    Object bridge = invokeNoArg(device, "getAutomatorBridge");

    List<AccessibilityNodeInfo> roots = new ArrayList<AccessibilityNodeInfo>();
    AccessibilityNodeInfo activeRoot = (AccessibilityNodeInfo) invokeNoArg(bridge, "getRootInActiveWindow");
    if (activeRoot != null) {
      roots.add(activeRoot);
      return roots;
    }

    Object uiAutomation = readField(bridge, "mUiAutomation");
    Method getWindows = uiAutomation.getClass().getMethod("getWindows");
    @SuppressWarnings("unchecked")
    List<AccessibilityWindowInfo> windows = (List<AccessibilityWindowInfo>) getWindows.invoke(uiAutomation);
    for (AccessibilityWindowInfo window : windows) {
      AccessibilityNodeInfo root = window.getRoot();
      if (root != null) {
        roots.add(root);
      }
    }
    return roots;
  }

  private static void collectCompactNodes(AccessibilityNodeInfo node, List<Object> out, int depth) {
    if (node == null || depth > 80) {
      return;
    }

    CharSequence textValue = node.getText();
    CharSequence descValue = node.getContentDescription();
    String text = textValue == null ? "" : textValue.toString();
    String contentDesc = descValue == null ? "" : descValue.toString();
    boolean hasReadableText = !isEmpty(text) || !isEmpty(contentDesc);
    boolean hasAction = node.isClickable() || node.isScrollable();

    if (hasReadableText || hasAction) {
      Rect bounds = new Rect();
      node.getBoundsInScreen(bounds);
      Map<String, Object> compact = new LinkedHashMap<String, Object>();
      putIfPresent(compact, "text", text);
      putIfPresent(compact, "contentDesc", contentDesc);
      putIfPresent(compact, "resourceId", node.getViewIdResourceName());
      putIfPresent(compact, "className", charSequenceToString(node.getClassName()));
      compact.put("bounds", rectToString(bounds));
      if (node.isClickable()) compact.put("clickable", Boolean.TRUE);
      if (node.isScrollable()) compact.put("scrollable", Boolean.TRUE);
      out.add(compact);
    }

    int childCount = node.getChildCount();
    for (int i = 0; i < childCount; i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      if (child != null) {
        try {
          collectCompactNodes(child, out, depth + 1);
        } finally {
          child.recycle();
        }
      }
    }
  }

  private Map<String, Object> dumpXml() throws Exception {
    Map<String, Object> response = new LinkedHashMap<String, Object>();
    response.put("ok", true);
    response.put("xml", dumpXmlString());
    return response;
  }

  private String dumpXmlString() throws Exception {
    device.waitForIdle(500);
    device.dumpWindowHierarchy(DUMP_FILE.getAbsolutePath());
    StringBuilder builder = new StringBuilder();
    BufferedReader reader = new BufferedReader(new FileReader(DUMP_FILE));
    try {
      String line;
      while ((line = reader.readLine()) != null) {
        builder.append(line);
      }
    } finally {
      reader.close();
    }
    return builder.toString();
  }

  private static Object invokeNoArg(Object target, String methodName) throws Exception {
    Method method = findNoArgMethod(target.getClass(), methodName);
    method.setAccessible(true);
    return method.invoke(target);
  }

  private static Method findNoArgMethod(Class<?> type, String methodName) throws NoSuchMethodException {
    Class<?> current = type;
    while (current != null) {
      try {
        return current.getDeclaredMethod(methodName);
      } catch (NoSuchMethodException ignored) {
        current = current.getSuperclass();
      }
    }
    throw new NoSuchMethodException(type.getName() + "." + methodName + " []");
  }

  private static Object readField(Object target, String fieldName) throws Exception {
    Field field = target.getClass().getDeclaredField(fieldName);
    field.setAccessible(true);
    return field.get(target);
  }

  private static String charSequenceToString(CharSequence value) {
    return value == null ? "" : value.toString();
  }

  private static String rectToString(Rect rect) {
    return "[" + rect.left + "," + rect.top + "][" + rect.right + "," + rect.bottom + "]";
  }

  private static Map<String, Object> ok(String key, Object value) {
    Map<String, Object> response = new LinkedHashMap<String, Object>();
    response.put("ok", true);
    response.put(key, value);
    return response;
  }

  private static Map<String, Object> bool(String key, boolean value) {
    return ok(key, Boolean.valueOf(value));
  }

  private static int intParam(Map<String, String> request, String key) {
    return intParam(request, key, null);
  }

  private static int intParam(Map<String, String> request, String key, Integer defaultValue) {
    String value = request.get(key);
    if (value == null && defaultValue != null) {
      return defaultValue.intValue();
    }
    if (value == null) {
      throw new IllegalArgumentException("missing " + key);
    }
    return Integer.parseInt(value);
  }

  private static int keyCode(String key) {
    if ("BACK".equals(key)) return KeyEvent.KEYCODE_BACK;
    if ("HOME".equals(key)) return KeyEvent.KEYCODE_HOME;
    if ("ENTER".equals(key)) return KeyEvent.KEYCODE_ENTER;
    if ("APP_SWITCH".equals(key)) return KeyEvent.KEYCODE_APP_SWITCH;
    if ("DEL".equals(key)) return KeyEvent.KEYCODE_DEL;
    throw new IllegalArgumentException("unknown key: " + key);
  }

  private static String attr(XmlPullParser parser, String name) {
    String value = parser.getAttributeValue(null, name);
    return value == null ? "" : value;
  }

  private static void putIfPresent(Map<String, Object> map, String key, String value) {
    if (!isEmpty(value)) {
      map.put(key, value);
    }
  }

  private static void putBooleanIfTrue(Map<String, Object> map, String key, String value) {
    if ("true".equals(value)) {
      map.put(key, Boolean.TRUE);
    }
  }

  private static boolean isEmpty(String value) {
    return value == null || value.length() == 0;
  }
}
