import Foundation
import CoreGraphics
import CoreImage
import ImageIO

// apple-vision-detect — Detect visual UI elements (icons, buttons, cards) from
// Android screenshots using CoreImage edge detection + grid-based region analysis.
//
// Usage: apple-vision-detect <image> [--min-size <px>] [--max-size <px>] [--edge-threshold <0-1>]
//
// Returns newline-delimited JSON with detected element bounds.

struct CliError: Error, CustomStringConvertible {
  let description: String
}

func jsonWrite(_ value: Any) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

func loadCgImage(_ url: URL) throws -> (image: CGImage, width: Int, height: Int) {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let pxW = properties[kCGImagePropertyPixelWidth] as? NSNumber,
        let pxH = properties[kCGImagePropertyPixelHeight] as? NSNumber,
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw CliError(description: "Unable to read image at \(url.path)")
  }
  return (image, pxW.intValue, pxH.intValue)
}

/// Render a CIImage to a single-channel (luminance) pixel array for analysis.
/// Works at a capped resolution for performance.
func renderEdgeMap(_ ciImage: CIImage, width: Int, height: Int) throws -> (pixels: [UInt8], width: Int, height: Int) {
  let maxDim = 1024
  let scale: Double
  if width > maxDim || height > maxDim {
    scale = Double(maxDim) / Double(max(width, height))
  } else {
    scale = 1.0
  }
  let workW = max(1, Int(Double(width) * scale))
  let workH = max(1, Int(Double(height) * scale))

  let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

  // Render to RGBA8 using the default working color space — most compatible path.
  let ctx = CIContext()
  guard let cg = ctx.createCGImage(scaled, from: CGRect(x: 0, y: 0, width: workW, height: workH)) else {
    throw CliError(description: "Failed to render edge map to CGImage.")
  }

  // Draw into a raw RGBA8 bitmap so we can read per-pixel values.
  let bytesPerRow = workW * 4
  var buf = [UInt8](repeating: 0, count: workH * bytesPerRow)
  guard let colorSpace = cg.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
        let ctx2 = CGContext(data: &buf, width: workW, height: workH,
                             bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                             space: colorSpace,
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw CliError(description: "Failed to create bitmap context for edge map.")
  }
  ctx2.draw(cg, in: CGRect(x: 0, y: 0, width: CGFloat(workW), height: CGFloat(workH)))

  // Extract luminance (weighted RGB → grayscale)
  var lum: [UInt8] = []
  lum.reserveCapacity(workW * workH)
  for i in stride(from: 0, to: buf.count, by: 4) {
    let r = Int32(buf[i])
    let g = Int32(buf[i + 1])
    let b = Int32(buf[i + 2])
    // Perceptual luminance weights, clamped to 0–255
    let y = min(255, max(0, (r * 77 + g * 150 + b * 29 + 128) >> 8))
    lum.append(UInt8(y))
  }

  return (lum, workW, workH)
}

/// Build an edge-map CIImage using a series of CoreImage filters.
func buildEdgeMap(from cgImage: CGImage) -> CIImage {
  var ci = CIImage(cgImage: cgImage)

  // 1. Desaturate via CIColorControls (more reliable than CIPhotoEffectMono)
  ci = ci.applyingFilter("CIColorControls", parameters: [
    kCIInputSaturationKey: 0.0,
    kCIInputContrastKey: 1.1
  ])

  // 2. Edge detection — CIEdges gives bright edges on dark background.
  ci = ci.applyingFilter("CIEdges", parameters: [kCIInputIntensityKey: 2.0])

  // 3. Dilate edges so nearby edge pixels merge into connected blobs.
  //    A UI icon/button typically has many edges close together.
  ci = ci.applyingFilter("CIMorphologyRectangleMaximum", parameters: [
    "inputWidth": 6,
    "inputHeight": 6
  ])

  return ci
}

