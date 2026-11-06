#!/usr/bin/env node
/** The `cookiemunch` executable: real I/O around run() (see cli.ts). */

import { access, constants, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

/** Files under `dir`, relative to it, never entering a directory `skip` names. */
async function listFiles(dir: string, skip: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(rel ? `${dir}/${rel}` : dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip(e.name)) await walk(path); } else if (e.isFile()) out.push(path);
    }
  };
  await walk('');
  return out;
}

run(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, d, mode) => writeFile(p, d, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) }),
  // Throws what the write itself would: EISDIR, ENOENT, EACCES.
  checkWritable: async (p) => {
    const found = await stat(p).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (found?.isDirectory()) throw new Error(`${p} is a directory`);
    await access(found ? p : dirname(p), found ? constants.R_OK | constants.W_OK : constants.W_OK);
  },
  openUrl,
  listFiles,
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
