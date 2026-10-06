package xyz.bsums.draw

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Updates the app from a GitHub release. The page finds the release (src/client/update.svelte.ts)
 * and calls this as window.DrawAppUpdate. It downloads the release's APK into the app's cache and
 * hands it to Android's installer. Android only installs it over this app when it is signed with
 * the same key, so a wrong or changed file cannot replace the app.
 *
 * Events go back to the page as window.__drawUpdate({ type, ... }):
 * "progress" { fraction }, "downloaded", "error" { message }.
 */
class AppUpdate(private val activity: Activity, private val webView: WebView) {
  private val io = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)

  init {
    // An update downloaded before is installed (or abandoned) by now.
    io.execute { apkFile().delete() }
  }

  private fun apkFile(): File {
    val dir = File(activity.cacheDir, "updates")
    if (!dir.isDirectory && !dir.mkdirs()) Log.w(TAG, "Could not create $dir")
    return File(dir, "update.apk")
  }

  /** Downloads the APK at [url] (a GitHub release file). Answers with events. */
  @JavascriptInterface
  fun download(url: String) {
    if (!isAllowed(url)) return emit("error", "message" to "Not a GitHub release file")
    if (!busy.compareAndSet(false, true)) return
    io.execute {
      val target = apkFile()
      val partial = File(target.path + ".part")
      var connection: HttpURLConnection? = null
      try {
        connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.instanceFollowRedirects = true
        val status = connection.responseCode
        if (!isAllowed(connection.url.toString())) throw IOException("Redirected away from GitHub")
        if (status != HttpURLConnection.HTTP_OK) throw IOException("HTTP $status")
        val total = connection.contentLengthLong
        var received = 0L
        var lastPercent = -1
        connection.inputStream.use { input ->
          partial.outputStream().use { output ->
            val buffer = ByteArray(65536)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              output.write(buffer, 0, read)
              received += read
              if (total > 0) {
                val percent = (received * 100 / total).toInt()
                if (percent != lastPercent) {
                  lastPercent = percent
                  emit("progress", "fraction" to received.toDouble() / total)
                }
              }
            }
          }
        }
        if (total > 0 && received != total) throw IOException("Download incomplete")
        // A quick check before the installer: the file is an APK of this app.
        val info = activity.packageManager.getPackageArchiveInfo(partial.path, 0)
        if (info?.packageName != activity.packageName) throw IOException("Not an update for this app")
        if (target.exists() && !target.delete()) throw IOException("Could not replace the old download")
        if (!partial.renameTo(target)) throw IOException("Could not save the download")
        emit("downloaded")
      } catch (e: IOException) {
        Log.w(TAG, "Download failed", e)
        partial.delete()
        emit("error", "message" to (e.message ?: "Download failed"))
      } finally {
        connection?.disconnect()
        busy.set(false)
      }
    }
  }

  /**
   * Opens Android's installer with the downloaded APK. Returns "started", "needs-permission"
   * (the app may not install apps yet: see openInstallSettings) or "missing".
   */
  @JavascriptInterface
  fun install(): String {
    val apk = apkFile()
    if (!apk.exists()) return "missing"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      return "needs-permission"
    }
    val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.startActivity(intent)
    return "started"
  }

  /** Opens the setting that lets this app install updates. */
  @JavascriptInterface
  fun openInstallSettings() {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
    } else {
      Intent(Settings.ACTION_SECURITY_SETTINGS)
    }
    activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private fun emit(type: String, vararg fields: Pair<String, Any>) {
    val event = JSONObject().put("type", type)
    for ((k, v) in fields) event.put(k, v)
    activity.runOnUiThread {
      webView.evaluateJavascript("window.__drawUpdate && window.__drawUpdate($event)", null)
    }
  }

  companion object {
    private const val TAG = "DrawUpdate"
    private const val TIMEOUT_MS = 20000

    // Release files are served from GitHub (the link redirects to its file host).
    private val HOSTS = setOf("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")

    private fun isAllowed(url: String): Boolean = try {
      val uri = Uri.parse(url)
      uri.scheme == "https" && uri.host in HOSTS
    } catch (e: Exception) {
      false
    }
  }
}
