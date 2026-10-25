package com.csandroid.strike

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.app.Activity
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.io.ByteArrayInputStream
import java.io.IOException
import java.util.Locale

/**
 * Thin fullscreen WebView host for the CS Strike web game (built from the repository root with
 * `npm run build:android`, which copies dist/ into src/main/assets/www).
 *
 * Responsibilities:
 *  - immersive sticky fullscreen, landscape, keep-screen-on
 *  - serve the bundled web app from assets over a private https origin (secure context, proper MIME types)
 *  - expose a small JS bridge (vibration, platform info, exit)
 *  - forward lifecycle (pause/resume) and the hardware back button to the web app
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    /** Uptime of the last back press the page answered 'none' to (§14.4 double-press exit). */
    private var lastNoneBackAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        applyImmersive()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#151A22"))
            overScrollMode = View.OVER_SCROLL_NEVER
            isHorizontalScrollBarEnabled = false
            isVerticalScrollBarEnabled = false
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            textZoom = 100
            userAgentString = "$userAgentString CSStrikeApp/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.addJavascriptInterface(NativeBridge(this), NativeBridge.JS_NAME)
        webView.webViewClient = AssetWebViewClient(this)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d(TAG, "[js] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                return true
            }
        }

        setContentView(webView)
        webView.loadUrl("$ORIGIN/index.html?platform=android")
    }

    private fun applyImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()
        dispatchJsEvent("cs-resume")
    }

    override fun onPause() {
        dispatchJsEvent("cs-pause")
        webView.onPause()
        webView.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    /**
     * Hardware back: let the web app decide. It may define `window.__csBack()` returning
     * "handled" (consumed, e.g. closed a menu) or "exit" (finish the activity). Anything else ("none",
     * or no handler, e.g. on the WebGL2-unsupported page) dispatches cs-back and shows 「再按一次退出」;
     * a second such press within 2 s finishes the activity (§14.4).
     */
    @Deprecated("Legacy back handling is intentional (no AndroidX); predictive back is disabled in the manifest.")
    override fun onBackPressed() {
        webView.evaluateJavascript("(function(){try{return window.__csBack?String(window.__csBack()):'none'}catch(e){return 'none'}})()") { result ->
            when (result?.trim('"')) {
                "exit" -> finish()
                "handled" -> Unit
                else -> {
                    dispatchJsEvent("cs-back")
                    val now = android.os.SystemClock.uptimeMillis()
                    if (lastNoneBackAt != 0L && now - lastNoneBackAt <= 2000L) finish()
                    else {
                        lastNoneBackAt = now
                        val zh = Locale.getDefault().language == "zh"
                        Toast.makeText(this, if (zh) "再按一次退出" else "Press back again to exit", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    fun dispatchJsEvent(name: String) {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript("window.dispatchEvent(new Event('$name'))", null)
    }

    /** Serves files from assets/www under a private https origin so the page is a secure context. */
    private class AssetWebViewClient(private val activity: Activity) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.scheme != "https" || url.host != HOST) return null
            var path = url.path?.trimStart('/') ?: ""
            if (path.isEmpty() || path.endsWith("/")) path += "index.html"
            return try {
                val stream = activity.assets.open("www/$path")
                WebResourceResponse(mimeFor(path), if (isText(path)) "utf-8" else null, stream).apply {
                    responseHeaders = mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*")
                }
            } catch (e: IOException) {
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Keep navigation inside the app; external links are not part of the game.
            return request.url.host != HOST
        }

        private fun isText(path: String) = path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".css") ||
                path.endsWith(".json") || path.endsWith(".webmanifest") || path.endsWith(".svg") || path.endsWith(".txt")

        private fun mimeFor(path: String): String = when (path.substringAfterLast('.', "")) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "webmanifest" -> "application/manifest+json"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "svg" -> "image/svg+xml"
            "ico" -> "image/x-icon"
            "woff2" -> "font/woff2"
            "wasm" -> "application/wasm"
            else -> "application/octet-stream"
        }
    }

    companion object {
        private const val TAG = "CSStrike"
        const val HOST = "app.csstrike.local"
        const val ORIGIN = "https://$HOST"
    }
}
