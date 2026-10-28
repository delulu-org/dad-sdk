#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './manifest.js';
import { runInit } from './cli/init.js';
import { runDev } from './cli/dev.js';
import { runTest } from './cli/probe.js';
import { runBundle } from './cli/bundle.js';

async function runValidate(targetDir: string = process.cwd()) {
  const manifestPath = path.join(targetDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(` Error: manifest.json not found in ${targetDir}`);
    process.exit(1);
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const result = validateManifest(raw);
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
      await runInit(positional[0], { id: flags.id, name: flags.name, type: flags.type });
      break;
    case 'dev':
      await runDev(positional[0] ? path.resolve(positional[0]) : process.cwd(), {
        port: flags.port ? Number(flags.port) : undefined,
      });
      break;
    case 'test':
      if (!positional[0]) {
        console.error(` Error: 'dad test' requires a target (manifest URL, manifest.json, or bundle.js).`);
        console.error(` Usage: dad test <manifest-url|manifest.json|bundle.js> [--key <api-key>]`);
        process.exitCode = 1;
        break;
      }
      // --key wins if given explicitly; DAD_TEST_API_KEY is the safer default
      // for CI/shell use (argv shows up in shell history/logs).
      await runTest(positional[0], flags.key ?? process.env.DAD_TEST_API_KEY);
      break;
    case 'bundle':
    case 'build':
      await runBundle(positional[0], {
        out: flags.out,
        manifest: flags.manifest,
        minify: flags.minify === 'true',
      });
      break;
    case 'help':
    default:
      console.log(`
Delulu Addon Development (DAD) CLI

DAD supports HTTP addons (remote web services) and Sandboxed JS addons (QuickJS).

Getting started:
  dad init <dir> [--type <http|js>] [--id <reverse.dns.id>] [--name "Display Name"]
                        Scaffold a new HTTP or Sandboxed JS addon

Developing HTTP addons:
  dad dev [dir]          Start a real local HTTP server for your addon and print
                         ready-to-run curl commands for every declared capability.
                         [--port <n>]  Port to listen on (default 7890)

Bundling JS addons:
  dad bundle [entry]     Compile a TypeScript/JavaScript scraper into a single
                         monolithic bundle.js, compute its SHA-256 hash, and
                         sync manifest.json.
                         [--out <path>]       Output bundle path (default dist/bundle.js)
                         [--manifest <path>]  Path to manifest.json to sync SHA-256
                         [--minify]           Minify the bundle

Testing addons:
  dad test <target>      Validate an addon using public-domain test fixtures.
                         Targets:
                           - Remote manifest URL: https://addon.example.com/manifest.json
                           - Local manifest: ./manifest.json
                           - Local bundle:   ./dist/bundle.js
                         [--key <api-key>]  Test the AUTHENTICATED path with API key
                         (or set DAD_TEST_API_KEY in environment)

Shipping:
  dad validate [dir]     Validate manifest.json schema

  dad help               Show this help message
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