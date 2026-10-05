package com.waterpos.mobile;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String POS_URL = "https://water-pos-web-production.up.railway.app/";
    private static final String POS_HOST = "water-pos-web-production.up.railway.app";
    private static final int FILE_CHOOSER_REQUEST = 9001;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private boolean resumeKioskAfterChooser = false;
    private boolean exitRequested = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(13, 107, 105));
        window.setNavigationBarColor(Color.BLACK);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " WaterPOSAndroid/1.1");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidPosBridge(), "AndroidPos");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectExitButton();
                hideSystemUi();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> uploadCallback, FileChooserParams fileChooserParams) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = uploadCallback;

                Intent cameraIntent = buildCameraIntent();
                resumeKioskAfterChooser = true;
                leaveKioskTemporarily();

                if (fileChooserParams != null && fileChooserParams.isCaptureEnabled() && cameraIntent != null) {
                    try {
                        startActivityForResult(cameraIntent, FILE_CHOOSER_REQUEST);
                        return true;
                    } catch (Exception ignored) {}
                }

                Intent galleryIntent = new Intent(Intent.ACTION_GET_CONTENT);
                galleryIntent.addCategory(Intent.CATEGORY_OPENABLE);
                galleryIntent.setType("image/*");

                Intent chooser = Intent.createChooser(galleryIntent, "Select receipt image");
                if (cameraIntent != null) {
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
                }

                try {
                    startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    resumeKioskAfterChooser = false;
                    enterKioskMode();
                    return false;
                }
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(POS_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }

        enterKioskMode();
    }

    private void hideSystemUi() {
        if (exitRequested) return;
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    private boolean isLockTaskActive() {
        ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        return manager != null && manager.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
    }

    private void enterKioskMode() {
        if (exitRequested || resumeKioskAfterChooser) return;
        hideSystemUi();
        if (!isLockTaskActive()) {
            try {
                startLockTask();
            } catch (Exception ignored) {}
        }
    }

    private void leaveKioskTemporarily() {
        if (isLockTaskActive()) {
            try {
                stopLockTask();
            } catch (Exception ignored) {}
        }
    }

    private void injectExitButton() {
        if (webView == null) return;
        String script = "(function(){" +
            "if(document.getElementById('waterPosNativeExit'))return;" +
            "var b=document.createElement('button');" +
            "b.id='waterPosNativeExit';b.type='button';b.textContent='Exit App';" +
            "b.style.cssText='border:1px solid rgba(190,55,55,.35);background:#fff4f4;color:#9b2f2f;border-radius:10px;padding:8px 10px;font:800 11px system-ui;cursor:pointer;';" +
            "b.onclick=function(){AndroidPos.exitApp();};" +
            "var h=document.querySelector('.pos-header-actions');" +
            "if(h){h.appendChild(b);return;}" +
            "var card=document.querySelector('.pos-login-card');" +
            "if(card){b.style.marginTop='12px';b.style.width='100%';card.appendChild(b);return;}" +
            "b.style.position='fixed';b.style.right='12px';b.style.top='12px';b.style.zIndex='2147483647';document.body.appendChild(b);" +
            "})();";
        webView.evaluateJavascript(script, null);
    }

    private class AndroidPosBridge {
        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                .setTitle("Exit Water POS?")
                .setMessage("This will close the POS app and release kiosk mode.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Exit", (dialog, which) -> exitWaterPos())
                .show());
        }
    }

    private void exitWaterPos() {
        exitRequested = true;
        resumeKioskAfterChooser = false;
        if (isLockTaskActive()) {
            try {
                stopLockTask();
            } catch (Exception ignored) {}
        }
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        finishAndRemoveTask();
    }

    private Intent buildCameraIntent() {
        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (cameraIntent.resolveActivity(getPackageManager()) == null) return null;

        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "waterpos-receipt-" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/WaterPOS");

        cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (cameraUri == null) return null;

        cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
        cameraIntent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return cameraIntent;
    }

    private boolean handleUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();

        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            String host = uri.getHost();
            if (POS_HOST.equalsIgnoreCase(host)) {
                String path = uri.getPath() == null ? "" : uri.getPath();
                if (path.startsWith("/admin")) {
                    Toast.makeText(this, "Exit Water POS to open Admin in a browser.", Toast.LENGTH_SHORT).show();
                    return true;
                }
                return false;
            }
        }

        Toast.makeText(this, "Exit Water POS before opening another app.", Toast.LENGTH_SHORT).show();
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;

        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data == null || data.getData() == null) {
                if (cameraUri != null) result = new Uri[]{cameraUri};
            } else {
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
        }

        fileCallback.onReceiveValue(result);
        fileCallback = null;
        cameraUri = null;
        resumeKioskAfterChooser = false;
        enterKioskMode();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!resumeKioskAfterChooser) enterKioskMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && !exitRequested && !resumeKioskAfterChooser) hideSystemUi();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            Toast.makeText(this, "Use Exit App to close Water POS.", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidPos");
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }
}
