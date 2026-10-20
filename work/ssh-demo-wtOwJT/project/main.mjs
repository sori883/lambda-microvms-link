import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
const message = (await readFile('message.txt', 'utf8')).trim();
const result = { input: message, output: message.toUpperCase(), platform: process.platform, hostname: hostname(), cwd: process.cwd() };
await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
