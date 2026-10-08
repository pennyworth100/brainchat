import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDm } from "openclaw/plugin-sdk/channel-inbound";
import { createDimleClient, parseDimleTarget } from "./client.js";
import { CursorStore } from "./cursor-store.js";
import { runDimleMonitor } from "./monitor.js";

function section(cfg) {
  return cfg?.channels?.dimle || {};
}

export function resolveDimleAccount(cfg, accountId = "default") {
  const value = section(cfg);
  if (!value.baseUrl || !value.apiKey || !value.username || !Array.isArray(value.rooms)) {
    throw new Error("Dimle channel requires baseUrl, apiKey, username and rooms");
  }
  return {
    accountId: accountId || "default",
    enabled: value.enabled !== false,
    baseUrl: value.baseUrl,
    apiKey: value.apiKey,
    username: value.username,
    rooms: [...new Set(value.rooms.map((room) => parseDimleTarget(room)))],
    pollMs: value.pollMs || 1000,
  };
}

function inspectDimleAccount(cfg) {
  const value = section(cfg);
  const configured = Boolean(value.baseUrl && value.apiKey && value.username && value.rooms?.length);
  return {
    enabled: value.enabled !== false,
    configured,
    tokenStatus: value.apiKey ? "configured" : "missing",
  };
}

function deliveryId(params) {
  if (params.deliveryQueueId) {
    return `oc-${params.deliveryQueueId}-${params.deliveryPartIndex ?? 0}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  }
  return `oc-${crypto.randomUUID()}`;
}

const chatPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "dimle",
    capabilities: { chatTypes: ["group"] },
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: () => "default",
      resolveAccount: resolveDimleAccount,
      inspectAccount: inspectDimleAccount,
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => Boolean(account.apiKey && account.rooms.length),
      resolveDefaultTo: ({ cfg }) => {
        const room = section(cfg).rooms?.[0];
        return room ? `room:${parseDimleTarget(room)}` : undefined;
      },
    },
    setup: {},
  }),

  outbound: {
    attachedResults: {
      channel: "dimle",
      async sendText(params) {
        const account = resolveDimleAccount(params.cfg, params.accountId);
        const client = createDimleClient(account);
        const result = await client.sendMessage({
          roomId: parseDimleTarget(params.to),
          text: params.text,
          clientMessageId: deliveryId(params),
        });
        return { messageId: String(result.message.id) };
      },
    },
  },

});

export const dimlePlugin = {
  ...chatPlugin,

  status: {
    async probeAccount({ account }) {
      const client = createDimleClient(account);
      await client.getMessages(account.rooms[0], 0);
      return { ok: true, rooms: account.rooms.length };
    },
  },

  gateway: {
    async startAccount(ctx) {
      if (!ctx.channelRuntime) throw new Error("Dimle requires the OpenClaw channel runtime");
      const client = createDimleClient(ctx.account);
      const stateRoot = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
      const cursorStore = new CursorStore(
        path.join(stateRoot, "channels", "dimle", `${ctx.account.accountId}-cursors.json`)
      );
      ctx.setStatus({ ...ctx.getStatus(), running: true, connected: true });
      await runDimleMonitor({
        rooms: ctx.account.rooms,
        ownUsername: ctx.account.username,
        pollMs: ctx.account.pollMs,
        client,
        cursorStore,
        signal: ctx.abortSignal,
        log: ctx.log,
        dispatch: async (event) => {
          let replyIndex = 0;
          await dispatchInboundDirectDm({
            channelRuntime: ctx.channelRuntime,
            cfg: ctx.cfg,
            channel: "dimle",
            channelLabel: "Dimle",
            accountId: ctx.account.accountId,
            peer: { kind: "direct", id: `room:${event.roomId}` },
            senderId: String(event.username),
            senderAddress: `user:${event.username}`,
            recipientAddress: `room:${event.roomId}`,
            conversationLabel: event.roomId,
            rawBody: event.message,
            messageId: String(event.id),
            timestamp: event.ts,
            provider: "dimle",
            surface: "dimle",
            originatingChannel: "dimle",
            originatingTo: `room:${event.roomId}`,
            channelIngress: "unsupported",
            inboundAccessAuthorized: true,
            onRecordError: (error) => ctx.log?.error?.(`Dimle record error: ${String(error)}`),
            onDispatchError: (error) => ctx.log?.error?.(`Dimle dispatch error: ${String(error)}`),
            deliver: async (payload) => {
              if (!payload.text) return;
              const id = `reply-${event.id}-${replyIndex++}`;
              await client.sendMessage({ roomId: event.roomId, text: payload.text, clientMessageId: id });
            },
          });
        },
      });
      ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false });
    },
  },
};
