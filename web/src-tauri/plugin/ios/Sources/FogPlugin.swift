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
    FogPlugin.hideKeyboardToolbar(webview)
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
      let keyboard = webview.convert(end, from: nil)
      let covered = Int(max(0, webview.bounds.maxY - keyboard.minY).rounded())
      let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
      webview.evaluateJavaScript("window.__fogKeyboard?.(\(covered), \(duration))")
    }
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
