import 'dotenv/config';
import { Telegraf } from 'telegraf';
import http from 'http';
import fs from 'node:fs/promises';
import { google } from 'googleapis';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN in environment');
  process.exit(1);
}

const bot = new Telegraf(token);

// ----------------------------
// Google Sheets (processed leads only)
// ----------------------------
function getGServiceJson() {
  const raw = process.env.GSERVICE_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // allow passing raw with escaped newlines
    return JSON.parse(raw.replace(/\\n/g, '\n'));
  }
}

const GSHEET_ID = process.env.GSHEET_ID;
const GSHEET_TAB = process.env.GSHEET_TAB || 'Лист1';

async function getSheetsClient() {
  const creds = getGServiceJson();
  if (!creds) throw new Error('Missing GSERVICE_JSON');
  if (!GSHEET_ID) throw new Error('Missing GSHEET_ID');

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

const SHEET_HEADERS = ['timestamp', 'client_name', 'tg_contact', 'chat_id', 'status', 'manager'];

async function sheetGetValues(rangeA1) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GSHEET_ID,
    range: `${GSHEET_TAB}!${rangeA1}`
  });
  return res.data.values || [];
}

async function sheetUpdateValues(rangeA1, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: GSHEET_ID,
    range: `${GSHEET_TAB}!${rangeA1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
}

async function sheetAppendRow(values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: GSHEET_ID,
    range: `${GSHEET_TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });
}

async function sheetEnsureHeader() {
  const firstRow = await sheetGetValues('A1:F1');
  const current = firstRow?.[0] || [];
  const normalized = current.map((x) => String(x || '').trim().toLowerCase());
  const want = SHEET_HEADERS;
  const ok = want.every((h, i) => normalized[i] === h);
  if (!ok) {
    await sheetUpdateValues('A1:F1', [want]);
  }
}

async function sheetFindRowByChatId(chatId) {
  // Read D column (chat_id) from row 2 downward
  const col = await sheetGetValues('D2:D');
  for (let i = 0; i < col.length; i++) {
    const v = col[i]?.[0];
    if (String(v || '').trim() === String(chatId)) {
      return 2 + i; // actual row number
    }
  }
  return null;
}

async function sheetUpsertProcessedLead({ ts, clientName, tgContact, chatId, status, manager }) {
  await sheetEnsureHeader();
  const row = await sheetFindRowByChatId(chatId);
  const values = [ts, clientName, tgContact, String(chatId), status, manager];
  if (row) {
    await sheetUpdateValues(`A${row}:F${row}`, [values]);
  } else {
    await sheetAppendRow(values);
  }
}

// chatId -> runState
// runState: { mode: 'words'|'script', timer?, intervalMs?, stepId?, vars?, delayCfg?, awaiting? }
const jobs = new Map();

