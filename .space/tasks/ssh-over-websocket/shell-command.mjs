import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { Microvms } from '../../../src/microvms.ts';
import { ManagedShell } from '../../../src/managed-shell.ts';
import { randomBytes } from 'node:crypto';
const signal = AbortSignal.timeout(30_000);
const service = new Microvms(new LambdaMicrovmsClient({ profile: 'AdministratorAccess-242201303782', region: 'ap-northeast-1' }), signal);
let shell;
try {
  shell = await ManagedShell.connect(await service.shellAccess(process.argv[2]), signal);
  const nonce = randomBytes(16).toString('hex');
  const command = Buffer.from(process.argv[3]).toString('base64');
  const output = await shell.bootstrap(`stty raw -echo; printf '\\036MVM_%s:' ${nonce}; printf '%s' '${command}' | base64 -d | sh 2>&1 | base64 -w0; printf '\\037'; exit\n`, nonce);
  process.stdout.write(Buffer.from(output, 'base64'));
} finally { shell?.destroy(); service.close(); }
