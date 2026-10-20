import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'src/desktop-client');
const output = join(root, 'src/desktop-assets');
const check = process.argv.includes('--check');
const result = await Bun.build({
  entrypoints: [join(source, 'client.ts')], target: 'browser', format: 'esm',
  minify: true, sourcemap: 'none',
});
if (!result.success) throw new Error(result.logs.map(log => log.message).join('\n'));
if (result.outputs.length !== 1) throw new Error('Expected one desktop client bundle.');
const dependency = dirname(fileURLToPath(import.meta.resolve('@novnc/novnc')));
const noVncRoot = dirname(dependency);
const licenses = ['LICENSE.txt', 'docs/LICENSE.MPL-2.0', 'docs/LICENSE.BSD-3-Clause', 'docs/LICENSE.BSD-2-Clause', 'vendor/pako/LICENSE'];
const metadata = JSON.parse(await readFile(join(noVncRoot, 'package.json'), 'utf8')) as { version: string };
let notices = `MicroVM desktop includes noVNC ${metadata.version}.\nSource: https://github.com/novnc/noVNC/tree/v${metadata.version}\n\n`;
for (const path of licenses) notices += `${path}\n${'='.repeat(path.length)}\n${await readFile(join(noVncRoot, path), 'utf8')}\n\n`;
const assets = new Map([
  ['client.js.asset', await result.outputs[0].text()],
  ['index.html.asset', await readFile(join(source, 'index.html'), 'utf8')],
  ['style.css.asset', await readFile(join(source, 'style.css'), 'utf8')],
  ['licenses.txt.asset', notices],
]);
if (!check) await mkdir(output, { recursive: true });
for (const [name, content] of assets) {
  const path = join(output, name);
  if (check) {
    if (await readFile(path, 'utf8') !== content) throw new Error(`Desktop asset ${name} is out of date. Run bun run build:desktop.`);
  } else await writeFile(path, content);
}
