// Telegram alerts. Silently off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
// are both set. Messages are queued and sent at most one per second.

import { config } from '../config.js';

const { botToken, chatId } = config.telegram;
const queue = [];
let sending = false;

export const telegramEnabled = !!(botToken && chatId);

function escape(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function drain() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const text = queue.shift();
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) console.warn(`[telegram] send failed (${res.status})`);
    } catch (err) {
      console.warn(`[telegram] send failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  sending = false;
}

// lines: [[label, value], ...]
export function alert(title, lines = []) {
  if (!telegramEnabled) return;
  const body = lines
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<b>${escape(k)}:</b> ${escape(v)}`)
    .join('\n');
  queue.push(`🚨 <b>${escape(title)}</b>\n${body}`);
  if (queue.length > 50) queue.splice(0, queue.length - 50);
  drain();
}
