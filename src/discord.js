// BAS Bot: every case is posted to the moderation channel with the panel's actions as buttons and a link
// to the case in the panel. The message is edited when the case changes. Clicking a button runs the same
// action as the panel; destructive ones (remove, ban) ask for confirmation first.

import { ACTIONS, caseTab, panelUrl, performCaseAction, targetSummary } from './moderation.js';
import { fail, json } from './lib/http.js';
import { hexToBytes } from './lib/util.js';

const API = 'https://discord.com/api/v10';

// The moderation team speaks Portuguese; keep bot texts here.
const T = {
  tab: { mass: '🚨 Denunciado em massa', reports: '📝 Denúncia', review: '🔎 Revisão' },
  critical: '⚠️ Denúncia grave',
  closed: '✅ Decidido',
  reports: 'Denúncias',
  findings: 'Verificações automáticas',
  resolution: 'Decisão',
  autoHidden: 'Ocultado automaticamente até alguém decidir.',
  openPanel: 'Abrir no painel',
  notModerator: 'Só moderadores vinculados podem usar estes botões.',
  confirm: (action) => `Tem certeza? Isso vai **${ACTION_LABEL[action]}**.`,
  done: (action, who) => `${ACTION_LABEL[action]} por ${who}.`,
  failed: 'Não foi possível: ',
};
const ACTION_LABEL = {
  approve: 'Aprovar',
  hide: 'Ocultar',
  remove: 'Remover',
  ban: 'Banir o autor',
  clear_profile: 'Limpar perfil',
};
const ACTION_STYLE = { approve: 3, hide: 2, clear_profile: 2, remove: 4, ban: 4 };
const NEEDS_CONFIRMATION = new Set(['remove', 'ban']);

function configured(env) {
  return !!(env.DISCORD_BOT_TOKEN && env.DISCORD_MOD_CHANNEL_ID);
}

async function discordFetch(env, path, init) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'bas-community' },
  });
  if (!response.ok) throw new Error(`discord ${response.status}`);
  return response.json();
}

export async function buildCaseMessage(env, row) {
  const c = { env };
  const target = await targetSummary(c, row);
  const tab = caseTab(row);
  const findings = JSON.parse(row.findings).filter((item) => item.message).slice(0, 4);
  const headline = row.status !== 'open'
    ? T.closed
    : tab === 'reports' && row.max_severity >= 3 ? T.critical : T.tab[tab];
  const fields = [];
  if (row.report_count) fields.push({ name: T.reports, value: String(row.report_count), inline: true });
  if (findings.length) fields.push({ name: T.findings, value: findings.map((item) => `• ${item.message}`).join('\n').slice(0, 1000) });
  if (row.status !== 'open') fields.push({ name: T.resolution, value: ACTION_LABEL[row.resolution] || row.resolution || '-', inline: true });
  const description = [target.owner ? `@${target.owner}` : '', row.auto_hidden && row.status === 'open' ? T.autoHidden : '']
    .filter(Boolean)
    .join('\n');

  const buttons = row.status === 'open'
    ? ACTIONS[row.target_type].map((action) => ({
        type: 2,
        style: ACTION_STYLE[action],
        label: ACTION_LABEL[action],
        custom_id: `${NEEDS_CONFIRMATION.has(action) ? 'ask' : 'do'}:${action}:${row.id}`,
      }))
    : [];
  buttons.push({ type: 2, style: 5, label: T.openPanel, url: panelUrl(env, row.id) });

  const embed = {
    title: String(target.title || row.target_type).slice(0, 200),
    description: description || undefined,
    color: row.status !== 'open' ? 0x57f287 : tab === 'mass' || row.max_severity >= 3 ? 0xed4245 : tab === 'reports' ? 0xfee75c : 0x5865f2,
    fields,
  };
  const image = target.preview_url || target.image_url;
  if (image) embed.thumbnail = { url: image };
  return {
    content: headline,
    embeds: [embed],
    components: [{ type: 1, components: buttons.slice(0, 5) }],
    allowed_mentions: { parse: [] }, // user text can never ping anyone
  };
}

// Posts the case, or edits the message posted earlier. Never throws: Discord is best effort.
export async function notifyCase(env, caseId) {
  if (!configured(env)) return;
  try {
    const row = await env.DB.prepare('SELECT * FROM cases WHERE id = ?').bind(caseId).first();
    if (!row) return;
    const message = await buildCaseMessage(env, row);
    const existing = await env.DB.prepare('SELECT channel_id, message_id FROM discord_messages WHERE case_id = ?').bind(caseId).first();
    if (existing) {
      await discordFetch(env, `/channels/${existing.channel_id}/messages/${existing.message_id}`, {
        method: 'PATCH',
        body: JSON.stringify(message),
      });
      return;
    }
    const posted = await discordFetch(env, `/channels/${env.DISCORD_MOD_CHANNEL_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify(message),
    });
    await env.DB.prepare('INSERT OR REPLACE INTO discord_messages (case_id, channel_id, message_id) VALUES (?, ?, ?)')
      .bind(caseId, env.DISCORD_MOD_CHANNEL_ID, posted.id)
      .run();
  } catch (err) {
    console.error('discord notify failed', err && err.message);
  }
}

async function verifySignature(env, request, body, now) {
  const signature = request.headers.get('X-Signature-Ed25519') || '';
  const timestamp = request.headers.get('X-Signature-Timestamp') || '';
  if (!/^[0-9a-f]{128}$/.test(signature) || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(env.DISCORD_PUBLIC_KEY || '')) {
    return false;
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', hexToBytes(env.DISCORD_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
}

const ephemeral = (content) => json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

export async function interactions(c) {
  const body = await c.request.text();
  if (body.length > 64 * 1024 || !(await verifySignature(c.env, c.request, body, c.now))) {
    throw fail(401, 'bad_signature', 'Invalid request signature');
  }
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return json({ type: 1 }); // PING
  if (interaction.type !== 3) return ephemeral('?');

  const discordUser = (interaction.member && interaction.member.user) || interaction.user || {};
  const moderator = await c.env.DB.prepare(
    "SELECT * FROM users WHERE discord_id = ? AND status = 'active' AND role IN ('moderator', 'owner')",
  ).bind(String(discordUser.id || '')).first();
  if (!moderator) return ephemeral(T.notModerator);

  const [mode, action, caseId] = String(interaction.data && interaction.data.custom_id || '').split(':');
  const row = caseId ? await c.env.DB.prepare('SELECT * FROM cases WHERE id = ?').bind(caseId).first() : null;
  if (!row || !ACTION_LABEL[action]) return ephemeral(`${T.failed}?`);

  if (mode === 'ask') {
    return json({
      type: 4,
      data: {
        content: T.confirm(action),
        flags: 64,
        allowed_mentions: { parse: [] },
        components: [{ type: 1, components: [{ type: 2, style: 4, label: ACTION_LABEL[action], custom_id: `do:${action}:${row.id}` }] }],
      },
    });
  }
  if (mode !== 'do') return ephemeral(`${T.failed}?`);

  try {
    await performCaseAction(c, row, moderator, 'discord', action, `via Discord`);
  } catch (err) {
    return ephemeral(`${T.failed}${err.message}`);
  }
  // Refresh the case message in the channel (the click may have come from the confirmation message).
  c.waitUntil(notifyCase(c.env, row.id));
  return ephemeral(T.done(action, `@${moderator.handle}`));
}
