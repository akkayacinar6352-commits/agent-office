import type http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Floor } from '../floor.js';
import type { Ctx } from '../office/context.js';
import { str } from '../office/input.js';
import { readBody, send } from '../http/util.js';

/**
 * The holding's own way into the office: a service on this machine (the Telegram bridge, the
 * scheduler, the limit watcher) that isn't a worker, so has no worker token. It reads the token
 * from `<data dir>/holding-token` instead. GET lists every floor with its workers and queue; POST
 * /queue adds a task to a floor's queue, /tell types a prompt to a worker, /break starts or ends a
 * break (no new hires or queue tasks while it lasts).
 */
export function holdingToken(dataDir: string): string {
  const file = path.join(dataDir, 'holding-token');
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // first start
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A floor by its id, its repo (`owner/name`) or just the repo's name. */
function findFloor(ctx: Ctx, key: string): Floor | undefined {
  const k = key.toLowerCase();
  for (const f of ctx.floors.values()) {
    const repo = f.def.repo?.toLowerCase();
    if (f.id === key || repo === k || repo?.split('/').pop() === k || f.def.name.toLowerCase() === k) return f;
  }
  return undefined;
}

function floorView(f: Floor) {
  const q = f.queue.state();
  return {
    id: f.id,
    name: f.def.name,
    repo: f.def.repo,
    queue: { maxWorkers: q.maxWorkers, tasks: q.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, worker: t.workerName, pr: t.pr, error: t.error })) },
    workers: f.workers.list().map((w) => ({ id: w.id, name: w.name, kind: w.kind, status: w.status, desk: w.deskId, task: w.task?.name, activity: w.activity, model: w.model })),
  };
}

export async function officeHolding(ctx: Ctx, token: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!sameToken(given, token)) return send(res, 401, { error: 'Send the token in .agent-office/holding-token as the bearer token' });
  const action = url.pathname.slice('/holding'.length);
  if (req.method === 'GET' && !action) {
    return send(res, 200, { office: ctx.officeName, break: ctx.ledger.onBreak ?? null, floors: [...ctx.floors.values()].map(floorView) });
  }
  if (req.method !== 'POST' || !['/queue', '/tell', '/break'].includes(action)) return send(res, 405, { error: 'GET /holding, or POST to /holding/queue, /holding/tell or /holding/break' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) ?? {};
  } catch {
    return send(res, 400, { error: 'Send JSON' });
  }
  if (action === '/break') {
    const reason = str(body.reason, 300) || undefined;
    if (reason === ctx.ledger.onBreak) return send(res, 200, { ok: true, break: reason ?? null });
    ctx.ledger.onBreak = reason;
    ctx.toastAll(reason ? `☕ Break: ${reason}` : '▶️ The break is over — back to work', reason ? 'warn' : 'info');
    if (!reason) ctx.pumpQueues();
    return send(res, 200, { ok: true, break: reason ?? null });
  }
  if (action === '/tell') {
    const id = str(body.worker, 100);
    const floor = ctx.workerFloor(id);
    if (!floor) return send(res, 404, { error: 'No such worker' });
    const err = floor.workers.prompt(id, str(body.text, 20000), str(body.by, 100) || 'Holding');
    return err ? send(res, 400, { error: err }) : send(res, 200, { ok: true });
  }
  const floor = findFloor(ctx, str(body.floor, 200));
  if (!floor) return send(res, 404, { error: 'No such floor' });
  const by = str(body.by, 100) || 'Holding';
  const err = floor.queue.add(str(body.prompt, 20000), by, str(body.title, 200) || undefined, undefined, undefined, str(body.model, 40) || undefined);
  if (err) return send(res, 400, { error: err });
  const task = floor.queue.state().tasks.at(-1)!;
  ctx.toastFloor(floor, `📋 ${by} queued “${task.title}”`);
  send(res, 200, { ok: true, task: { id: task.id, title: task.title, status: task.status } });
}
