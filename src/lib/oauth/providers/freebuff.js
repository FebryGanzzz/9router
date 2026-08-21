import { FREEBUFF_CONFIG } from "../constants/oauth.js";
import { randomUUID } from "node:crypto";

const FREEBUFF_API = "https://www.codebuff.com";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const fingerprintId = randomUUID();
    const response = await fetch(`${FREEBUFF_API}/api/auth/cli/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": BROWSER_UA,
      },
      body: JSON.stringify({ fingerprintId }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Freebuff device code request failed (${response.status}): ${error}`);
    }

    const data = await response.json();
    const devicePayload = JSON.stringify({
      fingerprintId,
      fingerprintHash: data.fingerprintHash,
      expiresAt: data.expiresAt,
    });

    return {
      device_code: devicePayload,
      user_code: fingerprintId.slice(0, 8),
      verification_uri: data.loginUrl,
      verification_uri_complete: data.loginUrl,
      expires_in: Math.floor((data.expiresInMs || 3600000) / 1000),
      interval: 5,
    };
  },
  pollToken: async (config, deviceCode) => {
    let payload;
    try {
      payload =
        typeof deviceCode === "string" && deviceCode.startsWith("{")
          ? JSON.parse(deviceCode)
          : { fingerprintId: deviceCode };
    } catch {
      payload = { fingerprintId: deviceCode };
    }

    const { fingerprintId, fingerprintHash, expiresAt } = payload;
    const url = new URL(`${FREEBUFF_API}/api/auth/cli/status`);
    if (fingerprintId) url.searchParams.set("fingerprintId", fingerprintId);
    if (fingerprintHash) url.searchParams.set("fingerprintHash", fingerprintHash);
    if (expiresAt) url.searchParams.set("expiresAt", expiresAt);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": BROWSER_UA,
      },
    });

    if (response.status === 401) {
      return { ok: false, data: { error: "authorization_pending" } };
    }

    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        data: { error: "poll_failed", error_description: `HTTP ${response.status}: ${text}` },
      };
    }

    const data = await response.json();
    const u = data.default || data.user || (data.authToken ? data : null);

    if (u && u.authToken) {
      return {
        ok: true,
        data: {
          access_token: u.authToken,
          _userId: u.id,
          _email: u.email,
          _name: u.name,
          _fingerprintId: u.fingerprintId || fingerprintId,
          _fingerprintHash: u.fingerprintHash || fingerprintHash,
        },
      };
    }

    return { ok: false, data: { error: "authorization_pending" } };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: null,
    expiresIn: null,
    email: tokens._email || null,
    displayName: tokens._name || tokens._email || "Freebuff User",
    name: tokens._name || tokens._email || "Freebuff User",
    providerSpecificData: {
      userId: tokens._userId,
      fingerprintId: tokens._fingerprintId,
      fingerprintHash: tokens._fingerprintHash,
    },
  }),
};

export default freebuff;
