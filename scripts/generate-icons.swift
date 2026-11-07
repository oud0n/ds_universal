import AppKit

// macOS で実行: swift scripts/generate-icons.swift
// 元の SVG から、各配布先の画像をまとめて作り直す。
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("laploupe-icons-\(UUID().uuidString)")
try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }

func write(_ data: Data, _ path: String) throws {
    let url = root.appendingPathComponent(path)
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
}

func png(_ svg: String, size: Int, opaque: Bool = false) throws -> Data {
    guard let image = NSImage(data: Data(svg.utf8)),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
              bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
              bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast).rawValue)
    else { throw NSError(domain: "Icon", code: 1, userInfo: [NSLocalizedDescriptionKey: "SVG を描画できません"]) }
    context.interpolationQuality = .high
    context.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))
    guard let result = context.makeImage(),
          let data = NSBitmapImageRep(cgImage: result).representation(using: .png, properties: [:])
    else { throw NSError(domain: "Icon", code: 2) }
    return data
}

func content(_ svg: String) -> String {
    let start = svg.firstIndex(of: ">")!
    return String(svg[svg.index(after: start)..<svg.range(of: "</svg>", options: .backwards)!.lowerBound])
}

func rounded(_ body: String) -> String {
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1024 1024\" width=\"1024\" height=\"1024\"><defs><clipPath id=\"tile\"><rect width=\"1024\" height=\"1024\" rx=\"225\"/></clipPath></defs><g clip-path=\"url(#tile)\">\(body)</g></svg>"
}

let light = try String(contentsOf: root.appendingPathComponent("build/icon-ios.svg"), encoding: .utf8)
let dark = try String(contentsOf: root.appendingPathComponent("build/icon-ios-dark.svg"), encoding: .utf8)
func desktopTile(_ svg: String) -> String {
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1024 1024\" width=\"1024\" height=\"1024\"><defs><clipPath id=\"tile\"><rect x=\"100\" y=\"100\" width=\"824\" height=\"824\" rx=\"185\"/></clipPath></defs><g clip-path=\"url(#tile)\"><g transform=\"translate(100 100) scale(0.8046875)\">\(content(svg))</g></g></svg>"
}
let desktop = desktopTile(light)
let desktopDark = desktopTile(dark)
try write(Data((desktop + "\n").utf8), "build/icon.svg")
try write(Data((desktopDark + "\n").utf8), "build/icon-dark.svg")
try write(png(light, size: 1024, opaque: true), "build/icon-square.png")
try write(png(dark, size: 1024, opaque: true), "build/icon-square-dark.png")
try write(png(desktop, size: 1024), "build/icon.png")
try write(png(desktopDark, size: 1024), "build/icon-dark.png")
try write(png(desktop, size: 512), "electron/icons/icon.png")
try write(png(desktopDark, size: 512), "electron/icons/icon-dark.png")
try write(png(light, size: 180, opaque: true), "public/apple-touch-icon.png")
try write(png(rounded(content(light)), size: 32), "public/favicon-32.png")
try write(png(rounded(content(dark)), size: 32), "public/favicon-dark-32.png")
try write(png(light, size: 192, opaque: true), "mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")
try write(png(dark, size: 192, opaque: true), "mobile/android/app/src/main/res/mipmap-night-xxxhdpi/ic_launcher.png")

let favicon = rounded("<style>.dark{display:none}@media(prefers-color-scheme:dark){.light{display:none}.dark{display:inline}}</style><g class=\"light\">\(content(light))</g><g class=\"dark\">\(content(dark))</g>")
try write(Data((favicon + "\n").utf8), "public/favicon.svg")

// Windows の ICO は、複数サイズの PNG を格納する。
func le<T: FixedWidthInteger>(_ value: T) -> Data {
    var value = value.littleEndian
    return withUnsafeBytes(of: &value) { Data($0) }
}
let sizes = [16, 24, 32, 48, 64, 128, 256]
let frames = try sizes.map { try png(desktop, size: $0) }
var ico = le(UInt16(0)) + le(UInt16(1)) + le(UInt16(sizes.count))
var offset = 6 + sizes.count * 16
for (size, frame) in zip(sizes, frames) {
    ico += Data([UInt8(size % 256), UInt8(size % 256), 0, 0])
    ico += le(UInt16(1)) + le(UInt16(32)) + le(UInt32(frame.count)) + le(UInt32(offset))
    offset += frame.count
}
for frame in frames { ico += frame }
try write(ico, "build/icon.ico")

let iconset = scratch.appendingPathComponent("icon.iconset")
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    try png(desktop, size: size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try png(desktop, size: size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", root.appendingPathComponent("build/icon.icns").path]
try task.run()
task.waitUntilExit()
guard task.terminationStatus == 0 else { throw NSError(domain: "Icon", code: 3) }
print("iOS・Android・Web・PC のアイコンを更新しました")
