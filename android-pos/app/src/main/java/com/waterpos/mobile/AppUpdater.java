package com.waterpos.mobile;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

final class AppUpdater {
    private static final String APK_HOST = "water-pos-apk-builder-production.up.railway.app";
    private static final String POS_HOST = "water-pos-web-production.up.railway.app";
    private static final long MAX_APK_SIZE = 120L * 1024L * 1024L;
    private final Activity activity;
    private final WebView webView;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long downloadId = -1;
    private String expectedSha;
    private int expectedCode;
    private File downloadedFile;
    private boolean waitingForPermission;

    AppUpdater(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    String installedVersion() {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return info.versionName + "|" + info.getLongVersionCode();
        } catch (Exception exception) {
            return "unknown|0";
        }
    }

    void start(String url, String sha256, int versionCode) {
        activity.runOnUiThread(() -> beginDownload(url, sha256, versionCode));
    }

    private void send(String status, int progress, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("status", status);
            payload.put("progress", progress);
            payload.put("message", message);
            if (webView != null) webView.evaluateJavascript(
                "window.WaterPosUpdater&&window.WaterPosUpdater.onNativeProgress(" + payload.toString() + ");", null);
        } catch (Exception ignored) {}
    }

    private void beginDownload(String url, String sha256, int versionCode) {
        if (downloadId != -1) {
            send("error", 0, "An APK download is already running.");
            return;
        }
        try {
            Uri uri = Uri.parse(url);
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) ||
                !(APK_HOST.equalsIgnoreCase(host) || POS_HOST.equalsIgnoreCase(host)) ||
                uri.getPath() == null || !uri.getPath().endsWith(".apk") ||
                !sha256.matches("(?i)^[a-f0-9]{64}$")) {
                send("error", 0, "Invalid or untrusted update package.");
                return;
            }
            long current = activity.getPackageManager()
                .getPackageInfo(activity.getPackageName(), 0).getLongVersionCode();
            if (versionCode <= current) {
                send("error", 0, "This version is already installed or newer.");
                return;
            }
            File folder = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (folder == null) throw new IllegalStateException("Download storage unavailable.");
            downloadedFile = new File(folder, "water-pos-update-" + versionCode + ".apk");
            if (downloadedFile.exists() && !downloadedFile.delete()) {
                throw new IllegalStateException("Could not replace the previous update file.");
            }
            expectedSha = sha256.toLowerCase(Locale.ROOT);
            expectedCode = versionCode;
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setTitle("Water POS update");
            request.setDescription("Downloading a verified app update");
            request.setMimeType("application/vnd.android.package-archive");
            request.setAllowedOverMetered(true);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, downloadedFile.getName());
            DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("Android Download Manager unavailable.");
            downloadId = manager.enqueue(request);
            send("downloading", 0, "Downloading the update…");
            handler.postDelayed(() -> poll(manager), 600);
        } catch (Exception exception) {
            downloadId = -1;
            send("error", 0, "Cannot download update: " + exception.getMessage());
        }
    }

    private void poll(DownloadManager manager) {
        if (downloadId == -1) return;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                downloadId = -1;
                send("error", 0, "Download disappeared. Please retry.");
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_FAILED) {
                downloadId = -1;
                send("error", 0, "Download failed. Check your internet connection.");
                return;
            }
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                downloadId = -1;
                send("verifying", 100, "Verifying update signature and checksum…");
                new Thread(() -> {
                    String error = validateApk();
                    activity.runOnUiThread(() -> {
                        if (error != null) {
                            if (downloadedFile != null) downloadedFile.delete();
                            send("error", 0, error);
                        } else {
                            send("ready", 100, "Update verified. Android installation approval is required.");
                            installVerifiedApk();
                        }
                    });
                }).start();
                return;
            }
            long got = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int pct = total > 0 ? (int) Math.min(99, got * 100 / total) : 0;
            send("downloading", pct, total > 0 ? ("Downloading update · " + pct + "%") : "Downloading update…");
            handler.postDelayed(() -> poll(manager), 950);
        } catch (Exception exception) {
            downloadId = -1;
            send("error", 0, "Download check failed: " + exception.getMessage());
        }
    }

    private String validateApk() {
        try {
            if (downloadedFile == null || !downloadedFile.isFile() ||
                downloadedFile.length() < 1024 || downloadedFile.length() > MAX_APK_SIZE)
                return "The downloaded APK is missing or has an invalid file size.";
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (FileInputStream stream = new FileInputStream(downloadedFile)) {
                byte[] buffer = new byte[65536];
                int n;
                while ((n = stream.read(buffer)) != -1) digest.update(buffer, 0, n);
            }
            StringBuilder checksum = new StringBuilder();
            for (byte b : digest.digest()) checksum.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            if (!expectedSha.equals(checksum.toString()))
                return "Update checksum mismatch. Installation cancelled for safety.";

            PackageManager pm = activity.getPackageManager();
            PackageInfo current = pm.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            PackageInfo candidate = pm.getPackageArchiveInfo(downloadedFile.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (candidate == null || !activity.getPackageName().equals(candidate.packageName))
                return "Update has a different app package or is not a valid APK.";
            if (candidate.getLongVersionCode() != expectedCode ||
                candidate.getLongVersionCode() <= current.getLongVersionCode())
                return "APK version does not match the published update.";
            SigningInfo currentSigner = current.signingInfo;
            SigningInfo candidateSigner = candidate.signingInfo;
            if (currentSigner == null || candidateSigner == null)
                return "Cannot verify APK signing certificate.";
            Signature[] original = currentSigner.getApkContentsSigners();
            Signature[] incoming = candidateSigner.getApkContentsSigners();
            if (original == null || incoming == null || original.length != incoming.length)
                return "APK signing key does not match this installation. Do not uninstall or clear app data.";
            for (Signature incomingSignature : incoming) {
                boolean found = false;
                for (Signature installedSignature : original) {
                    if (Arrays.equals(incomingSignature.toByteArray(), installedSignature.toByteArray())) {
                        found = true;
                        break;
                    }
                }
                if (!found) return "APK signing key changed. Update blocked to protect locally saved sales.";
            }
            return null;
        } catch (Exception exception) {
            return "Update verification failed: " + exception.getMessage();
        }
    }

    private void installVerifiedApk() {
        if (downloadedFile == null || !downloadedFile.exists()) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            waitingForPermission = true;
            send("permission", 100, "Allow Water POS to install app updates in Android settings.");
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            return;
        }
        waitingForPermission = false;
        try {
            Uri contentUri = FileProvider.getUriForFile(activity,
                activity.getPackageName() + ".updateprovider", downloadedFile);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(contentUri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(install);
            send("installing", 100, "Confirm the update in Android's installer.");
        } catch (Exception exception) {
            send("error", 0, "Unable to open Android installer: " + exception.getMessage());
        }
    }

    void onResume() {
        if (waitingForPermission && activity.getPackageManager().canRequestPackageInstalls()) {
            installVerifiedApk();
        }
    }

    void dispose() {
        handler.removeCallbacksAndMessages(null);
    }
}
