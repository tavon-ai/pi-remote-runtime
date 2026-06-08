#!/usr/bin/env node

const http = require('node:http');
const { createReadStream, existsSync, readdirSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
const runtimeArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
const commandArgs = separatorIndex === -1 ? ['pi', '--mode', 'rpc'] : args.slice(separatorIndex + 1);

function option(name, fallback) {
  const index = runtimeArgs.indexOf(name);
  if (index !== -1 && runtimeArgs[index + 1]) return runtimeArgs[index + 1];
  const prefixed = runtimeArgs.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

const host = option('--host', process.env.HOST || '0.0.0.0');
const port = Number(option('--port', process.env.PORT || '7777'));
const token = process.env.PI_REMOTE_TOKEN;

let child;
let childReady = false;
let lastExit = null;

function startPi() {
  if (child) return child;
  const [cmd, ...cmdArgs] = commandArgs;
  child = spawn(cmd, cmdArgs, {
    cwd: process.env.WORKSPACE_DIR || process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  childReady = true;
  child.on('exit', (code, signal) => {
    lastExit = { code, signal, at: new Date().toISOString() };
    childReady = false;
    child = undefined;
  });
  return child;
}

function authorized(req) {
  if (!token) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${token}`) return true;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return url.searchParams.get('token') === token;
}

function defaultSessionDir(cwd) {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[\/\\]/, '').replace(/[\/\\:]/g, '-')}--`;
  return join(process.env.HOME || homedir(), '.pi', 'agent', 'sessions', safePath);
}

function sessionDir() {
  return process.env.PI_CODING_AGENT_SESSION_DIR || defaultSessionDir(process.env.WORKSPACE_DIR || process.cwd());
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join(' ');
}

async function buildSessionInfo(filePath) {
  const stats = statSync(filePath);
  let header = null;
  let name;
  let messageCount = 0;
  let firstMessage = '';
  let lastActivityTime;

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!header) {
      if (entry.type !== 'session' || typeof entry.id !== 'string') return null;
      header = entry;
      continue;
    }

    if (entry.type === 'session_info') name = entry.name?.trim() || undefined;
    if (entry.type !== 'message') continue;
    messageCount += 1;

    const message = entry.message;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const messageTime = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
    if (!Number.isNaN(messageTime)) lastActivityTime = Math.max(lastActivityTime || 0, messageTime);
    const text = textContent(message.content);
    if (!firstMessage && message.role === 'user' && text) firstMessage = text;
  }

  if (!header) return null;
  const headerTime = Date.parse(header.timestamp);
  const modified = lastActivityTime ? new Date(lastActivityTime) : Number.isNaN(headerTime) ? stats.mtime : new Date(headerTime);
  return {
    id: header.id,
    path: filePath,
    name,
    firstMessage: firstMessage || '(no messages)',
    messageCount,
    created: Number.isNaN(headerTime) ? stats.birthtime.toISOString() : new Date(headerTime).toISOString(),
    modified: modified.toISOString(),
  };
}

async function listSessions() {
  const dir = sessionDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((file) => file.endsWith('.jsonl')).map((file) => join(dir, file));
  const sessions = (await Promise.all(files.map((file) => buildSessionInfo(file).catch(() => null)))).filter(Boolean);
  sessions.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  return sessions;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pi: childReady, lastExit }));
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (url.pathname === '/sessions' && req.method === 'GET') {
    try {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions: await listSessions() }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'failed_to_list_sessions' }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({ server, path: '/rpc' });
wss.on('connection', (socket, req) => {
  if (!authorized(req)) {
    socket.close(1008, 'unauthorized');
    return;
  }

  const pi = startPi();
  const onData = (chunk) => socket.send(chunk.toString());
  pi.stdout.on('data', onData);

  socket.on('message', (message) => {
    if (pi.stdin.writable) pi.stdin.write(message);
    if (pi.stdin.writable) pi.stdin.write('\n');
  });
  socket.on('close', () => pi.stdout.off('data', onData));
});

startPi();
server.listen(port, host, () => {
  console.log(`pi-remote-runtime listening on ${host}:${port}`);
});
