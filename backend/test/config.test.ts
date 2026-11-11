import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, parsePortNames } from '../src/config.js';

test('parseList', () => {
  assert.deepEqual(parseList(' a, b ,,c '), ['a', 'b', 'c']);
  assert.deepEqual(parseList(undefined), []);
});

test('parsePortNames', () => {
  assert.deepEqual(parsePortNames('22:ssh, 25565:minecraft, bad, 99:'), { 22: 'ssh', 25565: 'minecraft' });
});
