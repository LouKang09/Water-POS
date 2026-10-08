package com.waterpos.mobile;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.AlertDialog;
import android.app.admin.DevicePolicyManager;
import android.animation.ValueAnimator;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class MainActivity extends Activity {
    private static final String POS_URL = "https://water-pos-web-production.up.railway.app/";
    private static final String POS_LOGIN_URL = "https://water-pos-web-production.up.railway.app/pos-login.html";
    private static final String POS_HOST = "water-pos-web-production.up.railway.app";
    private static final int FILE_CHOOSER_REQUEST = 9001;
    private static final long STARTUP_SPLASH_MS = 5000L;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private boolean resumeKioskAfterChooser = false;
    private boolean exitRequested = false;
    private DevicePolicyManager devicePolicyManager;
    private ComponentName adminComponent;
    private Handler kioskHandler;
    private boolean lockTaskObserved = false;
    private boolean pinningRequested = false;
    private ValueAnimator splashAnimator;
    private final Runnable kioskRecoveryRunnable = new Runnable() {
        @Override
        public void run() {
            recoverKioskIfNeeded();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        devicePolicyManager = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        adminComponent = new ComponentName(this, KioskDeviceAdminReceiver.class);
        kioskHandler = new Handler(Looper.getMainLooper());
        configureDedicatedKiosk();

        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        window.setStatusBarColor(Color.rgb(13, 107, 105));
        window.setNavigationBarColor(Color.BLACK);

        getWindow().getDecorView().setOnSystemUiVisibilityChangeListener(visibility -> {
            if (!exitRequested && !resumeKioskAfterChooser) {
                scheduleKioskRecovery(80);
            }
        });

        showStartupSplash(savedInstanceState);
        enterKioskMode();
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showStartupSplash(Bundle savedInstanceState) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        content.setPadding(dp(28), dp(32), dp(28), dp(32));

        FrameLayout.LayoutParams contentParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        );

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.inyou_official);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(285), dp(285));
        logoParams.bottomMargin = dp(34);
        content.addView(logo, logoParams);

        WaterLoadingView loader = new WaterLoadingView(this);
        LinearLayout.LayoutParams loaderParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(48)
        );
        loaderParams.setMargins(dp(18), 0, dp(18), dp(12));
        content.addView(loader, loaderParams);

        TextView loadingText = new TextView(this);
        loadingText.setText("Loading 0%");
        loadingText.setTextColor(Color.rgb(20, 88, 142));
        loadingText.setTextSize(14);
        loadingText.setGravity(Gravity.CENTER);
        loadingText.setLetterSpacing(0.12f);
        content.addView(loadingText, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        TextView brandText = new TextView(this);
        brandText.setText("INYOU WATER SUPPLY CO.");
        brandText.setTextColor(Color.rgb(80, 102, 120));
        brandText.setTextSize(11);
        brandText.setGravity(Gravity.CENTER);
        brandText.setLetterSpacing(0.18f);
        LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        brandParams.topMargin = dp(10);
        content.addView(brandText, brandParams);

        root.addView(content, contentParams);
        setContentView(root);

        splashAnimator = ValueAnimator.ofFloat(0f, 1f);
        splashAnimator.setDuration(STARTUP_SPLASH_MS);
        splashAnimator.addUpdateListener(animation -> {
            float progress = (float) animation.getAnimatedValue();
            loader.setProgress(progress);
            loadingText.setText("Loading " + Math.round(progress * 100f) + "%");
        });
        splashAnimator.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(android.animation.Animator animation) {
                splashAnimator = null;
                initializeWebView(savedInstanceState);
            }
        });
        splashAnimator.start();
    }

    private void initializeWebView(Bundle savedInstanceState) {
        if (isFinishing() || isDestroyed()) return;

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
        settings.setUserAgentString(settings.getUserAgentString() + " WaterPOSAndroid/1.2.3");

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
                injectNativeControls();
                enterKioskMode();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> uploadCallback, FileChooserParams fileChooserParams) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = uploadCallback;

                Intent cameraIntent = buildCameraIntent();
                Intent galleryIntent = new Intent(Intent.ACTION_GET_CONTENT);
                galleryIntent.addCategory(Intent.CATEGORY_OPENABLE);
                galleryIntent.setType("image/*");

                resumeKioskAfterChooser = true;

                if (fileChooserParams != null && fileChooserParams.isCaptureEnabled() && cameraIntent != null) {
                    prepareExternalPicker(cameraIntent);
                    try {
                        startActivityForResult(cameraIntent, FILE_CHOOSER_REQUEST);
                        return true;
                    } catch (Exception ignored) {}
                }

                Intent chooser = Intent.createChooser(galleryIntent, "Select receipt image");
                if (cameraIntent != null) {
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
                }

                prepareExternalPicker(galleryIntent, cameraIntent, chooser);
                try {
                    startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    resumeKioskAfterChooser = false;
                    restoreDedicatedKioskPackages();
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

    private static class WaterLoadingView extends View {
        private final Paint trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint waterPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint highlightPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path wavePath = new Path();
        private float progress = 0f;

        WaterLoadingView(Context context) {
            super(context);
            trackPaint.setStyle(Paint.Style.FILL);
            trackPaint.setColor(Color.rgb(232, 245, 252));
            highlightPaint.setStyle(Paint.Style.STROKE);
            highlightPaint.setStrokeWidth(2f);
            highlightPaint.setColor(Color.argb(150, 73, 177, 232));
        }

        void setProgress(float value) {
            progress = Math.max(0f, Math.min(1f, value));
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float w = getWidth();
            float h = getHeight();
            float radius = h / 2f;
            RectF track = new RectF(0, 0, w, h);

            canvas.drawRoundRect(track, radius, radius, trackPaint);

            float fillRight = w * progress;
            if (fillRight > 0f) {
                canvas.save();
                canvas.clipRect(0, 0, Math.min(fillRight, w), h);

            waterPaint.setShader(new LinearGradient(
                0, 0, w, h,
                new int[]{
                    Color.rgb(16, 117, 225),
                    Color.rgb(42, 183, 239),
                    Color.rgb(8, 105, 214)
                },
                null,
                Shader.TileMode.CLAMP
            ));

            float waveBase = h * 0.43f;
            float amplitude = h * 0.12f;
            float phase = progress * (float) Math.PI * 5f;
            wavePath.reset();
            wavePath.moveTo(0, h);
            wavePath.lineTo(0, waveBase);

            int steps = 70;
            for (int i = 0; i <= steps; i++) {
                float x = w * i / steps;
                float y = waveBase + (float) Math.sin((i / 7.0f) + phase) * amplitude;
                wavePath.lineTo(x, y);
            }
            wavePath.lineTo(w, h);
            wavePath.close();
            canvas.drawPath(wavePath, waterPaint);

            Paint bubblePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            bubblePaint.setColor(Color.argb(150, 255, 255, 255));
            for (int i = 0; i < 5; i++) {
                float x = (w * ((i * 0.19f + progress * 0.37f) % 1f));
                float y = h * (0.28f + ((i * 0.17f + progress * 0.8f) % 0.45f));
                float r = h * (0.035f + (i % 3) * 0.012f);
                canvas.drawCircle(x, y, r, bubblePaint);
            }
                canvas.restore();
            }

            canvas.drawRoundRect(track, radius, radius, highlightPaint);
        }
    }

    private boolean isDedicatedKiosk() {
        return devicePolicyManager != null && devicePolicyManager.isDeviceOwnerApp(getPackageName());
    }

    private void configureDedicatedKiosk() {
        if (!isDedicatedKiosk()) return;
        try {
            devicePolicyManager.setLockTaskPackages(adminComponent, new String[]{getPackageName()});
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                devicePolicyManager.setLockTaskFeatures(adminComponent, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
            }
            devicePolicyManager.setStatusBarDisabled(adminComponent, true);
            devicePolicyManager.setKeyguardDisabled(adminComponent, true);
        } catch (Exception ignored) {}
    }

    private void restoreDedicatedKioskPackages() {
        if (!isDedicatedKiosk()) return;
        try {
            devicePolicyManager.setLockTaskPackages(adminComponent, new String[]{getPackageName()});
        } catch (Exception ignored) {}
    }

    private void prepareExternalPicker(Intent... intents) {
        if (!isDedicatedKiosk()) {
            leaveKioskTemporarily();
            return;
        }

        try {
            Set<String> allowed = new HashSet<>();
            allowed.add(getPackageName());
            if (intents != null) {
                for (Intent intent : intents) {
                    if (intent == null) continue;
                    List<ResolveInfo> matches = getPackageManager().queryIntentActivities(intent, 0);
                    for (ResolveInfo match : matches) {
                        if (match.activityInfo != null && match.activityInfo.packageName != null) {
                            allowed.add(match.activityInfo.packageName);
                        }
                    }
                }
            }
            devicePolicyManager.setLockTaskPackages(adminComponent, allowed.toArray(new String[0]));
        } catch (Exception ignored) {}
    }

    private void hideSystemUi() {
        if (exitRequested) return;

        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
        }

        window.getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    private int lockTaskState() {
        ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        return manager == null ? ActivityManager.LOCK_TASK_MODE_NONE : manager.getLockTaskModeState();
    }

    private boolean isLockTaskActive() {
        return lockTaskState() != ActivityManager.LOCK_TASK_MODE_NONE;
    }

    private boolean isFullKioskLocked() {
        return lockTaskState() == ActivityManager.LOCK_TASK_MODE_LOCKED;
    }

    private void requestLockTask() {
        if (exitRequested || resumeKioskAfterChooser) return;

        if (isLockTaskActive()) {
            lockTaskObserved = true;
            return;
        }

        // Device Owner mode enters true LOCKED kiosk without a confirmation prompt.
        // A normal personal device can only enter Android's user-approved screen pinning mode.
        if (isDedicatedKiosk() || !pinningRequested || lockTaskObserved) {
            try {
                pinningRequested = true;
                startLockTask();
            } catch (Exception ignored) {}
        }

        if (isLockTaskActive()) lockTaskObserved = true;
    }

    private void enterKioskMode() {
        if (exitRequested || resumeKioskAfterChooser) return;
        configureDedicatedKiosk();
        hideSystemUi();
        requestLockTask();

        // EMUI can briefly restore navigation gestures after focus/layout changes.
        // Re-assert immersive + LockTask after the transition settles.
        scheduleKioskRecovery(350);
    }

    private void scheduleKioskRecovery(long delayMs) {
        if (kioskHandler == null || exitRequested || resumeKioskAfterChooser) return;
        kioskHandler.removeCallbacks(kioskRecoveryRunnable);
        kioskHandler.postDelayed(kioskRecoveryRunnable, delayMs);
    }

    private void recoverKioskIfNeeded() {
        if (exitRequested || resumeKioskAfterChooser) return;

        hideSystemUi();
        configureDedicatedKiosk();
        requestLockTask();

        if (!isLockTaskActive() && (isDedicatedKiosk() || lockTaskObserved)) {
            bringTaskToFront();
            hideSystemUi();
            requestLockTask();
        }
    }

    private void bringTaskToFront() {
        try {
            ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (manager != null) {
                manager.moveTaskToFront(getTaskId(), ActivityManager.MOVE_TASK_WITH_HOME);
            }
        } catch (Exception ignored) {}

        try {
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(intent);
        } catch (Exception ignored) {}
    }

    private void leaveKioskTemporarily() {
        if (kioskHandler != null) kioskHandler.removeCallbacks(kioskRecoveryRunnable);
        if (isLockTaskActive()) {
            try {
                stopLockTask();
            } catch (Exception ignored) {}
        }
    }

    private void injectNativeControls() {
        if (webView == null) return;
        String script = "(function(){" +
            "var logout=document.getElementById('posLogoutBtn');" +
            "if(logout&&!logout.dataset.nativeLogout){logout.dataset.nativeLogout='1';logout.onclick=function(e){e.preventDefault();e.stopImmediatePropagation();AndroidPos.logoutApp();};}" +
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
        public void logoutApp() {
            runOnUiThread(() -> {
                if (webView == null) return;
                webView.evaluateJavascript(
                    "localStorage.removeItem('water_pos_user_token');sessionStorage.clear();",
                    value -> webView.loadUrl(POS_LOGIN_URL)
                );
            });
        }

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
        if (kioskHandler != null) kioskHandler.removeCallbacks(kioskRecoveryRunnable);
        if (isLockTaskActive()) {
            try {
                stopLockTask();
            } catch (Exception ignored) {}
        }
        if (isDedicatedKiosk()) {
            try {
                devicePolicyManager.setStatusBarDisabled(adminComponent, false);
                devicePolicyManager.setKeyguardDisabled(adminComponent, false);
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
        restoreDedicatedKioskPackages();
        enterKioskMode();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!resumeKioskAfterChooser) {
            restoreDedicatedKioskPackages();
            enterKioskMode();
            scheduleKioskRecovery(700);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!exitRequested && !resumeKioskAfterChooser) {
            scheduleKioskRecovery(180);
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (!exitRequested && !resumeKioskAfterChooser) {
            scheduleKioskRecovery(260);
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (!exitRequested && !resumeKioskAfterChooser) {
            // Huawei/EMUI Home gesture reaches this callback before the task leaves the foreground.
            hideSystemUi();
            requestLockTask();
            scheduleKioskRecovery(60);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!exitRequested && !resumeKioskAfterChooser) {
            if (hasFocus) {
                hideSystemUi();
                requestLockTask();
                scheduleKioskRecovery(220);
            } else if (lockTaskObserved || isDedicatedKiosk()) {
                scheduleKioskRecovery(120);
            }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
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
        if (splashAnimator != null) {
            splashAnimator.cancel();
            splashAnimator = null;
        }
        if (kioskHandler != null) kioskHandler.removeCallbacks(kioskRecoveryRunnable);
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
