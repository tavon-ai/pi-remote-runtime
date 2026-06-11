#!/usr/bin/env node

const http = require('node:http');
const { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { homedir, hostname } = require('node:os');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
const runtimeArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
const commandArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);

function option(name, fallback) {
  const index = runtimeArgs.indexOf(name);
  if (index !== -1 && runtimeArgs[index + 1]) return runtimeArgs[index + 1];
  const prefixed = runtimeArgs.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

const host = option('--host', process.env.HOST || '0.0.0.0');
const port = Number(option('--port', process.env.PORT || '7777'));
const bridgePort = Number(option('--bridge-port', process.env.PI_BRIDGE_PORT || '7788'));
const token = process.env.PI_REMOTE_TOKEN;

let child;
let childReady = false;
let lastExit = null;
let restartTimer = null;
let restartDelayMs = 1000;
let shuttingDown = false;

function shellSplit(value) {
  const result = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (current) result.push(current);
  return result;
}

function bridgeExtraArgs() {
  const raw = process.env.PI_REMOTE_RUNTIME_ARGS || process.env.PI_CLI_ARGS || process.env.PI_ARGS || '';
  return raw.trim() ? shellSplit(raw) : [];
}

function bridgeCommand() {
  if (commandArgs.length) {
    const [cmd, ...cmdArgs] = commandArgs;
    if (/(^|\/)pi-bridge$/.test(cmd)) return [cmd, ...cmdArgs, ...bridgeExtraArgs()];
    return [cmd, ...cmdArgs];
  }
  return ['pi-bridge', '--host', '127.0.0.1', '--port', String(bridgePort), ...bridgeExtraArgs()];
}

function authJsonBase64() {
  return process.env.PI_AGENT_AUTH_JSON_BASE64 || process.env.PI_AUTH_JSON_BASE64 || process.env.PI_REMOTE_AUTH_JSON_BASE64 || '';
}

function preparePiAuth() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || '/workspace/.pi-agent';
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const encoded = authJsonBase64().trim();
  if (!encoded) return;

  const authPath = join(agentDir, 'auth.json');
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');

  // Validate before writing so an invalid secret fails loudly instead of making
  // Pi report a misleading missing-provider error.
  JSON.parse(decoded);

  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(authPath, decoded, { encoding: 'utf8', mode: 0o600 });
  chmodSync(agentDir, 0o700);
  chmodSync(authPath, 0o600);
}

function startBridge() {
  if (child || shuttingDown) return;
  preparePiAuth();
  const [cmd, ...cmdArgs] = bridgeCommand();
  console.log(`starting pi bridge: ${[cmd, ...cmdArgs].join(' ')}`);
  child = spawn(cmd, cmdArgs, {
    cwd: process.env.WORKSPACE_DIR || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  childReady = true;
  child.on('error', (error) => {
    console.error(`pi bridge failed to start: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    lastExit = { code, signal, at: new Date().toISOString() };
    childReady = false;
    child = undefined;
    if (shuttingDown) return;
    console.error(`pi bridge exited (code=${code} signal=${signal}); restarting in ${restartDelayMs}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startBridge();
    }, restartDelayMs);
    restartDelayMs = Math.min(restartDelayMs * 2, 30_000);
  });
  // Reset backoff once the bridge stays up for a while.
  setTimeout(() => {
    if (childReady) restartDelayMs = 1000;
  }, 60_000).unref();
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

function sessionRoots() {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return [process.env.PI_CODING_AGENT_SESSION_DIR];
  const roots = [defaultSessionDir(process.env.WORKSPACE_DIR || process.cwd()), join(process.env.HOME || homedir(), '.pi', 'agent', 'sessions')];
  // PI_CODING_AGENT_DIR moves the whole agent dir (including sessions);
  // pi-bridge writes its chat session files there.
  if (process.env.PI_CODING_AGENT_DIR) roots.push(join(process.env.PI_CODING_AGENT_DIR, 'sessions'));
  return roots;
}

function collectSessionFiles(root, recursive = false) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory() && recursive) return collectSessionFiles(path, true);
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
  });
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

async function listSessionsWithDiagnostics() {
  const roots = sessionRoots();
  const [cwdRoot, ...recursiveRoots] = roots;
  const files = [...new Set([
    ...collectSessionFiles(cwdRoot),
    ...recursiveRoots.flatMap((root) => collectSessionFiles(root, true)),
  ])];
  const sessions = (await Promise.all(files.map((file) => buildSessionInfo(file).catch(() => null)))).filter(Boolean);
  sessions.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  return {
    sessions,
    diagnostics: {
      pid: process.pid,
      hostname: hostname(),
      cwd: process.cwd(),
      workspaceDir: process.env.WORKSPACE_DIR || null,
      home: process.env.HOME || homedir(),
      piSessionDirEnv: process.env.PI_CODING_AGENT_SESSION_DIR || null,
      roots,
      files,
      childReady,
      lastExit,
      piCodingAgentDir: process.env.PI_CODING_AGENT_DIR || null,
      authJsonConfigured: Boolean(authJsonBase64().trim()),
      bridgeCommand: bridgeCommand(),
      bridgePort,
    },
  };
}

// Streams the request to the local bridge and the response back, propagating
// client aborts so the bridge can cancel the underlying Pi prompt.
function proxyToBridge(req, res) {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: bridgePort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${bridgePort}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const unavailable = error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET';
    res.writeHead(unavailable ? 503 : 502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: unavailable ? 'bridge_unavailable' : 'bridge_error', detail: error.message }));
  });

  res.on('close', () => {
    upstream.destroy();
  });

  req.pipe(upstream);
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
      const payload = await listSessionsWithDiagnostics();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(url.searchParams.get('debug') === '1' ? payload : { sessions: payload.sessions }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'failed_to_list_sessions' }));
    }
    return;
  }

  proxyToBridge(req, res);
});

function shutdown(signal) {
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child) child.kill(signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startBridge();
server.listen(port, host, () => {
  console.log(`pi-remote-runtime listening on ${host}:${port} (bridge on 127.0.0.1:${bridgePort})`);
});
