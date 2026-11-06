import AppKit
import CoreImage

func render(
    _ source: String, to target: String, size: Int,
    draw: (NSImage, NSRect) throws -> Void = { image, bounds in
        image.draw(in: bounds, from: .zero, operation: .copy, fraction: 1)
    }
) throws {
    guard let image = NSImage(contentsOfFile: source),
          let bitmap = NSBitmapImageRep(
              bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
              colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
          ),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: source])
    }
    let bounds = NSRect(x: 0, y: 0, width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    try draw(image, bounds)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: target])
    }
    try data.write(to: URL(fileURLWithPath: target), options: .atomic)
}

try render("assets/copyx-master.png", to: "assets/icon.png", size: 1024)
try render("assets/copyx-tray.svg", to: "assets/trayTemplate.png", size: 18)
try render("assets/copyx-tray.svg", to: "assets/trayTemplate@2x.png", size: 36)

// 平台资源统一从主图生成，临时目录避免混入移动端图标。
let temporaryDirectory = FileManager.default.temporaryDirectory
    .appendingPathComponent("copyx-icons-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporaryDirectory) }
let macSource = temporaryDirectory.appendingPathComponent("macos.png")
let macIconMargin: CGFloat = 100
try render("assets/icon.png", to: macSource.path, size: 1024) { _, bounds in
    // 清除主图外缘的半透明阴影，让 macOS 将其识别为标准圆角图标。
    let tile = bounds.insetBy(dx: macIconMargin, dy: macIconMargin)
    NSBezierPath(roundedRect: tile, xRadius: 180, yRadius: 180).addClip()
    NSColor.white.setFill()
    tile.fill()
    guard let source = CIImage(contentsOf: URL(fileURLWithPath: "assets/icon.png")) else {
        throw CocoaError(.fileReadCorruptFile)
    }
    // 用蓝通道与红绿均值的差值分离小熊头像，滤掉原稿的浅灰底色与外缘阴影。
    let blueContrast = CIVector(x: -5, y: -5, z: 10, w: 0)
    let mask = source.applyingFilter("CIColorMatrix", parameters: [
        "inputRVector": blueContrast,
        "inputGVector": blueContrast,
        "inputBVector": blueContrast,
        "inputBiasVector": CIVector(x: -0.55, y: -0.55, z: -0.55, w: 0),
    ]).applyingFilter("CIColorClamp")
    let artwork = source.applyingFilter("CIBlendWithMask", parameters: [
        kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: bounds),
        kCIInputMaskImageKey: mask,
    ])
    let figure = NSImage(size: bounds.size)
    figure.addRepresentation(NSCIImageRep(ciImage: artwork))
    let artworkPadding = bounds.width * 0.07
    figure.draw(in: bounds.insetBy(dx: artworkPadding, dy: artworkPadding))
}

try render(macSource.path, to: "assets/copyx-brand.png", size: 128) { image, bounds in
    // 界面小图沿用系统图稿，裁掉图标画布外围留白以对齐侧栏文字。
    let outset = bounds.width * macIconMargin / (1024 - 2 * macIconMargin)
    image.draw(in: bounds.insetBy(dx: -outset, dy: -outset))
}

func generatePlatformIcon(_ name: String, source: String) throws {
    let output = temporaryDirectory.appendingPathComponent(name + "-output")
    let generator = Process()
    generator.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    generator.arguments = ["npx", "--no-install", "tauri", "icon", source, "--output", output.path]
    try generator.run()
    generator.waitUntilExit()
    guard generator.terminationStatus == 0 else {
        throw NSError(domain: "CopyX 图标生成", code: Int(generator.terminationStatus),
                      userInfo: [NSLocalizedDescriptionKey: "平台图标生成失败，请检查本地 Tauri CLI"])
    }
    let data = try Data(contentsOf: output.appendingPathComponent(name))
    try data.write(to: URL(fileURLWithPath: "src-tauri/icons/\(name)"), options: .atomic)
}

try generatePlatformIcon("icon.icns", source: macSource.path)
try generatePlatformIcon("icon.ico", source: "assets/icon.png")
print("CopyX 应用图标与菜单栏图标已同步生成")
