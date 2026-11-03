export default {
  id: "autoclaw-intl",
  priority: 89,
  display: { name: "AutoClaw International", icon: "smart_toy", color: "#4F46E5", website: "https://autoclaw.autoglm.ai" },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions",
    format: "openai",
    headers: { "X-Version": "1.17.8", "X-Product": "autoclaw", "X-Client-Type": "pc", "X-Tm": "win", "X-Lang": "zh-CN", "X-Channel": "official", x_trace_id: "autoclaw-desktop" },
    auth: { combined: true, header: "X-Authorization", scheme: "bearer", hooks: ["autoclawHeaders"] },
    timeoutMs: 900000,
  },
  models: [
    { id: "glm-5.3", name: "GLM-5.3", contextLength: 1048576, maxOutputTokens: 307200, supportsReasoning: true, supportsToolCall: true },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextLength: 1048576, maxOutputTokens: 131072, supportsImages: true, supportsReasoning: true, supportsToolCall: true },
  ],

};
