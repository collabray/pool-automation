package com.pooltable.owner

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * Thin, hardened shell around the owner web app (/owner.html on YOUR server).
 *  - Requires the phone's fingerprint/face/PIN before showing anything (if the phone has a screen lock).
 *  - Only ever navigates inside your server's host; every other link opens in the normal browser.
 *  - No file access, no cleartext traffic, no screenshots (FLAG_SECURE), no backups.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var refresh: SwipeRefreshLayout
    private lateinit var retry: Button
    private var unlocked = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web); refresh = findViewById(R.id.refresh); retry = findViewById(R.id.unlock)
        web.visibility = View.INVISIBLE

        with(web.settings) {
            javaScriptEnabled = true            // the owner app is JavaScript
            domStorageEnabled = true            // keeps you signed in
            allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false); javaScriptCanOpenWindowsAutomatically = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "https" && u.host == BuildConfig.SERVER_HOST) return false
                startActivity(Intent(Intent.ACTION_VIEW, u)); return true   // anything else leaves the app
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { refresh.isRefreshing = true }
            override fun onPageFinished(view: WebView, url: String) { refresh.isRefreshing = false }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) view.loadUrl("file:///android_asset/offline.html")
            }
        }
        refresh.setOnRefreshListener { if (online()) web.loadUrl(START_URL) else web.reload() }
        retry.setOnClickListener { authenticate() }
        authenticate()
    }

    @Suppress("DEPRECATION")
    private fun online(): Boolean { val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager; return cm.activeNetworkInfo?.isConnected == true }

    private fun authenticate() {
        val allowed = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        if (BiometricManager.from(this).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) { show(); return }  // no screen lock set: nothing to ask
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { show() }
            override fun onAuthenticationError(code: Int, msg: CharSequence) { retry.visibility = View.VISIBLE }
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(getString(R.string.unlock_title)).setSubtitle(getString(R.string.unlock_subtitle)).setAllowedAuthenticators(allowed).build())
    }

    private fun show() { unlocked = true; retry.visibility = View.GONE; web.visibility = View.VISIBLE; if (web.url == null) web.loadUrl(START_URL) }
    override fun onStop() { super.onStop(); if (unlocked) { unlocked = false; web.visibility = View.INVISIBLE } }    // re-lock whenever the app leaves the screen
    override fun onStart() { super.onStart(); if (!unlocked) authenticate() }
    @Deprecated("Deprecated in Java") override fun onBackPressed() { if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed() }

    companion object { val START_URL: String get() = BuildConfig.SERVER_URL + "/owner.html" }
}
