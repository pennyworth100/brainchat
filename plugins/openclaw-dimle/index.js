import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { dimlePlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "dimle",
  name: "Dimle",
  description: "Native OpenClaw channel for Dimle rooms",
  plugin: dimlePlugin,
});
