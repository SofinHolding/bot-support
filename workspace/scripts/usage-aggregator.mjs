#!/usr/bin/env node
import { readdir, appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const ROOT = resolve(args.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const SESSIONS_DIR = resolve(args.sessions ?? join(ROOT, 'agents', 'main', 'sessions'));
const OUTPUT = resolve(args.output ?? join(ROOT, 'workspace', 'reports', 'usage-daily.jsonl'));
const USER_INDEX = resolve(args['user-index'] ?? join(ROOT, 'workspace', 'reports', 'user-index.json'));
const SUMMARY = resolve(args.summary ?? join(ROOT, 'workspace', 'reports', 'usage-summary.json'));
const DRY = !!args['dry-run'];

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

await main();

async function main() {
  if (!existsSync(SESSIONS_DIR)) {
    console.error(`[usage-aggregator] sessions dir not found: ${SESSIONS_DIR}`);
    process.exit(1);
  }
  await mkdir(dirname(OUTPUT), { recursive: true });

  const seen = await loadSeenMessageIds(OUTPUT);
  const userIndex = await loadUserIndex(USER_INDEX);
  const entries = await readdir(SESSIONS_DIR);
  const sessionFiles = entries.filter(f => f.endsWith('.jsonl') || f.includes('.jsonl.reset.'));

  const newRecords = [];
  let processedSessions = 0;
  let skippedExisting = 0;

  const STATE_PATH = resolve(args['state'] ?? join(ROOT, 'workspace', 'reports', 'aggregator-state.json'));
  const lastRunState = await loadState(STATE_PATH);
  const lastRunMs = lastRunState?.lastRunMs ?? 0;
  const currentRunMs = Date.now();
  let skippedUnchanged = 0;

  for (const file of sessionFiles) {
    const full = join(SESSIONS_DIR, file);
    const sessionId = file.replace(/\.jsonl(\.reset\.[^.]+)?$/, '');

    let mtimeMs;
    try {
      const st = await stat(full);
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs <= lastRunMs) {
      skippedUnchanged++;
      continue;
    }

    const { records, userSightings, lastReplies } = await extractFromSession(full, sessionId);
    processedSessions++;

    for (const sighting of userSightings) {
      mergeUserIndex(userIndex, sighting);
    }
    for (const reply of lastReplies) {
      mergeLastReply(userIndex, reply);
    }

    for (const r of records) {
      if (seen.has(r.messageId)) {
        skippedExisting++;
        continue;
      }
      seen.add(r.messageId);
      newRecords.push(r);
    }
  }

  if (!DRY) {
    await writeFile(STATE_PATH, JSON.stringify({ lastRunMs: currentRunMs }, null, 2) + '\n', 'utf8');
  }

  if (!DRY) {
    if (newRecords.length > 0) {
      const lines = newRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
      await appendFile(OUTPUT, lines, 'utf8');
    }
    await writeFile(USER_INDEX, JSON.stringify(userIndex, null, 2) + '\n', 'utf8');
  }

  const summaryReport = await buildSummary(OUTPUT, userIndex);
  if (!DRY) {
    await writeFile(SUMMARY, JSON.stringify(summaryReport, null, 2) + '\n', 'utf8');
  }

  console.log(JSON.stringify({
    sessionsScanned: processedSessions,
    sessionsSkippedUnchanged: skippedUnchanged,
    newRecords: newRecords.length,
    skippedExisting,
    usersIndexed: Object.keys(userIndex).length,
    totalRecordsInJsonl: summaryReport.totals.requests,
    totalTokens: summaryReport.totals.totalTokens,
    dayCount: Object.keys(summaryReport.perDate).length,
    topUserCount: summaryReport.topUsers.length,
    outputPath: OUTPUT,
    userIndexPath: USER_INDEX,
    summaryPath: SUMMARY,
    dryRun: DRY,
  }, null, 2));
}

async function loadSeenMessageIds(path) {
  const set = new Set();
  if (!existsSync(path)) return set;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.messageId) set.add(r.messageId);
    } catch {
      // ignore malformed
    }
  }
  return set;
}

async function loadState(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function loadUserIndex(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

async function extractFromSession(path, sessionId) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  const records = [];
  const userSightings = [];
  const lastReplies = []; // {userId, text, at}
  let currentUserId = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'message' || !ev.message) continue;

    const ts = ev.timestamp ?? (typeof ev.message.timestamp === 'number' ? new Date(ev.message.timestamp).toISOString() : null);

    if (ev.message.role === 'user') {
      const info = extractSenderInfo(ev.message.content);
      if (info?.id) {
        currentUserId = info.id;
        if (ts) userSightings.push({ ...info, seenAt: ts });
      }
      continue;
    }

    if (ev.message.role !== 'assistant') continue;

    if (currentUserId && ts) {
      const replyText = extractAssistantText(ev.message.content);
      if (replyText) lastReplies.push({ userId: currentUserId, text: replyText, at: ts });
    }

    const usage = ev.message.usage;
    if (!usage) continue;
    if (!ts) continue;

    records.push({
      date: bangkokDate(ts),
      messageId: ev.id,
      sessionId,
      userId: currentUserId,
      model: ev.message.model ?? null,
      provider: ev.message.provider ?? null,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cost: usage.cost?.total ?? 0,
      timestamp: ts,
    });
  }
  return { records, userSightings, lastReplies };
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return null;
  const texts = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      // Strip [[reply_to_current]] / [[reply_to:id]] prefixes added by openclaw
      let t = part.text.replace(/^\[\[reply_to(_current|:[^\]]+)\]\]\s*/g, '').trim();
      if (t) texts.push(t);
    }
  }
  if (texts.length === 0) return null;
  return texts.join('\n');
}

