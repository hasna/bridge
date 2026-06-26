import type { BridgeConfig, BridgeMessage, ChannelConfig, RoutedMessageResult, RouteConfig } from "../types.js";
import { runAgent } from "./agents.js";
import { imessageHandleAllowed, sendIMessage } from "./imessage.js";
import { sendTelegramMessage, telegramChatAllowed, telegramToken } from "./telegram.js";

export interface RouteMessageOptions {
  run?: typeof runAgent;
  sendTelegram?: typeof sendTelegramMessage;
  writeConsole?: ((text: string) => void) | false;
}

export function matchingRoutes(config: BridgeConfig, message: BridgeMessage): RouteConfig[] {
  const channel = config.channels[message.channelId];
  if (!channel || channel.enabled === false) return [];
  if (channel?.kind === "telegram" && !telegramChatAllowed(channel, message.chatId)) {
    return [];
  }
  if (channel?.kind === "imessage" && !imessageHandleAllowed(channel, message.from || (message.chatId?.startsWith("chat:") ? undefined : message.chatId))) {
    return [];
  }

  return config.routes.filter((route) => {
    if (route.enabled === false) return false;
    if (route.fromChannel !== message.channelId) return false;
    if (route.match?.chatIds?.length && (!message.chatId || !route.match.chatIds.includes(message.chatId))) return false;
    if (route.match?.textRegex && !new RegExp(route.match.textRegex).test(message.text)) return false;
    return true;
  });
}

function responseChannel(config: BridgeConfig, route: RouteConfig, message: BridgeMessage): ChannelConfig | undefined {
  return config.channels[route.responseChannel || message.channelId];
}

export async function routeMessage(
  config: BridgeConfig,
  message: BridgeMessage,
  options: RouteMessageOptions = {},
): Promise<RoutedMessageResult[]> {
  const run = options.run || runAgent;
  const sendTelegram = options.sendTelegram || sendTelegramMessage;
  const results: RoutedMessageResult[] = [];

  for (const route of matchingRoutes(config, message)) {
    const agent = await run(config, route.toAgent, { message, route });
    let deliveredResponse = false;
    const channel = responseChannel(config, route, message);
    const responseText = agent.stdout.trim();

    if (channel?.enabled === false) {
      results.push({ route, agent, deliveredResponse });
      continue;
    }

    if (responseText && channel?.kind === "telegram" && message.chatId) {
      if (!telegramChatAllowed(channel, message.chatId)) {
        results.push({ route, agent, deliveredResponse });
        continue;
      }
      await sendTelegram(telegramToken(channel), message.chatId, responseText);
      deliveredResponse = true;
    } else if (responseText && channel?.kind === "console") {
      if (options.writeConsole !== false) (options.writeConsole || console.log)(responseText);
      deliveredResponse = true;
    } else if (responseText && channel?.kind === "imessage") {
      const handle = message.responseTargetId || message.chatId || message.from;
      const allowedIdentity = message.from || (handle?.startsWith("chat:") ? undefined : handle);
      if (handle && imessageHandleAllowed(channel, allowedIdentity)) {
        await sendIMessage(channel, handle, responseText, { allowChatTarget: handle.startsWith("chat:") });
        deliveredResponse = true;
      }
    }

    results.push({ route, agent, deliveredResponse });
  }

  return results;
}