/// Grid-based connected-component analysis on the edge map.
/// Divides the image into cells, marks high-edge-density cells, then
/// extracts bounding rectangles around connected high-density regions.
func extractRegions(pixels: [UInt8], width: Int, height: Int,
                    minCellEdgePct: Float, cellSize: Int,
                    minArea: Int, maxArea: Int,
                    scale: Double) -> [[String: Any]] {

  let cols = width / cellSize
  let rows = height / cellSize
  guard cols >= 2 && rows >= 2 else { return [] }

  // Build a grid mask: true = high edge density
  var grid = [Bool](repeating: false, count: cols * rows)
  for row in 0..<rows {
    for col in 0..<cols {
      var edgeCount = 0
      var totalCount = 0
      let startY = row * cellSize
      let endY = min(startY + cellSize, height)
      let startX = col * cellSize
      let endX = min(startX + cellSize, width)
      for y in startY..<endY {
        let rowOffset = y * width
        for x in startX..<endX {
          totalCount += 1
          if pixels[rowOffset + x] > 70 {
            edgeCount += 1
          }
        }
      }
      let density = Float(edgeCount) / Float(max(1, totalCount))
      grid[row * cols + col] = density >= minCellEdgePct
    }
  }

  // Flood-fill connected high-density cells
  var visited = [Bool](repeating: false, count: cols * rows)
  var regions: [(r1: Int, c1: Int, r2: Int, c2: Int)] = []

  for row in 0..<rows {
    for col in 0..<cols {
      let idx = row * cols + col
      guard grid[idx] && !visited[idx] else { continue }

      // BFS
      var stack = [(row, col)]
      visited[idx] = true
      var r1 = row, c1 = col, r2 = row, c2 = col

      while let (r, c) = stack.popLast() {
        r1 = min(r1, r); c1 = min(c1, c)
        r2 = max(r2, r); c2 = max(c2, c)
        for dr in -1...1 {
          for dc in -1...1 {
            let nr = r + dr, nc = c + dc
            guard nr >= 0 && nr < rows && nc >= 0 && nc < cols else { continue }
            let nidx = nr * cols + nc
            guard grid[nidx] && !visited[nidx] else { continue }
            visited[nidx] = true
            stack.append((nr, nc))
          }
        }
      }
      if r1 <= r2 && c1 <= c2 {
        regions.append((r1, c1, r2, c2))
      }
    }
  }

  // Convert grid coords back to image pixel coords, filter by size
  let inverseScale = 1.0 / max(scale, 0.001)
  var results: [[String: Any]] = []

  for (r1, c1, r2, c2) in regions {
    let x1 = Int(Double(c1 * cellSize) * inverseScale)
    let y1 = Int(Double(r1 * cellSize) * inverseScale)
    let x2 = Int(Double(min((c2 + 1) * cellSize, width)) * inverseScale)
    let y2 = Int(Double(min((r2 + 1) * cellSize, height)) * inverseScale)
    let w = x2 - x1
    let h = y2 - y1
    let area = w * h
    guard area >= minArea && area <= maxArea else { continue }
    let aspect = Double(w) / Double(max(1, h))
    guard aspect >= 0.15 && aspect <= 6.5 else { continue }

    // Confidence based on region compactness and size
    let compactness = min(1.0, Double(min(w, h)) / Double(max(w, h)))
    let sizeScore = min(1.0, Double(area) / Double(minArea * 4))
    let confidence = Int(((compactness * 0.4 + sizeScore * 0.6) * 100).rounded())

    results.append([
      "bounds": [x1, y1, x2, y2],
      "confidence": min(100, max(0, confidence)),
      "type": "icon_region"
    ])
  }

  return results
}

func detectElements(imagePath: String, minSize: Int, maxSize: Int, edgeThreshold: Float) throws -> [[String: Any]] {
  let url = URL(fileURLWithPath: imagePath)
  let (cgImage, width, height) = try loadCgImage(url)

  let edgeMap = buildEdgeMap(from: cgImage)
  let (pixels, workW, workH) = try renderEdgeMap(edgeMap, width: width, height: height)
  let scale = Double(workW) / Double(width)

  let cellSize = 14
  let minCellEdgePct = max(0.02, min(0.30, edgeThreshold))

  return extractRegions(pixels: pixels, width: workW, height: workH,
                        minCellEdgePct: minCellEdgePct, cellSize: cellSize,
                        minArea: minSize * minSize, maxArea: maxSize * maxSize,
                        scale: scale)
}

func parseArgs(_ args: [String]) throws -> (imagePath: String?, minSize: Int, maxSize: Int, edgeThreshold: Float) {
  var imagePath: String?
  var minSize = 28
  var maxSize = 320
  var edgeThreshold: Float = 0.06
  var index = 0

  while index < args.count {
    let arg = args[index]
    switch arg {
    case "--min-size":
      guard index + 1 < args.count else { throw CliError(description: "--min-size requires a value.") }
      minSize = max(12, Int(args[index + 1]) ?? 28)
      index += 2
    case "--max-size":
      guard index + 1 < args.count else { throw CliError(description: "--max-size requires a value.") }
      maxSize = max(minSize, Int(args[index + 1]) ?? 320)
      index += 2
    case "--edge-threshold":
      guard index + 1 < args.count else { throw CliError(description: "--edge-threshold requires a value.") }
      edgeThreshold = max(0.01, min(1.0, Float(args[index + 1]) ?? 0.06))
      index += 2
    default:
      if imagePath == nil {
        imagePath = arg
        index += 1
      } else {
        throw CliError(description: "Unexpected argument: \(arg)")
      }
    }
  }

  return (imagePath, minSize, maxSize, edgeThreshold)
}

do {
  let parsed = try parseArgs(Array(CommandLine.arguments.dropFirst()))
  guard let imagePath = parsed.imagePath else {
    throw CliError(description: "Usage: apple-vision-detect <image> [--min-size <px>] [--max-size <px>] [--edge-threshold <0-1>]")
  }

  let elements = try detectElements(
    imagePath: imagePath,
    minSize: parsed.minSize,
    maxSize: parsed.maxSize,
    edgeThreshold: parsed.edgeThreshold
  )

  try jsonWrite([
    "engine": "apple-vision-detect",
    "nodes": elements
  ])
} catch {
  let nsError = error as NSError
  let message = "apple-vision-detect: \(nsError.domain):\(nsError.code): \(nsError.localizedDescription)"
  FileHandle.standardError.write(Data(message.utf8))
  FileHandle.standardError.write(Data([0x0a]))
  exit(1)
}
