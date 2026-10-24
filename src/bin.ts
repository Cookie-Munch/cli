#!/usr/bin/env node
/** The `cookiemunch` executable: real I/O around run() (see cli.ts). */

import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { run } from './cli.js';

/** A y/N question on the terminal; only offered when both ends are a TTY. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function openUrl(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
      child.on('error', () => {
        process.stderr.write(`Could not open a browser; open the link above yourself.\n`);
        resolve();
      });
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

run(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, d, mode) => writeFile(p, d, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) }),
  openUrl,
  ...(process.stdin.isTTY && process.stderr.isTTY ? { confirm } : {}),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`cookiemunch: ${(err as Error).message ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
