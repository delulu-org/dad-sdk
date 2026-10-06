import fs from 'node:fs';
import path from 'node:path';
import { DAD_CAPABILITIES, DAD_DEFAULT_LOGO_URL } from '../manifest.js';
import { httpAddonTemplate } from './templates.js';

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/**
 * The field guide `dad init` prints. A dev reads this once at scaffold time
 * instead of discovering injected defaults (the logo) or required shapes
 * (capabilities, bare baseUrl) later in the docs - nothing here is a surprise
 * the SDK does behind their back.
 */
function printManifestGuide(manifestJson: string): void {
  const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  const todos = Object.entries(manifest)
    .filter(([, v]) => typeof v === 'string' && v.startsWith('TODO'))
    .map(([k]) => k);

  const rows: [string, string][] = [
    ['id', 'reverse-DNS - do not rename after publishing. org.delulu.* is the team\'s reserved namespace'],
    ['name', 'display name in the client'],
    ['version', 'strict major.minor.patch - the client reads this from YOUR manifest, not the catalog'],
    ['type', "'http' - the only addon type DAD supports"],
    ['description', 'one line for the listing shelf'],
    ['publisher', 'your name or org'],
    ['baseUrl', 'bare HTTPS origin (no path/query/fragment) - your live server; every data request goes here; serve this file at {baseUrl}/manifest.json'],
    ['capabilities', `any of: ${DAD_CAPABILITIES.join(', ')}`],
    ['apiKey', 'optional { required, pageUrl } gate - required:true makes the handler 401 any keyless request'],
    ['logo', `optional HTTPS - omit it and the shared default is injected (${DAD_DEFAULT_LOGO_URL})`],
  ];

  console.log(`\n manifest.json - every field you control:`);
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  for (const [key, help] of rows) {
    console.log(`   ${key.padEnd(labelWidth)}  ${help}`);
  }

  console.log(`\n This file IS the contract: serve it at {baseUrl}/manifest.json.`);
  console.log(` A catalog row only points at it (manifestUrl) - the client fetches, validates, and`);
  console.log(` caches THIS file at install time, then drives every request from baseUrl/capabilities/apiKey.`);

  if (todos.length > 0) {
    console.log(`\n Still TODO in your scaffold: ${todos.join(', ')}`);
  }
}

export async function runInit(
  targetArg: string | undefined,
  opts: { id?: string; name?: string }
): Promise<void> {
  const dirName = targetArg || (opts.name ? opts.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') : undefined);
  if (!dirName) {
    console.error(` Error: give a target directory, e.g. 'dad init my-addon'`);
    process.exit(1);
    return;
  }

  const targetDir = path.resolve(process.cwd(), dirName);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    console.error(` Error: ${targetDir} already exists and is not empty.`);
    process.exit(1);
    return;
  }

  const name = opts.name || dirName;
  const id = opts.id || `org.example.${dirName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (!ID_RE.test(id)) {
    console.error(` Error: '${id}' doesn't look like a reverse-DNS id (e.g. 'org.yourname.${dirName}'). Pass --id explicitly.`);
    process.exit(1);
    return;
  }

  const files = httpAddonTemplate(id, name);
  const manifestJson = files.find((f) => f.path === 'manifest.json')?.content ?? '{}';

  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(targetDir, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');
  }

  const displayPath = path.relative(process.cwd(), targetDir) || '.';
  console.log(`\n Created http addon '${name}' in ./${displayPath}\n`);
  console.log(` Addon id:   ${id}`);

  printManifestGuide(manifestJson);

  console.log(`\n Next steps:`);
  console.log(`   cd ${dirName}`);
  console.log(`   npm install`);
  console.log(`   npm run build`);
  console.log(`   npx dad dev`);
  console.log('');
  console.log(` When ready: deploy src/index.ts's 'handler' export, point manifest.json's baseUrl at it,`);
  console.log(` serve this file at {baseUrl}/manifest.json, then add a catalog row pointing at that URL.`);
  console.log('');
}
