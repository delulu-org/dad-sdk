#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSourceManifest } from './manifest.js';
import { runInit } from './cli/init.js';
import { runDev } from './cli/dev.js';
import { runTest } from './cli/probe.js';

async function runValidate(targetDir: string = process.cwd()) {
  const manifestPath = path.join(targetDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(` Error: manifest.json not found in ${targetDir}`);
    process.exit(1);
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const result = validateSourceManifest(raw);
    if (result.valid) {
      console.log(` manifest.json is valid!`);
    } else {
      console.error(` Validation errors:`);
      for (const err of result.errors) {
        console.error(`   - ${err}`);
      }
      process.exit(1);
    }
  } catch (e: any) {
    console.error(` Invalid JSON: ${e.message}`);
    process.exit(1);
  }
}

/** Parses `--flag value` / `--flag=value` pairs out of an argv-like array (positional args already stripped). */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[arg.slice(2)] = next;
        i++;
      } else {
        flags[arg.slice(2)] = 'true';
      }
    }
  }
  return flags;
}

/** Positional (non-flag) args, in order. */
function parsePositional(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const rest = args.slice(1);
  const flags = parseFlags(rest);
  const positional = parsePositional(rest);

  switch (command) {
    case 'validate':
      await runValidate(positional[0] ? path.resolve(positional[0]) : process.cwd());
      break;
    case 'init':
      await runInit(positional[0], { id: flags.id, name: flags.name });
      break;
    case 'dev':
      await runDev(positional[0] ? path.resolve(positional[0]) : process.cwd(), {
        port: flags.port ? Number(flags.port) : undefined,
      });
      break;
    case 'test':
      if (!positional[0]) {
        console.error(` Error: 'dad test' requires a manifest.json URL.`);
        console.error(` Usage: dad test https://your-addon.example.com/manifest.json [--key <api-key>]`);
        process.exitCode = 1;
        break;
      }
      // --key wins if given explicitly; DAD_TEST_API_KEY is the safer
      // default for CI/shell use (argv shows up in `ps`/shell history/logs;
      // an env var doesn't).
      await runTest(positional[0], flags.key ?? process.env.DAD_TEST_API_KEY);
      break;
    case 'help':
    default:
      console.log(`
Delulu Addon Development (DAD) CLI

DAD supports HTTP addons only - a server you host and control.

Getting started:
  dad init <dir> [--id <reverse.dns.id>] [--name "Display Name"]
                        Scaffold a new HTTP addon

Developing:
  dad dev [dir]          Start a real local HTTP server for your addon and print
                         ready-to-run curl commands for every declared capability.
                         [--port <n>]  Port to listen on (default 7890)

Testing a live addon:
  dad test <manifest-url>  Validate a DEPLOYED addon from its public manifest:
                         fetches {baseUrl}/manifest.json and probes every declared
                         capability using public-domain fixtures (Big Buck Bunny,
                         Sintel, ...) - the exact request shapes Delulu Core sends.
                         [--key <api-key>]  Test the AUTHENTICATED path - sends
                         Authorization: Bearer <api-key> on every probe. Without
                         it, only the graceful-rejection path is tested (no key
                         given -> unauthorized is expected and passes; WITH --key,
                         an unauthorized response means the key gate is broken).
                         (or set DAD_TEST_API_KEY - safer for CI/shell history)

Shipping:
  dad validate [dir]     Validate manifest.json schema

  dad help                Show this help message
`);
      break;
  }
}

// Only run the CLI when executed directly - importing this module in tests
// must not trigger `main()`.
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
const thisFile = fileURLToPath(import.meta.url);
if (executedFile === thisFile) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}