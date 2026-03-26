import * as path from "node:path";
import * as fs from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  IntentsBitField,
  Partials,
  ChannelType,
  EmbedBuilder,
  ActivityType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ForumChannel,
  type GuildForumTagData,
  type ThreadChannel,
} from "discord.js";
import type { DiscordConfig, WebhookRef } from "./types";
import { buildNewPromptButton } from "./interactions/modal-handler";
import { parseProjectName } from "./formatters/utils";
import {
  COLORS,
  FORUM_TAGS,
  CATEGORY_NAME,
  FORUM_CHANNEL_NAME,
  DASHBOARD_CHANNEL_NAME,
  ALERTS_CHANNEL_NAME,
  LOG_PREFIX,
  SESSIONS_DIR,
} from "./constants";

/** Create a new Discord client with required intents */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });
}

/** Check if an error is a disallowed intents error (gateway close code 4014) */
function isDisallowedIntentsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e.code === "DisallowedIntents" ||
    e.code === 4014 ||
    String(e.message ?? "").toLowerCase().includes("disallowed intent")
  );
}

/** Log a clear intent error message and exit */
function exitWithIntentError(): never {
  console.error(
    `${LOG_PREFIX} ERROR: Message Content intent is not enabled. ` +
      `Go to https://discord.com/developers/applications → Your App → Bot → ` +
      `Enable 'Message Content Intent'. The bridge cannot receive messages without this.`,
  );
  process.exit(1);
}

/** Login and wait for the client to be ready */
export function login(client: Client, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Discord client did not become ready within 30s"));
    }, 30_000);

    // Detect disallowed intents during gateway handshake (close code 4014)
    const handleIntentError = (err: Error) => {
      if (isDisallowedIntentsError(err)) {
        clearTimeout(timeout);
        exitWithIntentError();
      }
    };
    client.on("shardError", handleIntentError);

    client.once(Events.ClientReady, () => {
      clearTimeout(timeout);
      client.removeListener("shardError", handleIntentError);
      console.log(`${LOG_PREFIX} Bot logged in as ${client.user?.tag}`);
      resolve();
    });
    client.login(token).catch((err) => {
      clearTimeout(timeout);
      client.removeListener("shardError", handleIntentError);
      if (isDisallowedIntentsError(err)) {
        exitWithIntentError();
      }
      reject(err);
    });
  });
}

/**
 * Defensive self-check: verify the client was constructed with all required intents.
 * This guards against code drift (e.g. someone removing an intent from createClient()).
 * The actual Discord-side rejection is caught by the shardError handler in login().
 */
export function validateIntents(client: Client): void {
  const intents = new IntentsBitField(client.options.intents);
  const required: { bit: GatewayIntentBits; name: string }[] = [
    { bit: GatewayIntentBits.Guilds, name: "Guilds" },
    { bit: GatewayIntentBits.GuildMessages, name: "Guild Messages" },
    { bit: GatewayIntentBits.MessageContent, name: "Message Content" },
  ];

  const missing = required.filter(({ bit }) => !intents.has(bit));
  if (missing.length > 0) {
    console.error(
      `${LOG_PREFIX} ERROR: Client is missing required intents: ${missing.map((m) => m.name).join(", ")}. Fix createClient() in discord-bot.ts.`,
    );
    process.exit(1);
  }
}

