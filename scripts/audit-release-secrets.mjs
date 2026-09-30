#!/usr/bin/env node

'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const maximumTextBytes = 8 * 1024 * 1024;
const forbiddenArtifactExtensions = new Set([
  '.cer', '.crt', '.db', '.key', '.p12', '.pem', '.pfx', '.sqlite', '.sqlite3',
]);
const rules = [
  {
    name: 'Roblox authentication cookie',
    pattern: new RegExp(['_\\|WARNING:', '-DO-NOT-SHARE-', 'THIS'].join(''), 'i'),
  },
  {
    name: 'PEM private key',
    pattern: new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH |DSA )?', 'PRIVATE KEY-----'].join('')),
  },
  {
    name: 'GitHub access token',
    pattern: new RegExp(['(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_', '[A-Za-z0-9_]{20,255})'].join('')),
  },
  {
    name: 'AWS access key',
    pattern: new RegExp(['(?:AKIA|ASIA)', '[A-Z0-9]{16}'].join('')),
  },
  {
    name: 'OpenAI-style API key',
    pattern: new RegExp(['sk-', '[A-Za-z0-9_-]{32,}'].join('')),
  },
  {
    name: 'Slack token',
    pattern: new RegExp(['xox', '[aboprs]-[A-Za-z0-9-]{20,}'].join('')),
  },
  {
    name: 'Personal Windows profile path',
    pattern: new RegExp(['[A-Za-z]:\\\\Users\\\\', '(?!Public(?:\\\\|$)|Default(?: User)?(?:\\\\|$)|All Users(?:\\\\|$))', '[^\\\\/\\r\\n]+'].join(''), 'i'),
  },
];

function relative(file) {
  const result = path.relative(root, file).split(path.sep).join('/');
  if (!result || result === '..' || result.startsWith('../')) {
    throw new Error(`Audit target escaped the repository: ${file}`);
  }
  return result;
}

function collectDirectory(directory, output) {
  const resolved = path.resolve(root, directory);
  relative(resolved);
  if (!fs.existsSync(resolved)) throw new Error(`Audit target does not exist: ${directory}`);
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    const file = path.join(resolved, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Audit target contains a link: ${relative(file)}`);
    if (entry.isDirectory()) collectDirectory(relative(file), output);
    else if (entry.isFile()) output.add(file);
    else throw new Error(`Audit target contains an unsupported entry: ${relative(file)}`);
  }
}

function trackedAndUntrackedFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return output.toString('utf8').split('\0').filter(Boolean).map(file => path.resolve(root, file));
}

function lineNumber(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

const files = new Set(trackedAndUntrackedFiles());
for (const directory of process.argv.slice(2)) collectDirectory(directory, files);
const findings = [];

for (const file of [...files].sort()) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) continue;
  const filePath = relative(file);
  const extension = path.extname(file).toLowerCase();
  if (forbiddenArtifactExtensions.has(extension)) {
    findings.push({ file: filePath, line: 0, rule: 'Forbidden credential or local-data artifact type' });
  }
  if (stat.size === 0 || stat.size > maximumTextBytes) continue;
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (match) findings.push({ file: filePath, line: lineNumber(text, match.index), rule: rule.name });
  }
  if (/^\.env(?:\.|$)/i.test(path.basename(file)) && !/\.example$/i.test(file)) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const assignment = /^\s*([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|COOKIE|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/i.exec(lines[index]);
      if (assignment && assignment[2] && !/^['"]?['"]?$/.test(assignment[2])) {
        findings.push({ file: filePath, line: index + 1, rule: 'Populated environment credential' });
      }
    }
  }
}

if (findings.length) {
  const locations = findings.map(finding => `${finding.file}:${finding.line || '-'} [${finding.rule}]`).join('\n');
  throw new Error(`Sensitive-material audit failed. Values are intentionally suppressed.\n${locations}`);
}

process.stdout.write(`Sensitive-material audit passed for ${files.size} files; no raw values were emitted.\n`);
