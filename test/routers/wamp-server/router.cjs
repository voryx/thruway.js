#!/usr/bin/env node
'use strict';
// wamp-server 0.0.9 (Node.js, WAMP v2 Basic Profile only; github.com/ivaylopivanov/wamp-server) test router.
//   node router.cjs   (env: WAMP_SERVER_HOME = dir containing node_modules/wamp-server, WAMP_SERVER_PORT,
//                      WAMP_SERVER_REALMS=comma,list (default realm1), DEBUG=wamp:* for frame logs)
// The package's own Server class binds every interface and offers no host option, so this script wires
// the package's SessionManager to a ws server bound to 127.0.0.1 instead (same code path otherwise).
const path = require('node:path');
const { createRequire } = require('node:module');
const home = process.env.WAMP_SERVER_HOME || __dirname;
const req = createRequire(path.join(path.resolve(home), 'package.json'));
const SessionManager = req('wamp-server/release/session-manager').default;
const WebSocket = req('ws');
const version = req('wamp-server/package.json').version;
const wsVersion = req('ws/package.json').version;

const host = process.env.WAMP_SERVER_HOST || '127.0.0.1';
const port = Number(process.env.WAMP_SERVER_PORT || 18295);
const realms = (process.env.WAMP_SERVER_REALMS || 'realm1').split(',');

SessionManager.registerRealms(realms);
const wss = new WebSocket.Server({ host, port });
wss.on('connection', SessionManager.createSession);
wss.on('listening', () =>
  console.error(
    `wamp-server ${version} (ws ${wsVersion}) on node ${process.version}: ws://${host}:${port}/ realms=${realms}`,
  ),
);
process.on('uncaughtException', (e) => console.error('wamp-server uncaughtException:', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => console.error('wamp-server unhandledRejection:', e && e.stack ? e.stack : e));
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    wss.close();
    process.exit(0);
  });
