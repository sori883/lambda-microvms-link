import { LambdaMicrovmsClient, CreateMicrovmShellAuthTokenCommand, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { Microvms } from '../../../src/microvms.ts';
const client = new LambdaMicrovmsClient({ profile: 'AdministratorAccess-242201303782', region: 'ap-northeast-1' });
const service = new Microvms(client, AbortSignal.timeout(120_000));
let id;
try {
  const started = await client.send(new RunMicrovmCommand({
    imageIdentifier: 'arn:aws:lambda:ap-northeast-1:242201303782:microvm-image:lambda-microvms-link-dev',
    maximumDurationInSeconds: 180,
    ingressNetworkConnectors: ['HTTP_INGRESS', 'SHELL_INGRESS'].map(name => `arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:${name}`),
    logging: { disabled: {} },
  }));
  id = started.microvmId;
  let vm = await service.status(id);
  while (vm.state === 'PENDING') { await new Promise(resolve => setTimeout(resolve, 1000)); vm = await service.status(id); }
  console.log(JSON.stringify({ id, state: vm.state }));
  const { authToken } = await client.send(new CreateMicrovmShellAuthTokenCommand({ microvmIdentifier: id, expirationInMinutes: 1 }));
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${vm.endpoint}/shell`, ['lambda-microvms', `lambda-microvms.authentication.${authToken['X-aws-proxy-auth']}`, 'lambda-microvms.port.8022']);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { ws.close(); reject(new Error('probe timeout')); }, 20_000);
    ws.onopen = () => ws.send(new TextEncoder().encode("id; pwd; cat /etc/os-release; command -v sshd; command -v ctr; ls /app; printf '\\nMVM_PROBE_DONE\\n'\n"));
    let output = '';
    ws.onmessage = ({data}) => {
      if (typeof data === 'string') { console.log(JSON.stringify({control: data})); return; }
      const text = Buffer.from(data).toString();
      output += text;
      if (output.includes('\r\nMVM_PROBE_DONE\r\n') || output.includes('\nMVM_PROBE_DONE\n')) {
        console.log(JSON.stringify({output})); clearTimeout(timer); ws.close(); resolve();
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS connection failed')); };
  });
} finally {
  if (id) console.log(JSON.stringify(await service.stop(id, true)));
  service.close();
}
