package br.ufpr.palotina.fixtec.amebasolgel;

import android.annotation.SuppressLint;
import android.service.dreams.DreamService;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

/**
 * Proteção de tela do Android ("Configurações → Tela → Proteção de tela").
 * Mostra a mesma simulação do app, em modo proteção: sem botão, sem avisos, sem menu.
 * A página é servida em https://localhost — a mesma origem do app (Capacitor) —, então
 * a proteção de tela usa a iluminação e os parâmetros escolhidos no menu do app.
 * Qualquer toque encerra a proteção de tela, como de costume.
 */
public class AmebaDream extends DreamService {
    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        setInteractive(false);
        setFullscreen(true);
        setScreenBright(true);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain("localhost")
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setBackgroundColor(0xFF0B1016);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });
        setContentView(web);
        web.loadUrl("https://localhost/public/index.html?modo=protecao");
    }

    @Override
    public void onDreamingStarted() {
        super.onDreamingStarted();
        if (web != null) web.onResume();
    }

    @Override
    public void onDreamingStopped() {
        if (web != null) web.onPause();
        super.onDreamingStopped();
    }

    @Override
    public void onDetachedFromWindow() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDetachedFromWindow();
    }
}
