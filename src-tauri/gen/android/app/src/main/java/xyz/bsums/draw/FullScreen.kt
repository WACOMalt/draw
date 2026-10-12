package xyz.bsums.draw

import android.app.Activity
import android.webkit.JavascriptInterface
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Full screen for the page (src/client/fullscreen.svelte.ts), as window.DrawFullScreen: hides
 * the status and navigation bars. A swipe from the edge shows them for a moment. The WebView has
 * no Fullscreen API for a page, so the page asks the app instead.
 */
class FullScreen(private val activity: Activity) {
  @Volatile private var on = false

  @JavascriptInterface
  fun set(full: Boolean) {
    on = full
    activity.runOnUiThread {
      val c = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      if (full) {
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        c.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        c.show(WindowInsetsCompat.Type.systemBars())
      }
    }
  }

  @JavascriptInterface
  fun get(): Boolean = on
}
