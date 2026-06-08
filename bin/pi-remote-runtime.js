#!/usr/bin/env node

const http = require('node:http');
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

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pi: childReady, lastExit }));
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
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
