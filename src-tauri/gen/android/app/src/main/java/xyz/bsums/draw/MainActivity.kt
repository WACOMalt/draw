package xyz.bsums.draw

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Dark bars with light icons, to match the app.
    val bar = Color.rgb(0x26, 0x26, 0x26)
    enableEdgeToEdge(SystemBarStyle.dark(bar), SystemBarStyle.dark(bar))
    super.onCreate(savedInstanceState)
    // Android 15+ draws apps behind the status and navigation bars, and the WebView does not give
    // the page those insets (env(safe-area-inset-*) stays 0). Pad the content instead, so the top
    // bar and the bottom toolbar stay clear of the clock and the gesture handle.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(bar)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