// ----------------------------
// Utilities
// ----------------------------
function clampMs(ms, { min = 2000, max = 60000 } = {}) {
  return Math.max(min, Math.min(max, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeYesNo(text = '') {
  const t = String(text).trim().toLowerCase();
  const yes = ['да', 'ага', 'ок', 'хорошо', 'конечно', 'давай', 'интересно'];
  const no = ['нет', 'неа', 'не', 'не интересно'];
  if (yes.some((w) => t === w || t.startsWith(w + ' '))) return 'yes';
  if (no.some((w) => t === w || t.startsWith(w + ' '))) return 'no';
  return 'unknown';
}

function applyTemplate(s, vars) {
  return String(s)
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      const v = vars?.[key];
      return v === undefined || v === null ? '' : String(v);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// ----------------------------
// Random-words mode (legacy)
// ----------------------------
const WORDS = [
  'apple',
  'river',
  'stone',
  'bright',
  'silent',
  'future',
  'mirror',
  'cloud',
  'ocean',
  'forest',
  'signal',
  'coffee',
  'window',
  'travel',
  'dream',
  'planet',
  'silver',
  'gold',
  'shadow',
  'light',
  'simple',
  'random',
  'focus',
  'energy',
  'market',
  'helper',
  'message',
  'reply',
  'launch',
  'build'
];

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function startWordsJob(chatId, ctx, intervalMs = 3000) {
  stopJob(chatId);
  const base = clampMs(intervalMs, { min: 2000, max: 60000 });

  const timer = setInterval(async () => {
    const jitter = randInt(0, 250);
    await sleep(jitter);

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

  jobs.set(chatId, { mode: 'words', timer, intervalMs: base });
}

function stopJob(chatId) {
  const job = jobs.get(chatId);
  if (job?.timer) clearInterval(job.timer);
  jobs.delete(chatId);
}

// ----------------------------
// Script mode (MVP, runs inside Telegram for testing)
// ----------------------------
let SCRIPT = null;
const SCRIPT_PATH = new URL('./avito_script.json', import.meta.url);

async function loadScript() {
  const raw = await fs.readFile(SCRIPT_PATH, 'utf8');
  SCRIPT = JSON.parse(raw);
  return SCRIPT;
}

function findStep(id) {
  return SCRIPT?.steps?.find((s) => s.id === id);
}

async function runStepMessages(chatId, ctx, step, vars, delayCfg) {
  const { min, max } = delayCfg;
  for (const m of step.messages || []) {
    const jitter = randInt(
      SCRIPT?.defaults?.jitterMs?.min ?? 0,
      SCRIPT?.defaults?.jitterMs?.max ?? 250
    );
    await sleep(jitter);

    const text = applyTemplate(m, vars);
    if (text) await ctx.telegram.sendMessage(chatId, text);

    const d = clampMs(randInt(min, max), { min: 0, max: 60000 });
    await sleep(d);
  }
}

function startScriptRun(chatId, ctx, vars, opts = {}) {
  stopJob(chatId);

  const delayCfg = {
    min: clampMs(opts.delayMinMs ?? SCRIPT?.defaults?.delayMs?.min ?? 2000, {
      min: 0,
      max: 60000
    }),
    max: clampMs(opts.delayMaxMs ?? SCRIPT?.defaults?.delayMs?.max ?? 5000, {
      min: 0,
      max: 60000
    })
  };

  const state = {
    mode: 'script',
    stepId:
      SCRIPT.steps.find((s) => s.on === 'start')?.id ?? SCRIPT.steps[0]?.id,
    vars,
    delayCfg,
    awaiting: null
  };

  jobs.set(chatId, state);

  (async () => {
    const step = findStep(state.stepId);
    if (!step) {
      await ctx.reply('Скрипт не найден/пустой.');
      stopJob(chatId);
      return;
    }

    await runStepMessages(chatId, ctx, step, state.vars, state.delayCfg);
    if (step.expect) {
      state.awaiting = step.expect;
    } else {
      await ctx.reply('Готово.');
      stopJob(chatId);
    }
  })().catch(async (e) => {
    console.error('script run failed', e);
    try {
      await ctx.reply('Ошибка при прогоне скрипта.');
    } catch {}
    stopJob(chatId);
  });
}

// ----------------------------
// Commands
// ----------------------------
bot.start(async (ctx) => {
  await ctx.reply(
    'Режимы:\n- /words_start — тестовый режим (рандомные слова)\n- /test_lead ... — прогон скрипта (как будто клиент)\n- /script_show — скрипт\n- /stop — остановить'
  );
});

bot.command('words_start', async (ctx) => {
  const chatId = ctx.chat.id;
  startWordsJob(chatId, ctx, 3000);
  await ctx.reply(
    'OK. Random words every ~3 seconds. /stop to stop, /interval <sec> to change.'
  );
});

bot.command('stop', async (ctx) => {
  stopJob(ctx.chat.id);
  await ctx.reply('Остановлено.');
});

bot.command('interval', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const sec = Number(parts[1]);
  if (!Number.isFinite(sec) || sec <= 0) {
    await ctx.reply('Usage: /interval 3  (seconds). Min is 2 seconds.');
    return;
  }
  const ms = clampMs(Math.round(sec * 1000), { min: 2000, max: 60000 });
  startWordsJob(ctx.chat.id, ctx, ms);
  await ctx.reply(`Interval set to ~${ms / 1000}s`);
});

bot.command('status', async (ctx) => {
  const job = jobs.get(ctx.chat.id);
  if (!job) {
    await ctx.reply('Ничего не запущено.');
    return;
  }
  if (job.mode === 'words') {
    await ctx.reply(`Words: running. Interval: ${job.intervalMs / 1000}s`);
    return;
  }
  await ctx.reply(
    `Script: step=${job.stepId}, awaiting=${job.awaiting?.type ?? 'none'}`
  );
});

bot.command('script_show', async (ctx) => {
  if (!SCRIPT) await loadScript();
  await ctx.reply('Скрипт загружен из avito_script.json');
});

bot.command('sheet_test', async (ctx) => {
  try {
    const ts = new Date().toISOString();
    await sheetUpsertProcessedLead({
      ts,
      clientName: 'TEST',
      tgContact: 'ok',
      chatId: ctx.chat.id,
      status: 'test',
      manager: 'Никита'
    });
    await ctx.reply('Sheets: OK (header ensured, upsert done).');
  } catch (e) {
    console.error('sheet_test failed', e);
    await ctx.reply(`Sheets: ERROR — ${e?.message || 'unknown'}`);
  }
});

// Пример:
// /test_lead client_name=Анна my_name=Иван my_role=помощник location_type=метро location_value=Павелецкая
bot.command('test_lead', async (ctx) => {
  if (!SCRIPT) await loadScript();
  const text = ctx.message.text;
  const parts = text.split(/\s+/).slice(1);
  const vars = {};
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z0-9_]+)=(.+)$/);
    if (m) vars[m[1]] = m[2];
  }

  // минимальные дефолты, чтобы не стопориться
  vars.client_name = vars.client_name ?? '';
  vars.my_name = vars.my_name ?? 'Никита';
  vars.my_role = vars.my_role ?? 'помощник';
  vars.location_type = vars.location_type ?? 'метро';
  vars.location_value = vars.location_value ?? 'не указано';

  startScriptRun(ctx.chat.id, ctx, vars);
});

// Advance script on user messages
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = jobs.get(chatId);
  if (!state || state.mode !== 'script' || !state.awaiting) return;

  const step = findStep(state.stepId);
  if (!step?.expect) return;

  const incoming = ctx.message.text;

  if (step.expect.type === 'yes_no') {
    const yn = normalizeYesNo(incoming);
    if (yn !== 'yes') {
      await ctx.reply('Ок, понял. (ветки возражений добавим позже)');
      stopJob(chatId);
      return;
    }

    const nextId = step.expect.yes;
    state.stepId = nextId;
    state.awaiting = null;

    const next = findStep(nextId);
    if (!next) {
      await ctx.reply('Следующий шаг не найден.');
      stopJob(chatId);
      return;
    }

    await runStepMessages(chatId, ctx, next, state.vars, state.delayCfg);
    if (next.expect) {
      state.awaiting = next.expect;
    } else {
      await ctx.reply('Готово.');
      stopJob(chatId);
    }
    return;
  }

  if (step.expect.type === 'free_text') {
    const tgContact = (incoming || '').trim();

    // Save processed lead to Google Sheets (best-effort)
    try {
      if (tgContact) {
        const ts = new Date().toISOString();
        const clientName = state.vars?.client_name ?? '';
        const myName = state.vars?.my_name ?? 'Никита';
        await sheetUpsertProcessedLead({
          ts,
          clientName,
          tgContact,
          chatId,
          status: 'processed',
          manager: myName
        });
      }
    } catch (e) {
      console.error('sheet append failed', e);
      // do not block the script
    }

    const nextId = step.expect.next;
    state.stepId = nextId;
    state.awaiting = null;

    const next = findStep(nextId);
    if (!next) {
      await ctx.reply('Следующий шаг не найден.');
      stopJob(chatId);
      return;
    }

    await runStepMessages(chatId, ctx, next, state.vars, state.delayCfg);
    await ctx.reply('Готово.');
    stopJob(chatId);
  }
});

bot.launch();

// Render health check
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(port, () => console.log(`health server on ${port}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
