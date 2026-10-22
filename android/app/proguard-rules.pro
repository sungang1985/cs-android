# Keep the JavaScript bridge methods callable from the web app.
-keepclassmembers class com.csandroid.strike.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
