package org.getfog.plugin

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.URL
import kotlin.concurrent.thread

private const val RELEASES = "https://github.com/0xGingi/fog/releases/latest/download"

@TauriPlugin
class FogPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) {
        // Pushes arrive while Fog is closed, so the channel (heads-up, with sound) must exist up front.
        activity.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel("messages", "Messages", NotificationManager.IMPORTANCE_HIGH))
        checkForUpdate()
    }

    // Opening Fog clears its "New message" notifications.
    override fun onResume(activity: AppCompatActivity) {
        activity.getSystemService(NotificationManager::class.java).cancelAll()
    }

    /** This install's push token (FCM). Asks for notification permission on Android 13+ the first time. */
    @Command
    fun token(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        // Built without google-services.json: no push, Fog notifies only while it's open.
        if (FirebaseApp.getApps(activity).isEmpty()) return invoke.reject("push isn't set up in this build")
        FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
            if (t.isSuccessful) invoke.resolve(JSObject().apply { put("token", t.result) }) else invoke.reject(t.exception?.message ?: "no push token")
        }
    }

    /**
     * Updates: offer the newest release's APK. Android itself checks it's signed with the same key as
     * the installed app before it installs anything, so a swapped download can't take over Fog.
     */
    private fun checkForUpdate() = thread {
        try {
            val latest = JSONObject(URL("$RELEASES/latest.json").readText()).getString("version").removePrefix("v")
            val mine = activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: return@thread
            if (!newer(latest, mine)) return@thread
            activity.runOnUiThread {
                AlertDialog.Builder(activity)
                    .setTitle("Update available")
                    .setMessage("Fog $latest is out (you have $mine). Download and install it now?")
                    .setPositiveButton("Update") { _, _ -> download(latest) }
                    .setNegativeButton("Later", null)
                    .show()
            }
        } catch (_: Exception) {
            // Offline or no release yet: ask again next launch.
        }
    }

    private fun download(version: String) {
        val dm = activity.getSystemService(DownloadManager::class.java)
        val id = dm.enqueue(
            DownloadManager.Request(Uri.parse("$RELEASES/Fog-Android.apk"))
                .setTitle("Fog $version")
                .setMimeType("application/vnd.android.package-archive")
                .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, "Fog-$version.apk")
        )
        val done = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return
                activity.unregisterReceiver(this)
                val apk = dm.getUriForDownloadedFile(id) ?: return
                activity.startActivity(
                    Intent(Intent.ACTION_VIEW)
                        .setDataAndType(apk, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
        ContextCompat.registerReceiver(activity, done, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED)
    }
}

/** "0.10.0" > "0.9.3": compare dotted numbers part by part. */
internal fun newer(a: String, b: String): Boolean {
    val x = a.split('.').map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    val y = b.split('.').map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(x.size, y.size)) {
        val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
        if (d != 0) return d > 0
    }
    return false
}
