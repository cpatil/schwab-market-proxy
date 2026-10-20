import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('defaults to loopback only', () => {
  const c = loadConfig({});
  assert.equal(c.bindHost, '127.0.0.1');
  assert.deepEqual(c.allowedHosts, []);
});

test('parses BIND_HOST and ALLOWED_HOSTS', () => {
  const c = loadConfig({ BIND_HOST: '0.0.0.0', ALLOWED_HOSTS: ' 192.168.1.50, MyServer.local ,myserver ' });
  assert.equal(c.bindHost, '0.0.0.0');
  assert.deepEqual(c.allowedHosts, ['192.168.1.50', 'myserver.local', 'myserver']);
});

test('rejects ALLOWED_HOSTS entries with ports or schemes', () => {
  assert.throws(() => loadConfig({ ALLOWED_HOSTS: 'myserver:8787' }), /without port/);
  assert.throws(() => loadConfig({ ALLOWED_HOSTS: 'http://myserver' }), /without port/);
});
