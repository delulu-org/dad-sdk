import fs from 'node:fs';
import path from 'node:path';
import { httpAddonTemplate } from './templates.js';

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

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

  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(targetDir, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');
  }

  const displayPath = path.relative(process.cwd(), targetDir) || '.';
  console.log(`\n Created http addon '${name}' in ./${displayPath}\n`);
  console.log(` Addon id:   ${id}`);
  console.log(` Next steps:`);
  console.log(`   cd ${dirName}`);
  console.log(`   npm install`);
  console.log(`   npm run build`);
  console.log(`   npx dad dev`);
  console.log('');
  console.log(` When ready: deploy src/index.ts's 'handler' export, update manifest.json's baseUrl, then list it in the catalog.`);
  console.log('');
}
