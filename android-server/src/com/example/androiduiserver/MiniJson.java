package com.example.androiduiserver;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class MiniJson {
  private MiniJson() {}

  static Map<String, String> parseObject(String json) {
    Parser parser = new Parser(json);
    return parser.parseObject();
  }

  static String stringify(Object value) {
    StringBuilder builder = new StringBuilder();
    writeValue(builder, value);
    return builder.toString();
  }

  private static void writeValue(StringBuilder builder, Object value) {
    if (value == null) {
      builder.append("null");
    } else if (value instanceof String) {
      writeString(builder, (String) value);
    } else if (value instanceof Number || value instanceof Boolean) {
      builder.append(value);
    } else if (value instanceof Map) {
      writeMap(builder, (Map<?, ?>) value);
    } else if (value instanceof List) {
      writeList(builder, (List<?>) value);
    } else {
      writeString(builder, String.valueOf(value));
    }
  }

  private static void writeMap(StringBuilder builder, Map<?, ?> map) {
    builder.append('{');
    Iterator<? extends Map.Entry<?, ?>> iterator = map.entrySet().iterator();
    while (iterator.hasNext()) {
      Map.Entry<?, ?> entry = iterator.next();
      writeString(builder, String.valueOf(entry.getKey()));
      builder.append(':');
      writeValue(builder, entry.getValue());
      if (iterator.hasNext()) {
        builder.append(',');
      }
    }
    builder.append('}');
  }

  private static void writeList(StringBuilder builder, List<?> list) {
    builder.append('[');
    for (int i = 0; i < list.size(); i++) {
      if (i > 0) {
        builder.append(',');
      }
      writeValue(builder, list.get(i));
    }
    builder.append(']');
  }

  private static void writeString(StringBuilder builder, String value) {
    builder.append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"':
          builder.append("\\\"");
          break;
        case '\\':
          builder.append("\\\\");
          break;
        case '\n':
          builder.append("\\n");
          break;
        case '\r':
          builder.append("\\r");
          break;
        case '\t':
          builder.append("\\t");
          break;
        default:
          if (c < 0x20) {
            String hex = Integer.toHexString(c);
            builder.append("\\u");
            for (int pad = hex.length(); pad < 4; pad++) {
              builder.append('0');
            }
            builder.append(hex);
          } else {
            builder.append(c);
          }
      }
    }
    builder.append('"');
  }

  private static final class Parser {
    private final String input;
    private int index;

    Parser(String input) {
      this.input = input == null ? "" : input;
    }

    Map<String, String> parseObject() {
      Map<String, String> map = new LinkedHashMap<String, String>();
      skipWhitespace();
      expect('{');
      skipWhitespace();
      if (peek() == '}') {
        index++;
        return map;
      }
      while (true) {
        String key = parseString();
        skipWhitespace();
        expect(':');
        skipWhitespace();
        map.put(key, parseScalarAsString());
        skipWhitespace();
        char next = peek();
        if (next == ',') {
          index++;
          skipWhitespace();
        } else if (next == '}') {
          index++;
          return map;
        } else {
          throw new IllegalArgumentException("expected ',' or '}' at " + index);
        }
      }
    }

    private String parseScalarAsString() {
      char c = peek();
      if (c == '"') {
        return parseString();
      }
      int start = index;
      while (index < input.length()) {
        c = input.charAt(index);
        if (c == ',' || c == '}' || Character.isWhitespace(c)) {
          break;
        }
        index++;
      }
      return input.substring(start, index);
    }

    private String parseString() {
      expect('"');
      StringBuilder builder = new StringBuilder();
      while (index < input.length()) {
        char c = input.charAt(index++);
        if (c == '"') {
          return builder.toString();
        }
        if (c == '\\') {
          if (index >= input.length()) {
            throw new IllegalArgumentException("unterminated escape");
          }
          char escaped = input.charAt(index++);
          if (escaped == '"' || escaped == '\\' || escaped == '/') {
            builder.append(escaped);
          } else if (escaped == 'n') {
            builder.append('\n');
          } else if (escaped == 'r') {
            builder.append('\r');
          } else if (escaped == 't') {
            builder.append('\t');
          } else {
            throw new IllegalArgumentException("unsupported escape: " + escaped);
          }
        } else {
          builder.append(c);
        }
      }
      throw new IllegalArgumentException("unterminated string");
    }

    private void expect(char expected) {
      if (peek() != expected) {
        throw new IllegalArgumentException("expected '" + expected + "' at " + index);
      }
      index++;
    }

    private char peek() {
      if (index >= input.length()) {
        return '\0';
      }
      return input.charAt(index);
    }

    private void skipWhitespace() {
      while (index < input.length() && Character.isWhitespace(input.charAt(index))) {
        index++;
      }
    }
  }
}
