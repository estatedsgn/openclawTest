import 'dotenv/config';
import { Telegraf } from 'telegraf';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN in environment');
  process.exit(1);
}

const bot = new Telegraf(token);

// chatId -> { timer, intervalMs }
const jobs = new Map();

const WORDS = [
  'apple','river','stone','bright','silent','future','mirror','cloud','ocean','forest',
  'signal','coffee','window','travel','dream','planet','silver','gold','shadow','light',
  'simple','random','focus','energy','market','helper','message','reply','launch','build'
];

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function clampInterval(ms) {
  // protect from flood: keep sane bounds
  const min = 2000;
  const max = 60000;
  return Math.max(min, Math.min(max, ms));
}

function startJob(chatId, ctx, intervalMs = 3000) {
  stopJob(chatId);
  const base = clampInterval(intervalMs);

  const timer = setInterval(async () => {
    const jitter = Math.floor(Math.random() * 250);
    await new Promise(r => setTimeout(r, jitter));

    try {
      await ctx.telegram.sendMessage(chatId, pickWord());
    } catch (e) {
      console.error(
        'sendMessage failed, stopping job:',
        e?.response?.error_code,
        e?.response?.description
      );
      stopJob(chatId);
    }
  }, base);

  jobs.set(chatId, { timer, intervalMs: base });
}

function stopJob(chatId) {
  const job = jobs.get(chatId);
  if (job?.timer) clearInterval(job.timer);
  jobs.delete(chatId);
}

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  startJob(chatId, ctx, 3000);
  await ctx.reply(
    'OK. I will send a random English word every ~3 seconds. Use /stop to stop, /interval <sec> to change.'
  );
});

bot.command('stop', async (ctx) => {
  stopJob(ctx.chat.id);
  await ctx.reply('Stopped.');
});

bot.command('interval', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const sec = Number(parts[1]);
  if (!Number.isFinite(sec) || sec <= 0) {
    await ctx.reply('Usage: /interval 3  (seconds). Min is 2 seconds.');
    return;
  }
  const ms = clampInterval(Math.round(sec * 1000));
  startJob(ctx.chat.id, ctx, ms);
  await ctx.reply(`Interval set to ~${ms / 1000}s`);
});

bot.command('status', async (ctx) => {
  const job = jobs.get(ctx.chat.id);
  await ctx.reply(job ? `Running. Interval: ${job.intervalMs / 1000}s` : 'Not running. Send /start');
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
