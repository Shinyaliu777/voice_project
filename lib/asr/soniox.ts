/**
 * Soniox ASR provider.
 *
 * Phase 1 only needs the temporary-API-key mint flow: the browser will
 * connect to Soniox's WebSocket directly using this short-lived token,
 * so the server never relays raw audio.
 *
 * Docs: https://soniox.com/docs/ (Realtime / temporary API key)
 */
import type {
  ASRProvider,
  SonioxTokenRequest,
  SonioxTokenResponse,
} from "../contracts";

const SONIOX_TEMP_KEY_ENDPOINT =
  "https://api.soniox.com/v1/auth/temporary-api-key";

/** Default token lifetime if neither caller nor env overrides it. */
const DEFAULT_TTL_SECONDS = 600;

export class SonioxProvider implements ASRProvider {
  async mintTemporaryToken(
    req: SonioxTokenRequest
  ): Promise<SonioxTokenResponse> {
    const apiKey = process.env.SONIOX_API_KEY;
    if (!apiKey) {
      throw new Error(
        "SONIOX_API_KEY is not configured; cannot mint Soniox temporary token"
      );
    }

    const envTtl = Number(process.env.SONIOX_TOKEN_TTL_SECONDS);
    const expiresInSeconds =
      req.expiresInSeconds ??
      (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_TTL_SECONDS);

    const body: Record<string, unknown> = {
      usage_type: "transcribe_websocket",
      expires_in_seconds: expiresInSeconds,
    };
    if (req.clientReferenceId) {
      body.client_reference_id = req.clientReferenceId;
    }

    let response: Response;
    try {
      response = await fetch(SONIOX_TEMP_KEY_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Soniox token request failed (network): ${msg}`);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(
        `Soniox token request failed: status=${response.status} body=${text}`
      );
    }

    let parsed: { api_key?: string; expires_at?: string };
    try {
      parsed = (await response.json()) as {
        api_key?: string;
        expires_at?: string;
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Soniox token response was not valid JSON: ${msg}`);
    }

    if (!parsed.api_key || !parsed.expires_at) {
      throw new Error(
        `Soniox token response missing fields: ${JSON.stringify(parsed)}`
      );
    }

    const expiresAt = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new Error(
        `Soniox token response expires_at could not be parsed: ${parsed.expires_at}`
      );
    }

    return { token: parsed.api_key, expiresAt };
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}
