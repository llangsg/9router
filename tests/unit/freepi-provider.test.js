import { afterEach, describe, expect, it, vi } from "vitest";
import freepi from "../../src/lib/oauth/providers/freepi.js";
import registry from "../../open-sse/providers/registry/freepi.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

afterEach(() => vi.unstubAllGlobals());

describe("FreePi provider", () => {
  it("starts GitHub device login and records the required consent", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session_id: "session-1", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 5 })))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const result = await freepi.requestDeviceCode();
    expect(result.device_code).toBe("session-1");
    expect(result.user_code).toBe("ABCD-EFGH");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ session_id: "session-1", consent_version: "0.4.10" });
  });

  it("normalizes pending and issued JWT responses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-token" })));
    vi.stubGlobal("fetch", fetch);
    expect((await freepi.pollToken({}, "session-1")).data.error).toBe("authorization_pending");
    expect((await freepi.pollToken({}, "session-1")).data.access_token).toBe("jwt-token");
  });

  it("sends the required FreePi transport headers", () => {
    const executor = new DefaultExecutor("freepi");
    const headers = executor.buildHeaders({ accessToken: "jwt-token" }, true);
    expect(executor.buildUrl("deepseek-v4-flash", true)).toBe("https://api.freepi.ai/v1/chat/completions");
    expect(headers.Authorization).toBe("Bearer jwt-token");
    expect(headers["x-session-id"]).toBe("freepi2api");
    expect(headers["x-client-version"]).toBe("0.4.10");
  });

  it("registers an OAuth chat-completions transport and seeded models", () => {
    expect(registry.category).toBe("oauth");
    expect(registry.transport.baseUrl).toBe("https://api.freepi.ai/v1/chat/completions");
    expect(registry.models.length).toBeGreaterThan(0);
    expect(registry.passthroughModels).toBe(true);
  });
});
