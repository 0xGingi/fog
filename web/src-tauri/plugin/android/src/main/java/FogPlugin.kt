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
import android.util.Log
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
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import android.app.Notification
import android.app.PendingIntent
import android.media.AudioAttributes
import android.media.RingtoneManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
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
        // Firebase hands the token to FogMessagingService (below). The last one is kept, so later
        // launches answer at once while register() refreshes it in the background.
        val saved = activity.getSharedPreferences("fog", Context.MODE_PRIVATE).getString("push", null)
        if (saved != null) invoke.resolve(JSObject().apply { put("token", saved) }) else synchronized(waiting) { waiting += invoke }
        FirebaseMessaging.getInstance().register().addOnFailureListener { e -> answer { it.reject(e.message ?: "no push token") } }
    }

    companion object {
        private val waiting = mutableListOf<Invoke>()

        fun answer(reply: (Invoke) -> Unit) = synchronized(waiting) {
            waiting.forEach(reply)
            waiting.clear()
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

/**
 * Receives this install's push token from Firebase (and any later replacement). Depending on the
 * phone's Google Play services version, register() reports it through onRegistered (newer) or
 * onNewToken (older), so both are handled; missing one left most Android installs without push.
 */
class FogMessagingService : FirebaseMessagingService() {
    override fun onRegistered(token: String) = save(token)

    override fun onNewToken(token: String) = save(token)

    private fun save(token: String) {
        Log.i("Fog", "push registration ready")
        getSharedPreferences("fog", Context.MODE_PRIVATE).edit().putString("push", token).apply()
        FogPlugin.answer { it.resolve(JSObject().apply { put("token", token) }) }
    }

    // Calls arrive as data-only pushes (messages are notifications Android shows by itself).
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["type"] == "call") Ringing.show(this)
    }
}

/**
 * An incoming call while Fog is closed: a full-screen ringing screen over the lock screen (or a
 * heads-up if Android doesn't allow full-screen), with the ringtone, until it's answered, declined
 * or 45 seconds pass. The push says only that there's a call; Fog shows who once it opens.
 */
object Ringing {
    private const val CHANNEL = "calls"
    private const val ID = 4242

    fun show(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Calls", NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                )
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 700, 800, 700)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
        val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)!!.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("fog_call", true)
        }
        val answer = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val decline = PendingIntent.getBroadcast(ctx, 1, Intent(ctx, DeclineCall::class.java), PendingIntent.FLAG_IMMUTABLE)
        val caller = Person.Builder().setName("Fog").setImportant(true).build()
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_fog_notification)
            .setContentTitle("Incoming call")
            .setContentText("Open Fog to answer")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(answer)
            .setFullScreenIntent(answer, true)
            .setTimeoutAfter(45_000)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
            .build()
        n.flags = n.flags or Notification.FLAG_INSISTENT // keep ringing, like a phone call
        nm.notify(ID, n)
    }

    fun stop(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).cancel(ID)
}

/** "Decline" on the ringing screen: stop ringing. (The caller sees no answer.) */
class DeclineCall : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Ringing.stop(context)
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
