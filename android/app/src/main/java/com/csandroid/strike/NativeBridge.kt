package com.csandroid.strike

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface

/**
 * JavaScript bridge exposed to the web app as `window.CSNative`.
 * All methods are safe to call from the WebView's JS thread.
 */
class NativeBridge(private val activity: Activity) {

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    /** Short haptic pulse. amplitude 1..255 (ignored on devices without amplitude control). */
    @JavascriptInterface
    fun vibrate(ms: Int, amplitude: Int) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val dur = ms.coerceIn(1, 1000).toLong()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val amp = if (v.hasAmplitudeControl()) amplitude.coerceIn(1, 255) else VibrationEffect.DEFAULT_AMPLITUDE
            v.vibrate(VibrationEffect.createOneShot(dur, amp))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(dur)
        }
    }

    @JavascriptInterface
    fun cancelVibration() {
        vibrator?.cancel()
    }

    @JavascriptInterface
    fun exit() {
        activity.runOnUiThread { activity.finish() }
    }

    companion object {
        const val JS_NAME = "CSNative"
    }
}
