#!/usr/bin/env node
import { register } from 'tsx/esm/api';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
if (process.argv.includes('--help')) {
  console.log('pi-chat-local: local Pi RPC web client\nEnvironment: PI_CHAT_CWD, PI_CHAT_PORT (8791), PI_CHAT_BIN, PI_CHAT_STATE_DIR');
} else {
  const cwd = path.resolve(process.env.PI_CHAT_CWD || process.cwd());
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  process.env.PI_CHAT_STATE_DIR ||= path.join(homedir(), '.pi', 'pi-chat', key);
  register();
  await import('../server.ts');
}
