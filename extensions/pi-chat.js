import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export default function (pi) {
  let child;
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    if (!child) return;
    const owned = child;
    stopping = new Promise(resolve => {
      const timer = setTimeout(() => owned.kill('SIGKILL'), 6000);
      owned.once('exit', () => { clearTimeout(timer); resolve(); });
      owned.kill('SIGTERM');
    });
    await stopping;
    if (child === owned) child = undefined;
    stopping = undefined;
  }
  pi.registerCommand('pi-chat', {
    description: 'Start the local browser UI; /pi-chat stop shuts it down',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('Run /pi-chat from the Pi terminal UI.', 'warning');
        return;
      }
      const action = args.trim();
      if (action === 'stop') { await stop(); ctx.ui.notify('Pi Chat stopped.', 'info'); return; }
      if (action) { ctx.ui.notify('Usage: /pi-chat or /pi-chat stop', 'warning'); return; }
      if (child) { ctx.ui.notify('Pi Chat is already starting or running.', 'info'); return; }
      const port = Number(process.env.PI_CHAT_PORT || 8791);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PI_CHAT_PORT must be 1024–65535');
      const key = createHash('sha256').update(ctx.cwd).digest('hex').slice(0, 16);
      const state = process.env.PI_CHAT_STATE_DIR || path.join(homedir(), '.pi', 'pi-chat', key);
      mkdirSync(state, { recursive: true });
      const log = path.join(state, 'server.log');
      const fd = openSync(log, 'a', 0o600);
      const owned = spawn(process.execPath, [fileURLToPath(new URL('../bin/pi-chat.js', import.meta.url))], {
        cwd: ctx.cwd,
        env: { ...process.env, PI_CHAT_CWD: ctx.cwd, PI_CHAT_STATE_DIR: state },
        stdio: ['ignore', fd, fd],
      });
      closeSync(fd);
      child = owned;
      owned.on('error', e => { if (child === owned) child = undefined; ctx.ui.notify(e.message, 'error'); });
      owned.on('exit', () => { if (child === owned) child = undefined; });
      ctx.ui.notify(`Starting Pi Chat: http://localhost:${port}\nLog: ${log}\nSeparate browser session. Exit Pi or use /pi-chat stop to stop the server.`, 'info');
    },
  });
  pi.on('session_shutdown', stop);
}
