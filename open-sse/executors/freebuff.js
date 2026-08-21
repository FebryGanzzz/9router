import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const BASE_URL = "https://www.codebuff.com";
const CLI_UA = "Freebuff-CLI/0.0.150";
const CHAT_URL = `${BASE_URL}/api/v1/chat/completions`;

export const BUFFY_SYSTEM_MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";

const DEFAULT_MODEL = "mimo/mimo-v2.5";

const MODEL_AGENT = {
  "mimo/mimo-v2.5": "base2-free",
  "minimax/minimax-m2.7": "base2-free",
  "z-ai/glm-5.1": "base2-free",
  "google/gemini-3.1-pro-preview": "base2-free",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "moonshotai/kimi-k2.6": "base2-free-kimi",
};

// In-memory cache for free sessions: `${token}:${model}` -> { instanceId, expiresAt, model }
const sessions = new Map();

function generateClientId() {
  return Math.random().toString(36).slice(2, 15).padEnd(13, "0").slice(0, 13);
}

function clearSessionCache(token = null, model = null) {
  if (token && model) {
    sessions.delete(`${token}:${model}`);
  } else if (token) {
    for (const k of sessions.keys()) {
      if (k.startsWith(`${token}:`)) sessions.delete(k);
    }
  } else {
    sessions.clear();
  }
}

async function getFreebuffSession(token, model = DEFAULT_MODEL, proxyOptions = null) {
  const cacheKey = `${token}:${model}`;
  const cached = sessions.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { instanceId: cached.instanceId, resolvedModel: cached.model };
  }

  const sessionId = "ad-" + Math.random().toString(36).slice(2, 12);
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": CLI_UA,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (model && model !== DEFAULT_MODEL) {
    headers["x-freebuff-model"] = model;
  }

  const resp = await proxyAwareFetch(`${BASE_URL}/api/v1/freebuff/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "gravity",
      messages: [],
      sessionId,
      device: { os: "linux", timezone: "UTC", locale: "en-US" },
      surface: "cli",
    }),
  }, proxyOptions);

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 409) {
      try {
        const errJson = JSON.parse(text);
        if (errJson.status === "model_locked" && errJson.currentModel) {
          if (errJson.currentModel !== model) {
            return await getFreebuffSession(token, errJson.currentModel, proxyOptions);
          }
        }
      } catch {}
    }
    throw new Error(`Freebuff session failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const resolved = data.model || model;
  const remainingMs = typeof data.remainingMs === "number" ? data.remainingMs : 3600000;
  const expiresAt = Date.now() + Math.max(1000, remainingMs - 60000);
  sessions.set(cacheKey, { instanceId: data.instanceId, expiresAt, model: resolved });
  return { instanceId: data.instanceId, resolvedModel: resolved };
}

async function startAgentRun(token, agentId, proxyOptions = null) {
  const resp = await proxyAwareFetch(`${BASE_URL}/api/v1/agent-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": CLI_UA,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      action: "START",
      agentId,
      ancestorRunIds: [],
    }),
  }, proxyOptions);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Freebuff agent run START failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.runId;
}

async function finishAgentRun(token, runId, proxyOptions = null) {
  if (!runId) return;
  try {
    await proxyAwareFetch(`${BASE_URL}/api/v1/agent-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": CLI_UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "FINISH",
        runId,
        status: "completed",
        totalSteps: 1,
        directCredits: 0,
        totalCredits: 0,
      }),
    }, proxyOptions);
  } catch {
    // Best-effort cleanup
  }
}

function injectBuffyMarker(messages) {
  const msgs = Array.isArray(messages) ? [...messages] : [];
  const first = msgs[0] || {};
  const hasMarker =
    first.role === "system" &&
    typeof first.content === "string" &&
    first.content.includes(BUFFY_SYSTEM_MARKER);
  if (!hasMarker) {
    msgs.unshift({ role: "system", content: BUFFY_SYSTEM_MARKER });
  }
  return msgs;
}

