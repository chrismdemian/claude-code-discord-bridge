import type {
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
} from "discord.js";
import type { BridgeSession } from "../types";
import type { HookReceiver } from "../hook-receiver";
import type { McpRelay } from "../mcp-relay";
import { handleStopInteraction } from "./stop-handler";
import { buildResolvedEmbed } from "./permission-handler";
import { LOG_PREFIX } from "../constants";

/** Handle reaction-based quick actions on session messages */
export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  findSessionByForumPostId: (id: string) => BridgeSession | undefined,
  hookReceiver: HookReceiver,
  guildOwnerId: string,
  relay?: McpRelay,
): Promise<void> {
  // Skip bot reactions
  if (user.bot) return;

  // Access control: only guild owner
  if (user.id !== guildOwnerId) return;

  // Fetch partial reactions/messages if needed
  try {
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }
  } catch {
    return; // Can't fetch — ignore
  }

  const channelId = reaction.message.channelId;
  const session = findSessionByForumPostId(channelId);
  if (!session) return;

  const emoji = reaction.emoji.name;

  try {
    switch (emoji) {
      case "✅": {
        // Approve pending permission — verify reaction is on the permission message
        const pending = hookReceiver.getPendingPermission(session.sessionId);
        if (pending && pending.messageId === reaction.message.id) {
          hookReceiver.resolvePermission(session.sessionId, true);
          // Update the embed to show approved
          const originalEmbed = reaction.message.embeds[0];
          if (originalEmbed) {
            await reaction.message.edit({
              embeds: [buildResolvedEmbed(originalEmbed, true)],
              components: [],
            });
          }
        }
        break;
      }

      case "❌": {
        // Deny pending permission
        const pending = hookReceiver.getPendingPermission(session.sessionId);
        if (pending && pending.messageId === reaction.message.id) {
          hookReceiver.resolvePermission(session.sessionId, false);
          const originalEmbed = reaction.message.embeds[0];
          if (originalEmbed) {
            await reaction.message.edit({
              embeds: [buildResolvedEmbed(originalEmbed, false)],
              components: [],
            });
          }
        }
        break;
      }

      case "⏸️": {
        // Pause/interrupt the session
        await handleStopInteraction(session, relay);
        break;
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Reaction handler error:`, err);
  }
}
