import SwiftRs
import Tauri
import UIKit
import UserNotifications
import WebKit

/// Push notifications, and making the web view behave like a native screen around the keyboard.
class FogPlugin: Plugin {
  static var waiting: [Invoke] = []
  static var hooked = false
  var offset: NSKeyValueObservation?

  override func load(webview: WKWebView) {
    FogPlugin.makeRingtone()
    FogPlugin.hideKeyboardToolbar(webview)
    FogPlugin.reloadIfKilled(webview)
    fitAboveKeyboard(webview)
    // Opening Fog clears its "New message" notifications.
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
      UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }
  }

  @objc public func token(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
      DispatchQueue.main.async {
        FogPlugin.hook()
        FogPlugin.waiting.append(invoke)
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
  }

  /// The keyboard: report its height and slide duration to the page the moment iOS starts moving
  /// it, and the page moves with it (main.tsx). WebKit's own approach (scrolling the whole page up under the status bar) is
  /// turned off: the page never scrolls as a whole, only its chat list and panels do.
  func fitAboveKeyboard(_ webview: WKWebView) {
    let scroll = webview.scrollView
    scroll.isScrollEnabled = false
    scroll.contentInsetAdjustmentBehavior = .never
    offset = scroll.observe(\.contentOffset) { view, _ in
      if view.contentOffset != .zero { view.contentOffset = .zero }
    }
    NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak webview] note in
      guard let webview, let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
      // Only our own keyboard. System sheets that run in another process (the photo picker, for one)
      // are reported like a keyboard covering the whole screen, which would squeeze Fog to nothing.
      if (note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) == false { return }
      let keyboard = webview.convert(end, from: nil)
      let covered = Int(max(0, webview.bounds.maxY - keyboard.minY).rounded())
      if CGFloat(covered) > webview.bounds.height * 0.7 { return } // no real keyboard is that tall
      let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
      webview.evaluateJavaScript("window.__fogKeyboard?.(\(covered), \(duration))")
    }
  }

  /// Incoming-call pushes ring with "fog-ring.wav", which iOS looks for in Library/Sounds. It's made
  /// here (the same two-note chime the app plays in-call, repeated for 28 s; iOS caps it at 30 s), so
  /// there's no audio file to ship.
  static func makeRingtone() {
    guard let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
    let dir = lib.appendingPathComponent("Sounds")
    let file = dir.appendingPathComponent("fog-ring.wav")
    if FileManager.default.fileExists(atPath: file.path) { return }
    let rate = 22_050.0
    let seconds = 28.0
    var pcm = [Int16](repeating: 0, count: Int(rate * seconds))
    let notes: [(Double, Double)] = [(784, 0), (988, 0.18), (784, 0.6), (988, 0.78)]
    var start = 0.0
    while start < seconds {
      for (freq, at) in notes {
        let begin = Int((start + at) * rate)
        let len = Int(0.16 * rate)
        for i in 0..<len where begin + i < pcm.count {
          let t = Double(i) / rate
          let env = min(1, t / 0.02) * min(1, (0.16 - t) / 0.05) // soft attack and release
          pcm[begin + i] = Int16(sin(2 * .pi * freq * t) * env * 0.5 * Double(Int16.max))
        }
      }
      start += 2.2
    }
    var data = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    let body = UInt32(pcm.count * 2)
    data.append(contentsOf: Array("RIFF".utf8)); u32(36 + body); data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
    data.append(contentsOf: Array("data".utf8)); u32(body)
    pcm.withUnsafeBytes { data.append(contentsOf: $0) }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? data.write(to: file)
  }

  /// iOS can end the web view's process (usually for memory, e.g. decoding a huge photo), which
  /// leaves a blank screen. Reload instead: everything is saved on the device, so Fog comes back
  /// where it was. (Tauri owns the navigation delegate, so the callback is added to its class.)
  static func reloadIfKilled(_ webview: WKWebView) {
    guard let delegate = webview.navigationDelegate else { return }
    let reload: @convention(block) (AnyObject, WKWebView) -> Void = { _, view in view.reload() }
    class_addMethod(type(of: delegate), #selector(WKNavigationDelegate.webViewWebContentProcessDidTerminate(_:)), imp_implementationWithBlock(reload), "v@:@")
  }

  /// Web views put a form toolbar (up / down / done) above the keyboard. A chat app doesn't want it:
  /// swap the web content view for a subclass whose input accessory view is nothing.
  static func hideKeyboardToolbar(_ webview: WKWebView) {
    guard let content = webview.scrollView.subviews.first(where: { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }) else { return }
    let base: AnyClass = type(of: content)
    let name = "Fog_\(NSStringFromClass(base))"
    var cls: AnyClass? = NSClassFromString(name)
    if cls == nil, let made = objc_allocateClassPair(base, name, 0) {
      let none: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
      class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(none), "@@:")
      objc_registerClassPair(made)
      cls = made
    }
    if let cls { object_setClass(content, cls) }
  }

  static func finish(_ done: (Invoke) -> Void) {
    waiting.forEach(done)
    waiting = []
  }

  static func hook() {
    guard !hooked, let delegate = UIApplication.shared.delegate else { return }
    hooked = true
    let cls: AnyClass = type(of: delegate)
    let registered: @convention(block) (AnyObject, UIApplication, Data) -> Void = { _, _, token in
      let hex = token.map { String(format: "%02x", $0) }.joined()
      FogPlugin.finish { $0.resolve(["token": hex]) }
    }
    let failed: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
      FogPlugin.finish { $0.reject(error.localizedDescription) }
    }
    class_addMethod(cls, NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:"), imp_implementationWithBlock(registered), "v@:@@")
    class_addMethod(cls, NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:"), imp_implementationWithBlock(failed), "v@:@@")
  }
}

@_cdecl("init_plugin_fog")
func initPlugin() -> Plugin {
  return FogPlugin()
}
