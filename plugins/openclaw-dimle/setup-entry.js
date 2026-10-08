import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { dimlePlugin } from "./src/channel.js";

export default defineSetupPluginEntry(dimlePlugin);
