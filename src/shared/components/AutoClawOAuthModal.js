"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

const SCRIPT_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

function loadCaptcha(config) {
  window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
  if (typeof window.initAliyunCaptcha === "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let script = document.getElementById("autoclaw-aliyun-captcha");
    if (!script) {
      script = document.createElement("script");
      script.id = "autoclaw-aliyun-captcha";
      script.src = SCRIPT_URL;
      script.async = true;
    }
    const timer = window.setTimeout(() => reject(new Error("Captcha SDK load timed out")), 40000);
    script.addEventListener("load", () => {
      window.clearTimeout(timer);
      typeof window.initAliyunCaptcha === "function" ? resolve() : reject(new Error("Captcha SDK did not initialize"));
    }, { once: true });
    script.addEventListener("error", () => {
      window.clearTimeout(timer);
      reject(new Error("Failed to load captcha SDK"));
    }, { once: true });
    if (!script.isConnected) document.head.appendChild(script);
  });
}

export default function AutoClawOAuthModal({ isOpen, onSuccess, onClose }) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [remoteCallback, setRemoteCallback] = useState(false);
  const popupRef = useRef(null);
  const busyRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);

  useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);

  const complete = useCallback(async (code, state) => {
    if (!session?.sessionId) return;
    setStatus("exchanging");
    try {
      const response = await fetch("/api/autoclaw-intl/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId, code, state }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "AutoClaw login failed");
      setStatus("success");
      popupRef.current?.close?.();
      onSuccessRef.current?.();
    } catch (e) { setError(e.message); setStatus("error"); }
  }, [session]);

  useEffect(() => {
    if (!isOpen || !session) return;
    const onMessage = async event => {
      if (event.origin !== window.location.origin || event.data?.type !== "oauth_callback") return;
      const data = event.data.data || {};
      if (data.error) {
        setError(data.errorDescription || data.error);
        setStatus("error");
        return;
      }
      if (!data.code) return;
      complete(data.code, data.state);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isOpen, session, complete]);

  useEffect(() => {
    if (isOpen) return;
    busyRef.current = false;
    setStatus("idle");
    setError("");
    setSession(null);
    setCallbackUrl("");
    setRemoteCallback(false);
    popupRef.current?.close?.();
    popupRef.current = null;
  }, [isOpen]);

  const submitCallback = () => {
    try {
      const parsed = new URL(callbackUrl.trim());
      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state") || "";
      if (!code) throw new Error("Callback URL does not contain an authorization code");
      complete(code, state);
    } catch (e) { setError(e.message); setStatus("error"); }
  };

  const start = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError("");
    setStatus("captcha");
    const popup = window.open("about:blank", "autoclaw_oauth", "width=600,height=700");
    popupRef.current = popup;
    try {
      const localHost = window.location.protocol === "http:" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
      const redirectUri = localHost
        ? `${window.location.origin}/auth/callback-google`
        : "http://localhost:53699/auth/callback-google";
      setRemoteCallback(!localHost);
      setCallbackUrl("");
      const configResponse = await fetch("/api/autoclaw-intl/oauth/captcha-config");
      const config = await configResponse.json();
      if (!configResponse.ok) throw new Error(config.error || "Unable to load AutoClaw captcha configuration");
      await loadCaptcha(config);
      const elementId = `autoclaw-captcha-element-${Date.now()}`;
      const buttonId = `autoclaw-captcha-trigger-${Date.now()}`;
      let element = document.getElementById(elementId);
      if (!element) {
        element = document.createElement("div");
        element.id = elementId;
        element.style.position = "relative";
        element.style.zIndex = "2147483000";
        document.body.appendChild(element);
      }
      let button = document.getElementById(buttonId);
      if (!button) {
        button = document.createElement("button");
        button.id = buttonId;
        button.type = "button";
        button.style.position = "fixed";
        button.style.width = "1px";
        button.style.height = "1px";
        button.style.opacity = "0";
        button.style.pointerEvents = "none";
        document.body.appendChild(button);
      }
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (!settled) { settled = true; reject(new Error("Captcha verification timed out")); }
        }, 120000);
        window.initAliyunCaptcha({
          SceneId: config.sceneId,
          mode: "popup",
          element: `#${elementId}`,
          button: `#${buttonId}`,
          slideStyle: { width: 360, height: 40 },
          language: (document.documentElement.lang || "en").startsWith("zh") ? "cn" : "en",
          getInstance: () => window.setTimeout(() => button.click(), 2200),
          onBizResultCallback: () => {},
          captchaVerifyCallback: async captchaVerifyParam => {
            try {
              const response = await fetch("/api/autoclaw-intl/oauth/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ captchaVerifyParam, redirectUri }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to start AutoClaw OAuth");
              if (!settled) {
                settled = true;
                window.clearTimeout(timeout);
                resolve(data);
              }
              return { captchaResult: true, bizResult: true };
            } catch (e) {
              if (!settled) {
                settled = true;
                window.clearTimeout(timeout);
                reject(e);
              }
              return { captchaResult: false, bizResult: false };
            }
          },
          onError: e => {
            if (!settled) {
              settled = true;
              window.clearTimeout(timeout);
              reject(new Error(e?.message || "Captcha verification failed"));
            }
          },
        });
      });
      setSession(result);
      setStatus("waiting");
      busyRef.current = false;
      if (popup && !popup.closed) popup.location.href = result.authUrl;
      else window.open(result.authUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      popup?.close?.();
      setError(e.message);
      setStatus("error");
      busyRef.current = false;
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="AutoClaw International sign-in">
      <div className="space-y-4">
        <p className="text-sm text-text-muted">Complete the security check, then sign in with Google in the browser window.</p>
        {status === "idle" && <Button onClick={start} fullWidth>Continue with Google</Button>}
        {status === "captcha" && <p className="text-sm">Complete the Aliyun security verification to continue.</p>}
        {status === "waiting" && remoteCallback && <div className="space-y-2"><p className="text-sm">After Google sign-in, the browser will redirect to a localhost callback. Copy the full URL from the address bar and paste it here to finish connecting.</p><input value={callbackUrl} onChange={e => setCallbackUrl(e.target.value)} placeholder="http://localhost:53699/auth/callback-google?code=...&state=..." className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs font-mono" /><Button onClick={submitCallback} fullWidth disabled={!callbackUrl.trim()}>Complete sign-in</Button></div>}
        {(status === "waiting" || status === "exchanging") && <p className="text-sm">{status === "exchanging" ? "Finishing sign-in…" : "Waiting for Google authorization…"}</p>}
        {status === "success" && <p className="text-sm text-green-600">AutoClaw account connected.</p>}
        {status === "error" && <div className="space-y-3"><p className="text-sm text-red-500">{error}</p><Button onClick={start} fullWidth>Try again</Button></div>}
        <p className="text-xs text-text-muted">Google sign-in is supported. Zai uses a separate fixed-port loopback callback and is not supported in this integration yet.</p>
        <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>Close</Button></div>
      </div>
    </Modal>
  );
}

AutoClawOAuthModal.propTypes = { isOpen: PropTypes.bool, onSuccess: PropTypes.func, onClose: PropTypes.func };