function extractSenderInfo(content) {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const idMatch = part.text.match(/"sender_id"\s*:\s*"(\d+)"/);
    if (!idMatch) continue;
    const nameMatch = part.text.match(/"name"\s*:\s*"([^"]+)"/);
    const usernameMatch = part.text.match(/"username"\s*:\s*"([^"]+)"/);
    const senderMatch = part.text.match(/"sender"\s*:\s*"([^"]+)"/);
    return {
      id: idMatch[1],
      name: nameMatch?.[1] ?? senderMatch?.[1] ?? null,
      username: usernameMatch?.[1] ?? null,
    };
  }
  return null;
}

function mergeLastReply(idx, reply) {
  const { userId, text, at } = reply;
  const entry = idx[userId] ?? { firstSeen: at, lastSeen: at, seenCount: 0 };
  if (!entry.lastBotReplyAt || at > entry.lastBotReplyAt) {
    entry.lastBotReplyAt = at;
    entry.lastBotReply = text.length > 500 ? text.slice(0, 500) + '…' : text;
  }
  idx[userId] = entry;
}

function mergeUserIndex(idx, sighting) {
  const { id, name, username, seenAt } = sighting;
  const entry = idx[id] ?? { firstSeen: seenAt, lastSeen: seenAt, seenCount: 0 };
  entry.seenCount = (entry.seenCount ?? 0) + 1;
  if (!entry.firstSeen || seenAt < entry.firstSeen) entry.firstSeen = seenAt;
  if (!entry.lastSeen || seenAt > entry.lastSeen) entry.lastSeen = seenAt;
  if (seenAt >= entry.lastSeen || !entry.name) {
    if (name) entry.name = name;
    if (username) entry.username = username;
  }
  idx[id] = entry;
}

function bangkokDate(isoTs) {
  const d = new Date(isoTs);
  const shifted = new Date(d.getTime() + BANGKOK_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function bangkokHour(isoTs) {
  const d = new Date(isoTs);
  const shifted = new Date(d.getTime() + BANGKOK_OFFSET_MS);
  return shifted.toISOString().slice(11, 13);
}

async function buildSummary(jsonlPath, userIndex) {
  const perDate = new Map();
  const perUser = new Map();
  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  const allUsers = new Set();
  let latestTs = null;

  if (existsSync(jsonlPath)) {
    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }

      totals.requests += 1;
      totals.input += r.input ?? 0;
      totals.output += r.output ?? 0;
      totals.cacheRead += r.cacheRead ?? 0;
      totals.cacheWrite += r.cacheWrite ?? 0;
      totals.totalTokens += r.totalTokens ?? 0;
      totals.cost += r.cost ?? 0;
      if (r.userId) allUsers.add(r.userId);
      if (!latestTs || r.timestamp > latestTs) latestTs = r.timestamp;

      const date = r.date;
      let day = perDate.get(date);
      if (!day) {
        day = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, users: new Set(), hourly: {} };
        perDate.set(date, day);
      }
      day.requests += 1;
      day.input += r.input ?? 0;
      day.output += r.output ?? 0;
      day.cacheRead += r.cacheRead ?? 0;
      day.cacheWrite += r.cacheWrite ?? 0;
      day.totalTokens += r.totalTokens ?? 0;
      day.cost += r.cost ?? 0;
      if (r.userId) day.users.add(r.userId);

      if (r.timestamp) {
        const hour = bangkokHour(r.timestamp);
        let hr = day.hourly[hour];
        if (!hr) { hr = { requests: 0, totalTokens: 0 }; day.hourly[hour] = hr; }
        hr.requests += 1;
        hr.totalTokens += r.totalTokens ?? 0;
      }

      if (r.userId) {
        let u = perUser.get(r.userId);
        if (!u) { u = { userId: r.userId, requests: 0, totalTokens: 0 }; perUser.set(r.userId, u); }
        u.requests += 1;
        u.totalTokens += r.totalTokens ?? 0;
      }
    }
  }

  const perDateObj = {};
  for (const [date, day] of [...perDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const { users, hourly, ...rest } = day;
    const hourlySorted = Object.fromEntries(
      Object.entries(hourly).sort(([a], [b]) => a.localeCompare(b)),
    );
    perDateObj[date] = { ...rest, uniqueUsers: users.size, hourly: hourlySorted };
  }

  const topUsers = [...perUser.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 20)
    .map(u => ({
      ...u,
      name: userIndex[u.userId]?.name ?? null,
      username: userIndex[u.userId]?.username ?? null,
    }));

  const dates = Object.keys(perDateObj);
  return {
    generatedAt: new Date().toISOString(),
    latestRecordAt: latestTs,
    dateRange: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1], count: dates.length } : null,
    totals: { ...totals, uniqueUsers: allUsers.size },
    perDate: perDateObj,
    topUsers,
  };
}

function bump(_map, _date, _rec) {
  // deprecated helper kept for compatibility; no-op now that summary build handles aggregation
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next; i++;
  }
  return out;
}
