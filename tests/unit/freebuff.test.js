import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock proxyAwareFetch so FreebuffExecutor never hits the live network in tests.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { FreebuffExecutor, __test__ } from "../../open-sse/executors/freebuff.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "../../open-sse/config/providerModels.js";
import { FREE_PROVIDERS } from "../../src/shared/constants/providers.js";
import freebuffOAuth from "../../src/lib/oauth/providers/freebuff.js";

const {
  getFreebuffSession,
  startAgentRun,
  finishAgentRun,
  injectBuffyMarker,
  generateClientId,
  clearSessionCache,
  BUFFY_SYSTEM_MARKER,
  DEFAULT_MODEL,
  MODEL_AGENT,
  CLI_UA,
  BASE_URL,
  CHAT_URL,
} = __test__;

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    clone() {
      return this;
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  clearSessionCache();
});

describe("generateClientId", () => {
  it("generates a 13-character string", () => {
    const id = generateClientId();
    expect(id.length).toBe(13);
  });

  it("produces fresh strings on each call", () => {
    expect(generateClientId()).not.toBe(generateClientId());
  });
});

describe("injectBuffyMarker", () => {
  it("prepends the Buffy marker when no system prompt is present", () => {
    const out = injectBuffyMarker([{ role: "user", content: "hello" }]);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain(BUFFY_SYSTEM_MARKER);
    expect(out[1].content).toBe("hello");
  });

  it("does not duplicate marker if already in first system message", () => {
    const out = injectBuffyMarker([
      { role: "system", content: `${BUFFY_SYSTEM_MARKER} custom instructions` },
      { role: "user", content: "hello" },
    ]);
    expect(out.length).toBe(2);
    expect(out[0].content).toContain(BUFFY_SYSTEM_MARKER);
  });
});

describe("FreebuffExecutor", () => {
  const exec = new FreebuffExecutor();

  it("buildUrl returns the codebuff completions endpoint", () => {
    expect(exec.buildUrl()).toBe(CHAT_URL);
  });

  it("buildHeaders includes Bearer token and Freebuff CLI User-Agent", () => {
    const headers = exec.buildHeaders({ accessToken: "test-tok-123" }, true);
    expect(headers["Authorization"]).toBe("Bearer test-tok-123");
    expect(headers["User-Agent"]).toBe(CLI_UA);
    expect(headers["Accept"]).toContain("text/event-stream");
  });

  it("returns 401 response if no auth token is provided", async () => {
    const res = await exec.execute({
      model: "mimo/mimo-v2.5",
      body: { messages: [{ role: "user", content: "test" }] },
      credentials: {},
    });
    expect(res.response.status).toBe(401);
  });

  it("executes the full session -> START -> chat -> FINISH flow", async () => {
    // 1. Session endpoint
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        instanceId: "inst-123",
        model: "mimo/mimo-v2.5",
        remainingMs: 3600000,
      })
    );
    // 2. Agent run START
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        runId: "run-456",
      })
    );
    // 3. Chat completion POST
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: {
        getReader() {
          let readCount = 0;
          return {
            async read() {
              if (readCount++ === 0) {
                return { done: false, value: new TextEncoder().encode("data: hi\n\n") };
              }
              return { done: true };
            },
            async cancel() {},
          };
        },
      },
    });
    // 4. Agent run FINISH (called when stream finishes)
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "completed" }));

    const res = await exec.execute({
      model: "mimo/mimo-v2.5",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: true,
      credentials: { accessToken: "tok-abc" },
    });

    expect(res.url).toBe(CHAT_URL);
    expect(res.transformedBody.codebuff_metadata.run_id).toBe("run-456");
    expect(res.transformedBody.codebuff_metadata.freebuff_instance_id).toBe("inst-123");
    expect(res.transformedBody.codebuff_metadata.cost_mode).toBe("free");
    expect(res.transformedBody.messages[0].content).toContain(BUFFY_SYSTEM_MARKER);

    // Consume the stream to trigger stream cleanup
    const reader = res.response.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Verify calls: session, agent-runs START, chat, agent-runs FINISH
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/freebuff/session`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/api/v1/agent-runs`);
    expect(fetchMock.mock.calls[2][0]).toBe(CHAT_URL);
    expect(fetchMock.mock.calls[3][0]).toBe(`${BASE_URL}/api/v1/agent-runs`);
  });
});

describe("Freebuff provider registration", () => {
  it("registers specialized executor for freebuff and cb alias", () => {
    expect(getExecutor("freebuff")).toBeInstanceOf(FreebuffExecutor);
    expect(getExecutor("cb")).toBeInstanceOf(FreebuffExecutor);
  });

  it("maps freebuff alias to cb", () => {
    expect(PROVIDER_ID_TO_ALIAS["freebuff"]).toBe("cb");
  });

  it("registers freebuff models in PROVIDER_MODELS", () => {
    const models = PROVIDER_MODELS.cb.map((m) => m.id);
    expect(models).toContain("mimo/mimo-v2.5");
    expect(models).toContain("minimax/minimax-m2.7");
    expect(models).toContain("google/gemini-3.1-pro-preview");
  });

  it("lists freebuff in FREE_PROVIDERS catalog", () => {
    expect(FREE_PROVIDERS["freebuff"]?.alias).toBe("cb");
    expect(FREE_PROVIDERS["freebuff"]?.hasOAuth).toBe(true);
  });
});

describe("Freebuff OAuth Provider", () => {
  it("implements flowType device_code", () => {
    expect(freebuffOAuth.flowType).toBe("device_code");
  });

  it("maps tokens correctly", () => {
    const mapped = freebuffOAuth.mapTokens({
      access_token: "fb-tok-xyz",
      _userId: "user-1",
      _email: "test@example.com",
      _name: "Test User",
      _fingerprintId: "fp-123",
      _fingerprintHash: "fph-456",
    });

    expect(mapped.accessToken).toBe("fb-tok-xyz");
    expect(mapped.email).toBe("test@example.com");
    expect(mapped.displayName).toBe("Test User");
    expect(mapped.providerSpecificData.fingerprintId).toBe("fp-123");
  });
});
