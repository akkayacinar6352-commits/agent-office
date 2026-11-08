import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeBlocked, claudeLimited } from '../src/server/providers/claude.js';

test('a usage limit on screen blocks the worker, with when it resets', () => {
  assert.equal(claudeLimited('> fix the bug\n⎿ Claude usage limit reached. Your limit will reset at 3pm (Europe/Istanbul).\n> '), 'Usage limit reached — resets 3pm (Europe/Istanbul)');
  assert.equal(claudeLimited('● Working…\n5-hour limit reached ∙ resets 11pm\n'), 'Usage limit reached — resets 11pm');
  assert.equal(claudeLimited("You've hit your limit · resets 4:30am (Europe/Istanbul)"), 'Usage limit reached — resets 4:30am (Europe/Istanbul)');
  assert.equal(claudeLimited('Claude usage limit reached'), 'Usage limit reached');
  assert.equal(claudeBlocked('Claude usage limit reached. Your limit will reset at 3pm.', false), 'Usage limit reached — resets 3pm');
});

test('a limit message that has scrolled away, or none at all, does not block', () => {
  assert.equal(claudeLimited('> refactor the parser\n● Done. All tests pass.\n> '), undefined);
  const old = ['Claude usage limit reached. Your limit will reset at 3pm.', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join('\n');
  assert.equal(claudeLimited(old), undefined);
  assert.equal(claudeBlocked('Not logged in · Run /login', false), "Claude isn't signed in on this machine — open the terminal and type /login");
});
