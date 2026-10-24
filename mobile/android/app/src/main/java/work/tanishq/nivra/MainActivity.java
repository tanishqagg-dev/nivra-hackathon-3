package work.tanishq.nivra;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/** A foreground-only client. Camera frames and GPS use the authenticated web app. */
public final class MainActivity extends Activity {
    private static final int CAMERA_PERMISSION = 41;
    private static final int LOCATION_PERMISSION = 42;
    private static final int BACKGROUND = Color.rgb(16, 18, 23);
    private static final int INK = Color.rgb(239, 242, 249);
    private static final int MUTED = Color.rgb(175, 186, 204);
    private LinearLayout root;
    private LinearLayout toolbar;
    private FrameLayout content;
    private WebView web;
    private ProgressBar progress;
    private TextView title;
    private String resumeUrl;
    private boolean stopped = false;
    private boolean foreground = false;
    private boolean clearHistoryAfterLoad = false;
    private PermissionRequest cameraRequest;
    private GeolocationPermissions.Callback locationCallback;
    private String locationOrigin;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BACKGROUND);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);
        showHome();
        if (getIntent().getData() != null) openPairing(getIntent().getData().toString());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getData() != null) openPairing(intent.getData().toString());
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setLineSpacing(dp(3), 1);
        return view;
    }

    private Button button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(INK);
        button.setTextSize(16);
        button.setMinHeight(dp(56));
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private void showHome() {
        destroyWeb();
        root.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        LinearLayout home = new LinearLayout(this);
        home.setOrientation(LinearLayout.VERTICAL);
        home.setPadding(dp(24), dp(32), dp(24), dp(28));
        scroll.addView(home);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        TextView brand = text("NIVRA", 16, Color.rgb(122, 162, 255));
        brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        brand.setLetterSpacing(.18f);
        home.addView(brand);
        TextView heading = text("Choose this phone's role", 30, INK);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.setPadding(0, dp(28), 0, dp(8));
        home.addView(heading);
        home.addView(text("Connect to your safety team at nivra.tanishq.work.", 16, MUTED));
        role(home, "Camera", "Send a live camera feed. Pair this phone with the dashboard first.", "/camera");
        role(home, "Guard", "Share your location, set your floor and respond to incidents.", "/guard");
        role(home, "Camera wall", "Watch connected cameras and review incident alerts. Operator access required.", "/wall");
        TextView pairing = text("Have a pairing code?", 20, INK);
        pairing.setPadding(0, dp(32), 0, dp(8));
        home.addView(pairing);
        home.addView(button("Scan pairing QR", this::scan));
        home.addView(button("Paste pairing link", this::paste));
        TextView note = text("Camera and location sharing work while the app is open. Returning from the background reloads the page; start the camera again when you are ready.", 14, MUTED);
        note.setPadding(0, dp(24), 0, 0);
        home.addView(note);
    }

    private void role(LinearLayout home, String name, String detail, String path) {
        View divider = new View(this);
        divider.setBackgroundColor(Color.rgb(47, 54, 65));
        LinearLayout.LayoutParams dividerLayout = new LinearLayout.LayoutParams(-1, dp(1));
        dividerLayout.topMargin = dp(24);
        home.addView(divider, dividerLayout);
        home.addView(button(name + "  →", () -> open(UrlPolicy.ORIGIN + path)));
        home.addView(text(detail, 14, MUTED));
    }

    private void paste() {
        EditText input = new EditText(this);
        input.setHint("https://nivra.tanishq.work/camera#pair=…");
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(false);
        input.setMaxLines(4);
        input.setPadding(dp(24), dp(16), dp(24), dp(16));
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        new AlertDialog.Builder(this).setTitle("Paste pairing link").setView(input)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Connect", (dialog, which) -> openPairing(input.getText().toString()))
            .show();
    }

    private void scan() {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build();
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener(result -> openPairing(result.getRawValue()))
            .addOnFailureListener(error -> new AlertDialog.Builder(this)
                .setTitle("QR scanner unavailable")
                .setMessage("The scanner needs Google Play services and may download its scanner module on first use. You can paste the pairing link instead.")
                .setPositiveButton("Paste link", (dialog, which) -> paste())
                .setNegativeButton("Close", null).show());
    }

    private void openPairing(String raw) {
        String url = UrlPolicy.pairing(raw);
        if (url == null) {
            Toast.makeText(this, "Use a NIVRA camera, guard or owner invitation link.", Toast.LENGTH_LONG).show();
            return;
        }
        open(url);
        // Do not retain a one-time token in the activity's current Intent.
        getIntent().setData(null);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWeb() {
        root.removeAllViews();
        toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        Button roles = button("‹ Roles", this::showHome);
        roles.setTextSize(14);
        toolbar.addView(roles, new LinearLayout.LayoutParams(dp(92), dp(48)));
        title = text("NIVRA", 14, INK);
        title.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button reload = button("Reload", () -> { if (web != null) web.reload(); });
        reload.setTextSize(14);
        toolbar.addView(reload, new LinearLayout.LayoutParams(dp(88), dp(48)));
        root.addView(toolbar);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new LinearLayout.LayoutParams(-1, dp(2)));
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString() + " NIVRA-Native Android/0.1");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String url = request.getUrl().toString();
                if (UrlPolicy.trusted(url)) return false;
                if ("https".equalsIgnoreCase(request.getUrl().getScheme())) openExternal(request.getUrl());
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (UrlPolicy.trusted(url)) {
                    resumeUrl = UrlPolicy.withoutFragment(url);
                    String path = Uri.parse(url).getPath();
                    title.setText(path != null && path.startsWith("/camera") ? "Camera" : path != null && path.startsWith("/guard") ? "Guard" : "Camera wall");
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (clearHistoryAfterLoad && UrlPolicy.trusted(url)) {
                    view.clearHistory();
                    clearHistoryAfterLoad = false;
                }
                CookieManager.getInstance().flush();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !stopped) {
                    Toast.makeText(MainActivity.this, "NIVRA could not connect. Check your connection, then tap Reload.", Toast.LENGTH_LONG).show();
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value == 100 ? View.GONE : View.VISIBLE);
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> requestCamera(request));
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (cameraRequest == request) cameraRequest = null;
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                requestLocation(origin, callback);
            }
            @Override public void onGeolocationPermissionsHidePrompt() {
                locationCallback = null;
                locationOrigin = null;
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreen != null) { callback.onCustomViewHidden(); return; }
                fullscreen = view;
                fullscreenCallback = callback;
                toolbar.setVisibility(View.GONE);
                content.addView(view, new FrameLayout.LayoutParams(-1, -1));
            }
            @Override public void onHideCustomView() { hideFullscreen(); }
        });
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
    }

    private boolean trustedPage() {
        return foreground && web != null && UrlPolicy.trusted(web.getUrl());
    }

    private void requestCamera(PermissionRequest request) {
        if (!trustedPage() || !UrlPolicy.trusted(request.getOrigin().toString())) { request.deny(); return; }
        boolean video = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) video = true;
        }
        if (!video || cameraRequest != null) { request.deny(); return; }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            cameraRequest = request;
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
        }
    }

    private void requestLocation(String origin, GeolocationPermissions.Callback callback) {
        if (!trustedPage() || !UrlPolicy.trusted(origin) || locationCallback != null) {
            callback.invoke(origin, false, false);
            return;
        }
        if (locationGranted()) { callback.invoke(origin, true, false); return; }
        locationOrigin = origin;
        locationCallback = callback;
        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
    }

    private boolean locationGranted() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == CAMERA_PERMISSION && cameraRequest != null) {
            PermissionRequest pending = cameraRequest;
            cameraRequest = null;
            if (trustedPage() && UrlPolicy.trusted(pending.getOrigin().toString())
                && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                pending.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else pending.deny();
        }
        if (code == LOCATION_PERMISSION && locationCallback != null) {
            locationCallback.invoke(locationOrigin, trustedPage() && UrlPolicy.trusted(locationOrigin) && locationGranted(), false);
            locationCallback = null;
            locationOrigin = null;
        }
    }

    private void open(String url) {
        if (!UrlPolicy.trusted(url)) return;
        if (web == null) createWeb();
        resumeUrl = UrlPolicy.withoutFragment(url);
        stopped = false;
        clearHistoryAfterLoad = true;
        web.loadUrl(url);
        updateScreenWake();
    }

    private void updateScreenWake() {
        if (resumeUrl != null && "/camera".equals(Uri.parse(resumeUrl).getPath())) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void openExternal(Uri uri) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show(); }
    }

    private void hideFullscreen() {
        if (fullscreen == null) return;
        content.removeView(fullscreen);
        fullscreen = null;
        toolbar.setVisibility(View.VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    private void cancelPermissions() {
        if (cameraRequest != null) { cameraRequest.deny(); cameraRequest = null; }
        if (locationCallback != null) {
            locationCallback.invoke(locationOrigin, false, false);
            locationCallback = null;
            locationOrigin = null;
        }
    }

    private void stopCapture() {
        if (web != null) web.evaluateJavascript("document.querySelectorAll('video').forEach(v=>{if(v.srcObject)v.srcObject.getTracks().forEach(t=>t.stop());v.pause()})", null);
    }

    private void destroyWeb() {
        cancelPermissions();
        hideFullscreen();
        if (web != null) {
            stopCapture();
            web.stopLoading();
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        resumeUrl = null;
        stopped = false;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (web != null) {
            web.onResume();
            if (stopped && resumeUrl != null) {
                stopped = false;
                clearHistoryAfterLoad = true;
                web.loadUrl(resumeUrl);
            }
            updateScreenWake();
        }
    }

    @Override protected void onPause() {
        stopCapture();
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onStop() {
        foreground = false;
        cancelPermissions();
        hideFullscreen();
        if (web != null) {
            // Unloading closes streams, GPS watches and sockets, even if WebView's
            // media pause alone would leave a capture track running.
            stopped = true;
            web.stopLoading();
            web.loadUrl("about:blank");
        }
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onStop();
    }

    @Override public void onBackPressed() {
        if (fullscreen != null) { hideFullscreen(); return; }
        if (web != null) {
            if (web.canGoBack()) web.goBack();
            else showHome();
        } else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        destroyWeb();
        super.onDestroy();
    }
}
