import * as path from "node:path";
import {
  Client,
  GatewayIntentBits,
  IntentsBitField,
  Partials,
  ChannelType,
  EmbedBuilder,
  ActivityType,
  ThreadAutoArchiveDuration,
  type ForumChannel,
  type GuildForumTagData,
  type ThreadChannel,
} from "discord.js";
import type { DiscordConfig, WebhookRef } from "./types";
import { buildNewPromptButton } from "./interactions/modal-handler";
import {
  COLORS,
  FORUM_TAGS,
  WEBHOOK_NAMES,
  CATEGORY_NAME,
  FORUM_CHANNEL_NAME,
  DASHBOARD_CHANNEL_NAME,
  ALERTS_CHANNEL_NAME,
  LOG_PREFIX,
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

    client.once("ready", () => {
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

/** Validate that required privileged intents are enabled after login */
export function validateIntents(client: Client): void {
  const intents = new IntentsBitField(client.options.intents);
  const required: { bit: GatewayIntentBits; name: string; privileged: boolean }[] = [
    { bit: GatewayIntentBits.Guilds, name: "Guilds", privileged: false },
    { bit: GatewayIntentBits.GuildMessages, name: "Guild Messages", privileged: false },
    { bit: GatewayIntentBits.MessageContent, name: "Message Content", privileged: true },
  ];

  for (const { bit, name, privileged } of required) {
    if (!intents.has(bit)) {
      const hint = privileged
        ? ` Go to https://discord.com/developers/applications → Your App → Bot → Enable '${name} Intent'.`
        : "";
      console.error(
        `${LOG_PREFIX} ERROR: Required intent '${name}' is missing.${hint} The bridge cannot function without it.`,
      );
      process.exit(1);
    }
  }
  console.log(`${LOG_PREFIX} All required intents verified`);
}

/** Set up guild structure (idempotent: finds existing before creating) */
export async function setupServer(
  client: Client,
  guildId: string,
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

  // --- Webhooks on forum channel ---
  const existingWebhooks = await forumChannel.fetchWebhooks();
  const webhooks: Record<string, WebhookRef> = {};

  for (const name of WEBHOOK_NAMES) {
    let wh = existingWebhooks.find((w) => w.name === name);
    if (!wh) {
      console.log(`${LOG_PREFIX} Creating webhook: ${name}`);
      wh = await forumChannel.createWebhook({ name });
    }
    if (!wh.token) {
      console.warn(
        `${LOG_PREFIX} Webhook "${name}" has no token — recreating`,
      );
      await wh.delete();
      wh = await forumChannel.createWebhook({ name });
    }
    webhooks[name.toLowerCase()] = { id: wh.id, token: wh.token! };
  }

  const discordConfig: DiscordConfig = {
    guildId,
    forumChannelId: forumChannel.id,
    dashboardChannelId: dashboard.id,
    alertsChannelId: alerts.id,
    categoryId: category.id,
    webhooks: {
      claude: webhooks.claude,
      terminal: webhooks.terminal,
      editor: webhooks.editor,
      playwright: webhooks.playwright,
      git: webhooks.git,
      system: webhooks.system,
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

/** Create a forum post for a new session */
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

  const projectName = path.basename(session.cwd);
  const shortId = session.sessionId.slice(0, 8);
  const postName = `${projectName} — ${shortId}`.slice(0, 100);

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
    message: { embeds: [embed], components: [buttonRow] },
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
    await thread.send({ embeds: [embed] });

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
