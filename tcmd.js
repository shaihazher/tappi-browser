#!/usr/bin/env node
// tcmd.js — Send a command to the Tappi Browser dev server
// Usage: node tcmd.js elements | node tcmd.js click 3 | node tcmd.js B14 https://...
const net = require('net');
const cmd = process.argv.slice(2).join(' ');
if (!cmd) { console.log('Usage: node tcmd.js <command>'); process.exit(1); }
const client = net.createConnection(18900, '127.0.0.1', () => {
  client.write(cmd + '\n');
});
let out = '';
client.on('data', d => out += d);
client.on('end', () => { process.stdout.write(out); process.exit(0); });
client.on('error', e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { process.stdout.write(out || '(timeout)\n'); process.exit(0); }, 10000);
