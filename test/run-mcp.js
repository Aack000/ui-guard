// Simulates a coding agent talking to the ui-guard MCP server over stdio.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const child = spawn(process.execPath, ['bin/ui-guard.js', 'mcp'], {
  env: { ...process.env, UI_GUARD_CHANNEL: process.env.UI_GUARD_CHANNEL || 'chrome' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
const reportPaths = [];
let checks = 0;
let failed = 0;

const timeout = setTimeout(() => {
  console.log('FAIL mcp: overall timeout');
  child.kill();
  process.exit(1);
}, 90000);

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(id, method, params) {
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function check(pass, label, details) {
  checks++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) {
    failed++;
    if (details) console.log(details);
  }
}

const tempDir = mkdtempSync(join(tmpdir(), 'ui-guard-mcp-'));
const tempPopover = join(tempDir, 'popover.html');
writeFileSync(tempPopover, readFileSync(resolve('fixtures', 'broken-popover.html'), 'utf8'));
const popoverUrl = pathToFileURL(tempPopover).href;

try {
  const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-agent', version: '0' } });
  check(init.result?.serverInfo?.name === 'ui-guard', 'initialize handshake', JSON.stringify(init));

  const list = await rpc(2, 'tools/list', {});
  const names = list.result?.tools?.map((t) => t.name) ?? [];
  check(names.includes('ui_scan') && names.includes('ui_verify'), `tools/list exposes ui_scan + ui_verify (got: ${names.join(', ')})`);

  const scanMsg = await rpc(3, 'tools/call', { name: 'ui_scan', arguments: { url: popoverUrl, viewports: [375] } });
  const scanText = scanMsg.result?.content?.[0]?.text ?? '';
  const baseline = scanText.match(/baseline saved: (.+)/)?.[1]?.trim();
  if (baseline) reportPaths.push(baseline);
  check(scanText.includes('H3') && scanText.includes('1 hard errors'), 'ui_scan finds H3 and reports 1 hard error', scanText);
  check(Boolean(baseline) && existsSync(baseline), 'ui_scan returns a real baseline report path', scanText);

  const verifyFail = await rpc(4, 'tools/call', { name: 'ui_verify', arguments: { url: popoverUrl, baseline, viewports: [375] } });
  const failText = verifyFail.result?.content?.[0]?.text ?? '';
  const cur1 = failText.match(/current report: (.+)/)?.[1]?.trim();
  if (cur1) reportPaths.push(cur1);
  check(failText.includes('VERIFY FAIL') && failText.includes('1 persisting'), 'ui_verify flags persisting error as FAIL', failText);

  writeFileSync(tempPopover, readFileSync(resolve('fixtures', 'ok.html'), 'utf8'));
  const verifyPass = await rpc(5, 'tools/call', { name: 'ui_verify', arguments: { url: popoverUrl, baseline, viewports: [375] } });
  const passText = verifyPass.result?.content?.[0]?.text ?? '';
  const cur2 = passText.match(/current report: (.+)/)?.[1]?.trim();
  if (cur2) reportPaths.push(cur2);
  check(passText.includes('VERIFY PASS') && passText.includes('1 fixed'), 'ui_verify passes a fixed page and counts it as fixed', passText);
} finally {
  clearTimeout(timeout);
  child.kill();
  rmSync(tempDir, { recursive: true, force: true });
  for (const p of reportPaths) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
  console.log(`\n${checks - failed}/${checks} mcp checks passed`);
  process.exit(failed ? 1 : 0);
}
