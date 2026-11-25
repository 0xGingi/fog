// swift-tools-version:5.5
import PackageDescription

let package = Package(
  name: "tauri-plugin-fog",
  platforms: [.iOS("26.0")],
  products: [.library(name: "tauri-plugin-fog", type: .static, targets: ["tauri-plugin-fog"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-fog", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