/** Set up guild structure (idempotent: finds existing before creating) */
export async function setupServer(
  client: Client,
  guildId: string,
  botUsername: string,
): Promise<DiscordConfig> {
  if (!/^\d{17,20}$/.test(guildId)) {
    throw new Error(
      `Invalid DISCORD_GUILD_ID: "${guildId}" — must be a Discord snowflake (17-20 digit number)`,
    );
  }
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();

  // --- Category ---
  const category =
    channels.find(
      (ch) =>
        ch?.name === CATEGORY_NAME && ch.type === ChannelType.GuildCategory,
    ) ??
    (await (async () => {
      console.log(`${LOG_PREFIX} Creating category: ${CATEGORY_NAME}`);
      return guild.channels.create({
        name: CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    })());
  if (category.name === CATEGORY_NAME)
    console.log(`${LOG_PREFIX} Using category: ${CATEGORY_NAME}`);

  // --- Forum channel ---
  let forumChannel = channels.find(
    (ch) =>
      ch?.name === FORUM_CHANNEL_NAME &&
      ch.type === ChannelType.GuildForum &&
      ch.parentId === category.id,
  ) as ForumChannel | undefined;

  if (!forumChannel) {
    console.log(`${LOG_PREFIX} Creating forum channel: ${FORUM_CHANNEL_NAME}`);
    const tags: GuildForumTagData[] = Object.values(FORUM_TAGS).map((tag) => ({
      name: tag.name,
      moderated: tag.moderated,
    }));
    forumChannel = (await guild.channels.create({
      name: FORUM_CHANNEL_NAME,
      type: ChannelType.GuildForum,
      parent: category.id,
      availableTags: tags,
    })) as ForumChannel;
  } else {
    console.log(
      `${LOG_PREFIX} Found existing forum channel: ${FORUM_CHANNEL_NAME}`,
    );
    // Ensure all tags exist
    const existingTagNames = new Set(
      forumChannel.availableTags.map((t) => t.name),
    );
    const missingTags = Object.values(FORUM_TAGS).filter(
      (t) => !existingTagNames.has(t.name),
    );
    if (missingTags.length > 0) {
      const updatedTags = [
        ...forumChannel.availableTags,
        ...missingTags.map((t) => ({ name: t.name, moderated: t.moderated })),
      ];
      await forumChannel.setAvailableTags(updatedTags);
      // Re-fetch to get updated tag IDs
      forumChannel = (await client.channels.fetch(
        forumChannel.id,
      )) as ForumChannel;
      console.log(
        `${LOG_PREFIX} Added ${missingTags.length} missing tags to forum channel`,
      );
    }
  }

  // --- Dashboard channel ---
  const dashboard =
    channels.find(
      (ch) =>
        ch?.name === DASHBOARD_CHANNEL_NAME &&
        ch.type === ChannelType.GuildText &&
        ch.parentId === category.id,
    ) ??
    (await (async () => {
      console.log(
        `${LOG_PREFIX} Creating text channel: ${DASHBOARD_CHANNEL_NAME}`,
      );
      return guild.channels.create({
        name: DASHBOARD_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: category.id,
      });
    })());

  // --- Alerts channel ---
  const alerts =
    channels.find(
      (ch) =>
        ch?.name === ALERTS_CHANNEL_NAME &&
        ch.type === ChannelType.GuildText &&
        ch.parentId === category.id,
    ) ??
    (await (async () => {
      console.log(
        `${LOG_PREFIX} Creating text channel: ${ALERTS_CHANNEL_NAME}`,
      );
      return guild.channels.create({
        name: ALERTS_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: category.id,
      });
    })());

  // --- Webhook on forum channel (named after the bot) ---
  const existingWebhooks = await forumChannel.fetchWebhooks();

  // Clean up legacy per-tool webhooks from previous versions
  const legacyNames = new Set(["Terminal", "Editor", "Playwright", "Git", "System"]);
  for (const wh of existingWebhooks.values()) {
    if (legacyNames.has(wh.name)) {
      console.log(`${LOG_PREFIX} Removing legacy webhook: ${wh.name}`);
      await wh.delete().catch(() => {});
    }
  }

  // Load avatar for webhook branding
  const avatarPath = path.resolve(import.meta.dir, "..", "assets", "claude-code-avatar.png");
  const avatarFile = Bun.file(avatarPath);
  const webhookAvatar = (await avatarFile.exists())
    ? Buffer.from(await avatarFile.arrayBuffer())
    : undefined;

  let claudeWebhook = existingWebhooks.find((w) => w.name === botUsername);
  if (!claudeWebhook) {
    // Also check for the old hardcoded "Claude" name and rename it
    const legacyClaude = existingWebhooks.find((w) => w.name === "Claude");
    if (legacyClaude) {
      console.log(`${LOG_PREFIX} Renaming webhook "Claude" → "${botUsername}"`);
      claudeWebhook = await legacyClaude.edit({ name: botUsername, avatar: webhookAvatar });
    } else {
      console.log(`${LOG_PREFIX} Creating webhook: ${botUsername}`);
      claudeWebhook = await forumChannel.createWebhook({ name: botUsername, avatar: webhookAvatar });
    }
  } else if (webhookAvatar && !claudeWebhook.avatarURL()) {
    // Webhook exists but has no avatar — set it
    await claudeWebhook.edit({ avatar: webhookAvatar }).catch(() => {});
  }
  if (!claudeWebhook.token) {
    console.warn(`${LOG_PREFIX} Webhook "${botUsername}" has no token — recreating`);
    await claudeWebhook.delete();
    claudeWebhook = await forumChannel.createWebhook({ name: botUsername, avatar: webhookAvatar });
  }

  const discordConfig: DiscordConfig = {
    guildId,
    forumChannelId: forumChannel.id,
    dashboardChannelId: dashboard.id,
    alertsChannelId: alerts.id,
    categoryId: category.id,
    webhooks: {
      claude: { id: claudeWebhook.id, token: claudeWebhook.token! },
    },
  };

  console.log(`${LOG_PREFIX} Server setup complete`);
  return discordConfig;
}

/** Build a map from our FORUM_TAGS keys to Discord-assigned tag IDs */
export function buildTagMap(
  forumChannel: ForumChannel,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, def] of Object.entries(FORUM_TAGS)) {
    const found = forumChannel.availableTags.find((t) => t.name === def.name);
    if (found) map[key] = found.id;
  }
  return map;
}

