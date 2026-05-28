package com.example.androiduiserver

import java.util.LinkedHashMap

internal object MiniJson {
  fun parseObject(json: String?): Map<String, String> {
    return Parser(json ?: "").parseObject()
  }

  fun stringify(value: Any?): String {
    val builder = StringBuilder()
    writeValue(builder, value)
    return builder.toString()
  }

  private fun writeValue(builder: StringBuilder, value: Any?) {
    when (value) {
      null -> builder.append("null")
      is String -> writeString(builder, value)
      is Number, is Boolean -> builder.append(value)
      is Map<*, *> -> writeMap(builder, value)
      is List<*> -> writeList(builder, value)
      else -> writeString(builder, value.toString())
    }
  }

  private fun writeMap(builder: StringBuilder, map: Map<*, *>) {
    builder.append('{')
    val iterator = map.entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      writeString(builder, entry.key.toString())
      builder.append(':')
      writeValue(builder, entry.value)
      if (iterator.hasNext()) {
        builder.append(',')
      }
    }
    builder.append('}')
  }

  private fun writeList(builder: StringBuilder, list: List<*>) {
    builder.append('[')
    for (index in list.indices) {
      if (index > 0) {
        builder.append(',')
      }
      writeValue(builder, list[index])
    }
    builder.append(']')
  }

  private fun writeString(builder: StringBuilder, value: String) {
    builder.append('"')
    for (char in value) {
      when (char) {
        '"' -> builder.append("\\\"")
        '\\' -> builder.append("\\\\")
        '\n' -> builder.append("\\n")
        '\r' -> builder.append("\\r")
        '\t' -> builder.append("\\t")
        else -> {
          if (char.code < 0x20) {
            val hex = char.code.toString(16)
            builder.append("\\u")
            for (pad in hex.length until 4) {
              builder.append('0')
            }
            builder.append(hex)
          } else {
            builder.append(char)
          }
        }
      }
    }
    builder.append('"')
  }

  private class Parser(private val input: String) {
    private var index = 0

    fun parseObject(): Map<String, String> {
      val map = LinkedHashMap<String, String>()
      skipWhitespace()
      expect('{')
      skipWhitespace()
      if (peek() == '}') {
        index++
        return map
      }
      while (true) {
        val key = parseString()
        skipWhitespace()
        expect(':')
        skipWhitespace()
        map[key] = parseScalarAsString()
        skipWhitespace()
        when (peek()) {
          ',' -> {
            index++
            skipWhitespace()
          }
          '}' -> {
            index++
            return map
          }
          else -> throw IllegalArgumentException("expected ',' or '}' at $index")
        }
      }
    }

    private fun parseScalarAsString(): String {
      var char = peek()
      if (char == '"') {
        return parseString()
      }
      val start = index
      while (index < input.length) {
        char = input[index]
        if (char == ',' || char == '}' || char.isWhitespace()) {
          break
        }
        index++
      }
      return input.substring(start, index)
    }

    private fun parseString(): String {
      expect('"')
      val builder = StringBuilder()
      while (index < input.length) {
        val char = input[index++]
        if (char == '"') {
          return builder.toString()
        }
        if (char == '\\') {
          if (index >= input.length) {
            throw IllegalArgumentException("unterminated escape")
          }
          when (val escaped = input[index++]) {
            '"', '\\', '/' -> builder.append(escaped)
            'n' -> builder.append('\n')
            'r' -> builder.append('\r')
            't' -> builder.append('\t')
            else -> throw IllegalArgumentException("unsupported escape: $escaped")
          }
        } else {
          builder.append(char)
        }
      }
      throw IllegalArgumentException("unterminated string")
    }

    private fun expect(expected: Char) {
      if (peek() != expected) {
        throw IllegalArgumentException("expected '$expected' at $index")
      }
      index++
    }

    private fun peek(): Char {
      return if (index >= input.length) '\u0000' else input[index]
    }

    private fun skipWhitespace() {
      while (index < input.length && input[index].isWhitespace()) {
        index++
      }
    }
  }
}