function wrapStreamWithCleanup(response, cleanupFn) {
  if (!response.body) {
    cleanupFn();
    return response;
  }

  let cleaned = false;
  const safeCleanup = () => {
    if (!cleaned) {
      cleaned = true;
      cleanupFn();
    }
  };

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          safeCleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        safeCleanup();
        controller.error(err);
      }
    },
    async cancel(reason) {
      safeCleanup();
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff || { baseUrl: CHAT_URL });
  }

  buildUrl() {
    return CHAT_URL;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials?.accessToken || credentials?.apiKey;
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": CLI_UA,
      Accept: stream ? "text/event-stream, application/json" : "application/json",
    };
  }

  transformRequest(model, body) {
    return {
      ...body,
      messages: injectBuffyMarker(body?.messages),
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = credentials?.accessToken || credentials?.apiKey;
    if (!token) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "Freebuff requires an auth token", code: "unauthorized" } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
      return { response: fakeResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    let targetModel = String(model || DEFAULT_MODEL).replace(/^(freebuff|cb)\//, "");
    if (!MODEL_AGENT[targetModel]) {
      targetModel = DEFAULT_MODEL;
    }

    let attempts = 0;
    let lastError = null;

    while (attempts < 2) {
      attempts++;
      let instanceId;
      let resolvedModel;
      let runId = null;

      try {
        const sess = await getFreebuffSession(token, targetModel, proxyOptions);
        instanceId = sess.instanceId;
        resolvedModel = sess.resolvedModel;
        const agentId = MODEL_AGENT[resolvedModel] || "base2-free";
        runId = await startAgentRun(token, agentId, proxyOptions);
      } catch (err) {
        log?.error?.("FREEBUFF", `Session/run initialization failed: ${err.message}`);
        lastError = err;
        clearSessionCache(token, targetModel);
        if (attempts < 2) continue;
        throw err;
      }

      let messages = injectBuffyMarker(body?.messages);

      // If client sent tools, append their definitions to the system prompt so the model is aware of them
      // without passing raw `tools` array which causes Codebuff router 404 ("No endpoints found for mimo/mimo-v2.5").
      if (Array.isArray(body?.tools) && body.tools.length > 0) {
        const toolDefs = body.tools
          .map((t) => {
            const f = t.function || t;
            if (!f?.name) return null;
            return `- ${f.name}: ${f.description || ""}\n  Parameters: ${JSON.stringify(f.parameters || {})}`;
          })
          .filter(Boolean)
          .join("\n");
        if (toolDefs) {
          const toolNotice = `\n\n[Available Tools]\nYou have access to the following tools if needed:\n${toolDefs}`;
          if (messages[0]?.role === "system") {
            messages[0] = { ...messages[0], content: messages[0].content + toolNotice };
          } else {
            messages.unshift({ role: "system", content: BUFFY_SYSTEM_MARKER + toolNotice });
          }
        }
      }

      const transformedBody = {
        model: resolvedModel,
        messages,
        max_tokens: body?.max_tokens || body?.max_completion_tokens || 4096,
        stream: stream !== false,
        codebuff_metadata: {
          run_id: runId,
          client_id: generateClientId(),
          cost_mode: "free",
          freebuff_instance_id: instanceId,
        },
        provider: { data_collection: "deny" },
        stop: ["cb_easp"],
      };

      if (body?.temperature !== undefined) {
        transformedBody.temperature = body.temperature;
      }
      if (body?.top_p !== undefined) {
        transformedBody.top_p = body.top_p;
      }

      const headers = this.buildHeaders(credentials, stream);
      const url = this.buildUrl();
      const bodyStr = JSON.stringify(transformedBody);
      log?.debug?.("FETCH", `FREEBUFF → ${url} | model=${resolvedModel} runId=${runId}`);

      let response;
      try {
        response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal,
        }, proxyOptions);
      } catch (fetchErr) {
        await finishAgentRun(token, runId, proxyOptions);
        throw fetchErr;
      }

      if (!response.ok) {
        let errText = "";
        try {
          const clone = response.clone();
          errText = await clone.text();
        } catch {}

        const retryable =
          response.status === 428 ||
          (response.status === 404 && errText.includes("No endpoints found")) ||
          (response.status === 409 && (errText.includes("superseded") || errText.includes("model_locked"))) ||
          (response.status === 429 && errText.includes("capacity"));

        await finishAgentRun(token, runId, proxyOptions);

        if (retryable && attempts < 2) {
          log?.debug?.("FREEBUFF", `Retryable upstream response (${response.status}), refreshing session...`);
          clearSessionCache(token, targetModel);
          if (response.status === 429) {
            await new Promise((r) => setTimeout(r, 2000));
          }
          continue;
        }

        if (response.status === 428) {
          clearSessionCache(token, targetModel);
        }

        return { response, url, headers, transformedBody };
      }

      const wrappedResponse = wrapStreamWithCleanup(response, () => {
        finishAgentRun(token, runId, proxyOptions);
      });

      return { response: wrappedResponse, url, headers, transformedBody };
    }

    throw lastError || new Error("Freebuff execution failed");
  }
}

export const __test__ = {
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
};

export default FreebuffExecutor;