/** Find an existing active forum post for a session (by session ID prefix in embed) */
async function findExistingPost(
  forumChannel: ForumChannel,
  sessionId: string,
): Promise<ThreadChannel | null> {
  try {
    const { threads } = await forumChannel.threads.fetchActive();
    const prefix = sessionId.slice(0, 18);

    for (const thread of threads.values()) {
      if (thread.parentId !== forumChannel.id) continue;
      try {
        const starter = await (thread as ThreadChannel).fetchStarterMessage();
        const sessionField = starter?.embeds?.[0]?.fields?.find(
          (f) => f.name === "Session",
        );
        if (sessionField?.value === prefix) {
          return thread as ThreadChannel;
        }
      } catch {
        // Starter message may be missing — skip
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error searching for existing post:`, err);
  }
  return null;
}

/** Create a forum post for a new session, or reuse an existing one */
export async function createForumPost(
  client: Client,
  config: DiscordConfig,
  session: {
    sessionId: string;
    pid: number;
    cwd: string;
    startedAt: string;
    model?: string;
  },
): Promise<ThreadChannel> {
  const forumChannel = (await client.channels.fetch(
    config.forumChannelId,
  )) as ForumChannel;

  // Check for an existing post from a previous bridge run
  const existing = await findExistingPost(forumChannel, session.sessionId);
  if (existing) {
    // Unarchive if it was archived
    if (existing.archived) {
      await existing.setArchived(false);
    }
    console.log(`${LOG_PREFIX} Reusing existing forum post: "${existing.name}" (${existing.id})`);
    return existing;
  }

  const projectName = parseProjectName(session.cwd);
  // Use a readable timestamp as the initial suffix (custom-title event will rename later)
  const startDate = new Date(parseInt(session.startedAt, 10) || Date.now());
  const timeStr = startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const postName = `${projectName} — ${timeStr}`.slice(0, 100);

  const startedAtSec = Math.floor(parseInt(session.startedAt, 10) / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`📖 Read-Only — ${projectName}`)
    .setColor(COLORS.BLUE)
    .addFields(
      { name: "Directory", value: `\`${session.cwd}\``, inline: false },
      { name: "PID", value: String(session.pid), inline: true },
      {
        name: "Session",
        value: session.sessionId.slice(0, 18),
        inline: true,
      },
      { name: "Started", value: `<t:${startedAtSec}:R>`, inline: true },
      { name: "Cost", value: "$0.00", inline: true },
      { name: "Context", value: "0% used", inline: true },
    )
    .setTimestamp();

  // Resolve tags
  const tagMap = buildTagMap(forumChannel);
  const appliedTags: string[] = [];
  if (tagMap.ACTIVE) appliedTags.push(tagMap.ACTIVE);

  if (session.model) {
    const modelLower = session.model.toLowerCase();
    const modelKey = modelLower.includes("opus")
      ? "OPUS"
      : modelLower.includes("haiku")
        ? "HAIKU"
        : "SONNET";
    if (tagMap[modelKey]) appliedTags.push(tagMap[modelKey]);
  }

  const buttonRow = buildNewPromptButton(session.sessionId);

  const post = await forumChannel.threads.create({
    name: postName,
    message: {
      embeds: [embed],
      components: [buttonRow],
      flags: [MessageFlags.SuppressNotifications],
    },
    appliedTags,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });

  console.log(`${LOG_PREFIX} Forum post created: "${postName}" (${post.id})`);
  return post;
}

/** Archive a forum post when a session ends */
export async function archiveForumPost(
  client: Client,
  config: DiscordConfig,
  threadId: string,
): Promise<void> {
  try {
    const thread = (await client.channels.fetch(threadId)) as ThreadChannel;
    if (!thread?.isThread()) return;

    // Swap status tags to Completed
    const forumChannel = (await client.channels.fetch(
      config.forumChannelId,
    )) as ForumChannel;
    const tagMap = buildTagMap(forumChannel);

    const statusTagIds = [tagMap.ACTIVE, tagMap.WORKING, tagMap.ERROR].filter(
      Boolean,
    );
    const currentTags = thread.appliedTags.filter(
      (t) => !statusTagIds.includes(t),
    );
    if (tagMap.COMPLETED) currentTags.push(tagMap.COMPLETED);

    await thread.setAppliedTags(currentTags);

    // Send completion embed
    const embed = new EmbedBuilder()
      .setTitle("✅ Session Ended")
      .setColor(COLORS.GRAY)
      .setTimestamp();
    await thread.send({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });

    // Archive
    await thread.setArchived(true);
    console.log(`${LOG_PREFIX} Forum post archived: ${threadId}`);
  } catch (err) {
    console.error(
      `${LOG_PREFIX} Failed to archive forum post ${threadId}:`,
      err,
    );
  }
}

/** Update bot presence to show active session count */
export function setBotPresence(client: Client, activeCount: number): void {
  if (!client.user) return;
  client.user.setPresence({
    activities: [
      {
        name: `${activeCount} active session${activeCount !== 1 ? "s" : ""}`,
        type: ActivityType.Watching,
      },
    ],
    status: activeCount > 0 ? "online" : "idle",
  });
}

/** Clean up orphaned forum posts from previous bridge runs.
 *  Finds posts tagged Active/Working with no matching running session and archives them. */
export async function cleanupOrphanedPosts(
  client: Client,
  config: DiscordConfig,
): Promise<number> {
  try {
    const forumChannel = (await client.channels.fetch(
      config.forumChannelId,
    )) as ForumChannel;
    const tagMap = buildTagMap(forumChannel);
    const activeTagIds = new Set(
      [tagMap.ACTIVE, tagMap.WORKING].filter(Boolean),
    );
    if (activeTagIds.size === 0) return 0;

    // Collect session IDs from currently running sessions
    const runningSessionIds = new Set<string>();
    try {
      const entries = fs.readdirSync(SESSIONS_DIR);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const filePath = path.join(SESSIONS_DIR, entry);
          const raw = await Bun.file(filePath).json();
          if (raw.sessionId) runningSessionIds.add(raw.sessionId);
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Sessions dir may not exist yet — all posts are orphaned
    }

    // Fetch all active (non-archived) threads
    const { threads } = await forumChannel.threads.fetchActive();

    let cleaned = 0;
    for (const thread of threads.values()) {
      const hasActiveTag = thread.appliedTags.some((t) => activeTagIds.has(t));
      if (!hasActiveTag) continue;

      // Extract session ID prefix from the starter embed
      const sessionIdPrefix = await extractSessionIdFromEmbed(
        thread as ThreadChannel,
      );
      if (!sessionIdPrefix) continue;

      // Check if any running session matches this prefix
      const isRunning = [...runningSessionIds].some((id) =>
        id.startsWith(sessionIdPrefix),
      );
      if (!isRunning) {
        await archiveForumPost(client, config, thread.id);
        cleaned++;
        // Brief pause between archival calls to avoid rate limit bursts
        if (cleaned < threads.size) await Bun.sleep(1000);
      }
    }

    return cleaned;
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to cleanup orphaned posts:`, err);
    return 0;
  }
}

/** Extract session ID prefix from a thread's starter message embed */
async function extractSessionIdFromEmbed(
  thread: ThreadChannel,
): Promise<string | null> {
  try {
    const starterMessage = await thread.fetchStarterMessage();
    if (!starterMessage?.embeds?.length) return null;
    const embed = starterMessage.embeds[0];
    const sessionField = embed.fields?.find((f) => f.name === "Session");
    return sessionField?.value ?? null;
  } catch {
    return null;
  }
}
