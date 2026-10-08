const MAX_MESSAGE_LENGTH = 10_000;

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Dimle baseUrl must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

async function requestJson(url, options, timeoutMs = 10_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error || `Dimle HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function createDimleClient({ baseUrl, apiKey, timeoutMs = 10_000 }) {
  const root = normalizeBaseUrl(baseUrl);
  const headers = { "x-api-key": apiKey };

  return {
    async getMessages(roomId, afterId = 0) {
      const query = new URLSearchParams({ afterId: String(afterId) });
      const body = await requestJson(
        `${root}/api/messages/${encodeURIComponent(roomId)}?${query}`,
        { headers },
        timeoutMs
      );
      return Array.isArray(body.messages) ? body.messages : [];
    },

    async sendMessage({ roomId, text, clientMessageId }) {
      if (typeof text !== "string" || text.length < 1 || text.length > MAX_MESSAGE_LENGTH) {
        throw new Error("Dimle message must contain 1-10000 characters");
      }
      return requestJson(
        `${root}/api/send`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ roomId, message: text, clientMessageId }),
        },
        timeoutMs
      );
    },
  };
}

export function parseDimleTarget(target) {
  const roomId = String(target).replace(/^room:/, "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{4,64}$/.test(roomId)) throw new Error("Invalid Dimle room target");
  return roomId;
}
