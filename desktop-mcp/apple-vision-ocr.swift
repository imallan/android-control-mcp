import Foundation
import Vision
import ImageIO
import CoreGraphics

struct CliError: Error, CustomStringConvertible {
  let description: String
}

func jsonWrite(_ value: Any) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

func loadImage(_ url: URL) throws -> (image: CGImage, width: Double, height: Double) {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
        let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw CliError(description: "Unable to read image dimensions.")
  }
  return (image, width.doubleValue, height.doubleValue)
}

func supportedLanguages() throws -> [String] {
  if #available(macOS 11.0, *) {
    return try VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: VNRecognizeTextRequestRevision3)
  }
  return []
}

func parseArgs(_ args: [String]) throws -> (imagePath: String?, languages: [String], listLanguages: Bool) {
  var imagePath: String?
  var languages = ["zh-Hans", "en-US"]
  var listLanguages = false
  var index = 0

  while index < args.count {
    let arg = args[index]
    if arg == "--list-languages" {
      listLanguages = true
      index += 1
    } else if arg == "--langs" {
      guard index + 1 < args.count else {
        throw CliError(description: "--langs requires a comma-separated language list.")
      }
      languages = args[index + 1]
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      index += 2
    } else if imagePath == nil {
      imagePath = arg
      index += 1
    } else {
      throw CliError(description: "Unexpected argument: \(arg)")
    }
  }

  return (imagePath, languages, listLanguages)
}

func recognize(imagePath: String, languages: [String]) throws -> [[String: Any]] {
  let url = URL(fileURLWithPath: imagePath)
  let loaded = try loadImage(url)
  var output: [[String: Any]] = []
  var requestError: Error?

  let request = VNRecognizeTextRequest { request, error in
    if let error = error {
      requestError = error
      return
    }

    guard let observations = request.results as? [VNRecognizedTextObservation] else {
      return
    }

    for observation in observations {
      guard let candidate = observation.topCandidates(1).first else {
        continue
      }
      let rect = observation.boundingBox
      let x1 = max(0, Int((rect.minX * loaded.width).rounded()))
      let y1 = max(0, Int(((1.0 - rect.maxY) * loaded.height).rounded()))
      let x2 = min(Int(loaded.width), Int((rect.maxX * loaded.width).rounded()))
      let y2 = min(Int(loaded.height), Int(((1.0 - rect.minY) * loaded.height).rounded()))
      if x2 <= x1 || y2 <= y1 {
        continue
      }

      output.append([
        "text": candidate.string,
        "confidence": Int((candidate.confidence * 100.0).rounded()),
        "bounds": [x1, y1, x2, y2]
      ])
    }
  }

  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  if !languages.isEmpty {
    request.recognitionLanguages = languages
  }

  let handler = VNImageRequestHandler(cgImage: loaded.image, orientation: .up, options: [:])
  try handler.perform([request])
  if let requestError = requestError {
    throw requestError
  }
  return output
}

do {
  let parsed = try parseArgs(Array(CommandLine.arguments.dropFirst()))
  if parsed.listLanguages {
    try jsonWrite(["languages": try supportedLanguages()])
  } else {
    guard let imagePath = parsed.imagePath else {
      throw CliError(description: "Usage: apple-vision-ocr <image> [--langs zh-Hans,en-US]")
    }
    try jsonWrite(["engine": "apple-vision", "nodes": try recognize(imagePath: imagePath, languages: parsed.languages)])
  }
} catch {
  let nsError = error as NSError
  let message = "\(nsError.domain):\(nsError.code): \(nsError.localizedDescription)"
  FileHandle.standardError.write(Data(message.utf8))
  FileHandle.standardError.write(Data([0x0a]))
  exit(1)
}
