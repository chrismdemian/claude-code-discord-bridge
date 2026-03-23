#!/usr/bin/env node
// Quick utility to read recent Discord messages from a forum thread.
// Usage: node scripts/read-discord.js [thread_id] [limit]

const fs = require('fs');
const path = require('path');
const https = require('https');

// Load config
const home = process.env.HOME || process.env.USERPROFILE;
const envPath = path.join(home, '.discord-bridge', '.env');
const configPath = path.join(home, '.discord-bridge', 'discord.json');

let token;
try {
  const env = fs.readFileSync(envPath, 'utf8');
  const match = env.match(/DISCORD_TOKEN=(.+)/);
  token = match?.[1]?.trim();
} catch { }

if (!token) {
  console.error('No DISCORD_TOKEN found');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Bot ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
  });
}

async function main() {
  const threadId = process.argv[2];
  const limit = process.argv[3] || 25;

  if (!threadId) {
    // List active threads
    const data = await fetchJSON(
      `https://discord.com/api/v10/guilds/${config.guildId}/threads/active`
    );
    console.log('Active threads:');
    for (const t of (data.threads || [])) {
      if (t.parent_id !== config.forumChannelId) continue;
      console.log(`  ${t.id}: ${t.name} (${t.message_count || 0} msgs)`);
    }
    console.log('\nUsage: node scripts/read-discord.js <thread_id> [limit]');
    return;
  }

  const msgs = await fetchJSON(
    `https://discord.com/api/v10/channels/${threadId}/messages?limit=${limit}`
  );

  if (!Array.isArray(msgs)) {
    console.error('Error:', msgs);
    return;
  }

  msgs.reverse();

  for (const m of msgs) {
    const author = m.author?.username || '?';
    const content = m.content || '';
    const embeds = m.embeds?.length || 0;
    const files = m.attachments?.length || 0;

    let meta = [];
    if (embeds) meta.push(`${embeds} embed(s)`);
    if (files) meta.push(`${files} file(s)`);
    const metaStr = meta.length ? ` [${meta.join(', ')}]` : '';

    console.log(`\x1b[36m[${author}]\x1b[0m${metaStr}`);
    if (content) console.log(content);
    if (embeds) {
      for (const e of m.embeds) {
        console.log(`  \x1b[33m[embed: ${e.title || 'untitled'}]\x1b[0m ${(e.description || '').slice(0, 200)}`);
      }
    }
    console.log('');
  }
}

main().catch(console.error);
