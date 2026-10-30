import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClaudeInputStream } from '@/modules/providers/list/claude/claude-live-input.provider.js';

test('CLI queue receipt confirms delivery before tool completion; replay confirms consumption', async () => {
  const input = createClaudeInputStream([]);
  const sent = input.send('new constraint');
  const message = (await input.stream.next()).value!;
  assert.equal(message.priority, 'next');
  assert.equal(input.pending, true);
  assert.equal(input.acknowledge({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' }), true);
  await sent;
  assert.equal(input.pending, true, 'an earlier result must not close a queued follow-up');
  input.acknowledge(message);
  assert.equal(input.pending, false);
  assert.equal(input.acknowledge(message), true, 'duplicate replay is swallowed');
  input.release();
  assert.equal((await input.stream.next()).done, true);
  await assert.rejects(input.send('late'), /no longer accepting/);
});

test('unrelated and subagent echoes cannot acknowledge a main-session send', async () => {
  const input = createClaudeInputStream([]);
  const sent = input.send('main only');
  const message = (await input.stream.next()).value!;
  assert.equal(input.acknowledge({ ...message, uuid: 'unrelated' }), false);
  assert.equal(input.acknowledge({ ...message, parent_tool_use_id: 'agent' }), false);
  assert.equal(input.pending, true);
  input.acknowledge(message);
  await sent;
  input.release();
});

test('missing receipt reports uncertain delivery without resending or consuming the message', async () => {
  const input = createClaudeInputStream([], 10);
  const failure = assert.rejects(input.send('only once'), /Delivery is uncertain/);
  await input.stream.next();
  await delay(20);
  await failure;
  assert.equal(input.pending, true);
  input.release();
  assert.equal((await input.stream.next()).done, true);
});

test('closing a stream rejects every unacknowledged send and unblocks its reader', async () => {
  const input = createClaudeInputStream([]);
  const failures = [assert.rejects(input.send('one'), /stopped/), assert.rejects(input.send('two'), /stopped/)];
  input.release();
  await Promise.all(failures);
  assert.equal((await input.stream.next()).done, true);
});
