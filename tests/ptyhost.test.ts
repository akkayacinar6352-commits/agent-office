import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PTY_PROTOCOL, PtyHost, hostSocketPath, readMessages, type Pty } from '../src/server/ptys.js';

test('the host listens on a named pipe on Windows and a socket elsewhere', () => {
  const win = hostSocketPath('C:\\proj\\.agent-office', 'win32');
  assert.match(win, /^\\\\\.\\pipe\\agent-office-[0-9a-f]{16}$/);
  assert.equal(hostSocketPath('C:\\proj\\.agent-office', 'win32'), win, 'same dir, same pipe');
  assert.notEqual(hostSocketPath('C:\\other\\.agent-office', 'win32'), win, 'one pipe per data dir');
  assert.equal(hostSocketPath('/p/.agent-office', 'linux'), path.join('/p/.agent-office', 'pty.sock'));
});

function waitFor(p: Pty, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`never saw ${text}; got ${JSON.stringify(seen.slice(-200))}`)), 15_000);
    p.onData((d) => {
      seen += d;
      if (seen.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** Something listening where the host would, answering hello only from the `answerFrom`-th try on. */
async function fakeHost(dir: string, answerFrom: number): Promise<{ server: net.Server; hellos: () => number }> {
  writeFileSync(path.join(dir, 'pty-host.json'), JSON.stringify({ token: 'the-live-hosts-token' }));
  let hellos = 0;
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    readMessages(sock, (msg) => {
      if (msg.t !== 'hello') return;
      hellos++;
      if (hellos >= answerFrom) sock.write(`${JSON.stringify({ t: 'ready', version: PTY_PROTOCOL, sessions: [] })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(hostSocketPath(dir), r));
  return { server, hellos: () => hellos };
}

test("a host that's there but slow to answer is waited for, never replaced", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-ptyslow-'));
  const { server, hellos } = await fakeHost(dir, 2);
  try {
    const office = new PtyHost(dir, () => {}, 20_000);
    assert.equal(await office.connect(), true, 'it got through on a later try');
    assert.ok(hellos() >= 2);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'pty-host.json'), 'utf8')).token, 'the-live-hosts-token');
    office.detach();
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host that never answers keeps its token: the office runs terminals itself instead", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-ptymute-'));
  const { server } = await fakeHost(dir, Infinity);
  try {
    const office = new PtyHost(dir, () => {}, 1_000);
    assert.equal(await office.connect(), false);
    assert.equal(office.hosted, false);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'pty-host.json'), 'utf8')).token, 'the-live-hosts-token', 'the live host can still be reached next time');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a terminal outlives the office that started it', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-ptyhost-'));
  const shell = process.platform === 'win32' ? { file: 'cmd.exe', args: ['/q', '/k'] } : { file: '/bin/sh', args: [] };
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const first = new PtyHost(dir, () => {});
  let second: PtyHost | undefined;
  try {
    assert.equal(await first.connect(), true, 'a host started');
    const p = first.spawn({ ...shell, cwd: dir, env, cols: 80, rows: 24 });
    assert.ok(p.id, 'the terminal lives in the host');
    p.write('echo before-restart\r');
    await waitFor(p, 'before-restart');

    // The office restarts: it leaves, and a new one finds the same terminal running.
    first.detach();
    second = new PtyHost(dir, () => {});
    assert.equal(await second.connect(), true, 'the new office found the host');
    const adopted = await second.attach(p.id!);
    assert.ok(adopted, 'the terminal was still running');
    assert.match(adopted.snapshot, /before-restart/);
    adopted.pty.write('echo after-restart\r');
    await waitFor(adopted.pty, 'after-restart');
  } finally {
    (second ?? first).stop();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dir, { recursive: true, force: true });
  }
});
