import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function failureAnnotations(output) {
  const blocks = String(output).match(/(?:^|\n)not ok[^]*?(?=\n# Subtest:|\n1\.\.|$)/g) || [];
  return blocks.map(block => {
    const location = /test[\\/]+([a-z0-9-]+\.test\.js):(\d+):\d+/i.exec(block);
    const code = /^\s+code: '?([A-Z_0-9]+)'?\s*$/m.exec(block)?.[1] || 'TEST_FAILURE';
    // Never publish arbitrary assertion messages, actual/expected values,
    // test names, stack contents, credentials, or synthetic capability canaries.
    const file = location ? `test/${location[1]}` : 'package.json';
    const line = location ? Number(location[2]) : 1;
    return `::error file=${file},line=${line},title=JavaScript test failed::${code}; inspect this regression locally.`;
  });
}

function main() {
  const command = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;
  if (!command.startsWith('node --test ')) throw new Error('Unsupported test command.');
  const args = command.slice('node '.length).split(' ');
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const output = String(result.stdout || '') + String(result.stderr || '');
  const summary = output.split(/\r?\n/).filter(line => /^# (tests|pass|fail|cancelled|skipped|duration_ms) /.test(line));
  process.stdout.write(summary.join('\n') + '\n');
  if (result.status !== 0) {
    const annotations = failureAnnotations(output);
    process.stdout.write((annotations.length ? annotations : ['::error title=JavaScript suite failed::Runner failure; raw diagnostic values suppressed.']).join('\n') + '\n');
    process.exitCode = result.status || 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
