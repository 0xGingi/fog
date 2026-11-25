package org.getfog.app

import android.app.KeyguardManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    overLockScreen(intent)
    // Edge-to-edge, but Android's web view doesn't reliably report the system bars or the keyboard to
    // the page. Keep the web view inside them instead: the message box is never covered, and the chat
    // resizes when the keyboard opens. The strips behind the bars match Fog's light/dark panel colour.
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    window.decorView.setBackgroundColor(if (night) Color.parseColor("#17202a") else Color.WHITE)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    overLockScreen(intent)
  }

  // Opened by an incoming call's ringing screen: wake the screen and ask for the fingerprint, face or
  // PIN right away, so answering is one unlock. Fog itself never shows over the lock screen (it's
  // the whole app, chats included, not just a call screen); cancel the unlock and it stays behind it.
  private fun overLockScreen(intent: Intent?) {
    if (intent?.getBooleanExtra("fog_call", false) != true) return
    intent.removeExtra("fog_call")
    setTurnScreenOn(true)
    val keyguard = getSystemService(KeyguardManager::class.java)
    if (!keyguard.isKeyguardLocked) return
    // Shown over the lock screen only so the unlock prompt can appear, and blank until it succeeds:
    // nothing of Fog (names, messages) is visible on a locked phone.
    val content = findViewById<View>(android.R.id.content)
    content.visibility = View.INVISIBLE
    setShowWhenLocked(true)
    val done = { content.visibility = View.VISIBLE; setShowWhenLocked(false) }
    keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
      override fun onDismissSucceeded() = done()
      override fun onDismissCancelled() = done()
      override fun onDismissError() = done()
    })
  }
}
