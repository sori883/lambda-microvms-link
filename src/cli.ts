import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { Microvms, OperationError, vmView, type StartOptions } from './microvms.ts';
import metadata from '../package.json' with { type: 'json' };
import { sshProxy, withSsh } from './ssh.ts';
import { Sessions } from './sessions.ts';
import { sessionAws } from './session-aws.ts';
import { prepareSessionSsh, sessionSsh, sessionCode } from './session-ssh.ts';
import { sessionDesktop } from './desktop.ts';

type CommonOptions = { profile?: string; region?: string; json?: boolean; timeout: number; stateDir?: string };

function write(stream: NodeJS.WriteStream, value: string) {
  return new Promise<void>((resolve, reject) => {
    stream.write(value, error => error ? reject(error) : resolve());
  });
}

function integer(min: number, max: number) {
  return (value: string) => {
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`);
    }
    return Number(value);
  };
}

function textArgument(value: string) {
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new InvalidArgumentError('Expected non-empty text without control characters.');
  return value;
}

function idArgument(value: string) {
  if (!/^microvm-[a-zA-Z0-9-]+$/.test(value)) throw new InvalidArgumentError('Expected a MicroVM ID beginning with microvm-.');
  return value;
}

function healthPath(value: string) {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(value)) throw new InvalidArgumentError('Expected an absolute URL path, such as /health.');
  return value;
}

function readable(result: Record<string, unknown>): string {
  if (Array.isArray(result.sessions)) {
    if (!result.sessions.length) return 'No sessions found.\n';
    return ['NAME\tSTATE\tVM\tPROJECT\tEXPIRES\tERROR',
      ...result.sessions.map(session => `${session.name}\t${session.state}\t${session.microvmId ?? '-'}\t${session.project}\t${session.expiresAt ?? '-'}\t${session.error?.code ?? '-'}`),
    ].join('\n') + '\n';
  }
  if (Array.isArray(result.microvms)) {
    if (!result.microvms.length) return 'No MicroVMs found.\n';
    return ['ID\tSTATE\tIMAGE\tVERSION', ...result.microvms.map(vm => `${vm.microvmId}\t${vm.state}\t${vm.imageArn}\t${vm.imageVersion}`)].join('\n') + '\n';
  }
  return Object.entries(result).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n') + '\n';
}

function safeError(error: unknown) {
  if (error instanceof OperationError || error instanceof CommanderError) return { code: error instanceof OperationError ? error.code : 'UsageError', message: error.message };
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(error.name) ? error.name : 'OperationFailed';
  if (name === 'CredentialsProviderError' || name === 'TokenProviderError') return { code: name, message: 'AWS credentials could not be resolved. Check your environment, profile or credential provider.' };
  if (error instanceof Error && error.message === 'Region is missing') return { code: 'MissingRegion', message: 'Set --region, AWS_REGION or the region in your AWS profile.' };
  return { code: name, message: 'AWS operation failed. Check credentials, permissions, region and network access.' };
}

export async function runCli(argv: string[]): Promise<number> {
  const program = new Command()
    .name('mvm')
    .description('Manage AWS Lambda MicroVMs from Bun.')
    .version(metadata.version)
    .option('--profile <name>', 'AWS shared profile (otherwise use the SDK credential chain)', textArgument)
    .option('--region <region>', 'AWS region (otherwise use SDK configuration)', textArgument)
    .option('--json', 'emit one JSON result; errors go to stderr')
    .option('--timeout <seconds>', 'operation deadline (SSH/desktop: connection setup only)', integer(1, 3600), 120)
    .addOption(new Option('--state-dir <path>', 'session data directory (otherwise MVM_HOME or ~/.mvm)').hideHelp())
    .exitOverride()
    .configureOutput({ outputError: () => {} });
  let output: Record<string, unknown> | undefined;
  let service: Microvms | undefined;
  let sessions: Sessions | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exitCode = 0;
  let streaming = false;
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); };

  async function execute(command: Command, action: (service: Microvms) => Promise<Record<string, unknown> | undefined>) {
    const options = command.optsWithGlobals<CommonOptions>();
    timeout = setTimeout(() => controller.abort(), options.timeout * 1000);
    service = new Microvms(new LambdaMicrovmsClient({
      profile: options.profile, region: options.region,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    }), controller.signal);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new OperationError('Aborted', 'Operation aborted.')), { once: true });
      if (controller.signal.aborted) reject(new OperationError('Aborted', 'Operation aborted.'));
    });
    if (streaming) {
      void aborted.catch(() => {});
      output = await action(service);
    } else output = await Promise.race([action(service), aborted]);
  }

  async function executeSession(command: Command, action: (manager: Sessions, options: CommonOptions) => Promise<Record<string, unknown> | undefined>) {
    const options = command.optsWithGlobals<CommonOptions>();
    timeout = setTimeout(() => controller.abort(), options.timeout * 1000);
    sessions = new Sessions(options, controller.signal, options.stateDir);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new OperationError('Aborted', 'Session operation aborted.')), { once: true });
      if (controller.signal.aborted) reject(new OperationError('Aborted', 'Session operation aborted.'));
    });
    if (streaming) {
      void aborted.catch(() => {});
      output = await action(sessions, options);
    } else output = await Promise.race([action(sessions, options), aborted]);
  }

  const prepared = () => { if (timeout) clearTimeout(timeout); timeout = undefined; };
  function requireStream(command: Command) {
    if (command.optsWithGlobals<CommonOptions>().json) throw new InvalidArgumentError('--json is not supported for interactive connections.');
    streaming = true;
  }

  program.command('start').description('Start a VM and wait for RUNNING')
    .requiredOption('--image <name-or-arn>', 'existing MicroVM image', textArgument)
    .option('--image-version <version>', 'image version (otherwise latest active)', textArgument)
    .option('--duration <seconds>', 'maximum VM lifetime', integer(1, 28800), 3600)
    .option('--client-token <token>', 'reuse this token and identical inputs to retry an uncertain start', textArgument)
    .option('--no-wait', 'return after AWS accepts the start')
    .action(async (options: StartOptions, command: Command) => execute(command, service => service.start(options)));
  program.command('list').description('List all pages of VMs in the selected account and region')
    .option('--image <name-or-arn>', 'filter by image', textArgument)
    .action(async (options: { image?: string }, command: Command) => execute(command, service => service.list(options.image)));
  program.command('status').description('Show the current AWS state of a VM')
    .argument('<id>', 'MicroVM ID', idArgument)
    .action(async (id: string, _options: unknown, command: Command) => execute(command, async service => vmView(await service.status(id))));
  program.command('check').description('Check that an authenticated HTTPS GET returns 2xx')
    .argument('<id>', 'MicroVM ID', idArgument)
    .option('--port <port>', 'application port', integer(1, 65535), 8080)
    .option('--path <path>', 'HTTP path to check', healthPath, '/health')
    .action(async (id: string, options: { port: number; path: string }, command: Command) => execute(command, service => service.check(id, options.port, options.path)));
  program.command('stop').description('Permanently terminate a VM and wait for TERMINATED')
    .argument('<id>', 'MicroVM ID', idArgument)
    .option('--no-wait', 'return after AWS accepts termination')
    .action(async (id: string, options: { wait: boolean }, command: Command) => execute(command, service => service.stop(id, options.wait)));

  program.command('ssh').description('Open SSH, or run a remote command (global options go before ssh)')
    .argument('<id>', 'MicroVM ID', idArgument)
    .argument('[command...]', 'remote program and arguments; use sh -lc for shell syntax')
    .action(async (id: string, args: string[], _options: unknown, command: Command) => {
      requireStream(command);
      await execute(command, async service => {
        exitCode = await withSsh(service, id, command.optsWithGlobals<CommonOptions>(), args, false, controller.signal, prepared);
        return undefined;
      });
    });
  program.command('with-ssh').description('Run a local tool with temporary MVM_SSH_CONFIG and host alias mvm')
    .argument('<id>', 'MicroVM ID', idArgument)
    .argument('<command...>', 'local program and arguments (for example sh -c ...)')
    .action(async (id: string, args: string[], _options: unknown, command: Command) => {
      requireStream(command);
      await execute(command, async service => {
        exitCode = await withSsh(service, id, command.optsWithGlobals<CommonOptions>(), args, true, controller.signal, prepared);
        return undefined;
      });
    });
  program.command('ssh-proxy', { hidden: true })
    .argument('<id>', 'MicroVM ID', idArgument)
    .requiredOption('--public-key <base64>', 'temporary SSH public key', value => {
      if (!/^[A-Za-z0-9+/=]{1,1024}$/.test(value) || !/^ssh-ed25519 [A-Za-z0-9+/]{68}(?: [^\r\n\x00]*)?$/.test(Buffer.from(value, 'base64').toString('utf8'))) {
        throw new InvalidArgumentError('Expected a base64 encoded Ed25519 public key.');
      }
      return value;
    })
    .action(async (id: string, options: { publicKey: string }, command: Command) => {
      requireStream(command);
      await execute(command, async service => {
        await sshProxy(service, id, options.publicKey, controller.signal, prepared);
        return undefined;
      });
    });

  const session = program.command('session').description('Manage named project sessions and persistent SSH connections');
  session.command('create').description('Create a named VM; --project records a directory without uploading it')
    .argument('<name>', 'session name', textArgument)
    .requiredOption('--image <name-or-arn>', 'existing MicroVM image', textArgument)
    .option('--project <directory>', 'local project directory', textArgument, '.')
    .option('--image-version <version>', 'image version (otherwise pin the latest active version)', textArgument)
    .option('--duration <seconds>', 'maximum VM lifetime', integer(1, 28800), 3600)
    .action(async (name: string, options: { image: string; project: string; imageVersion?: string; duration: number }, command: Command) =>
      executeSession(command, manager => manager.create({ name, ...options })));
  session.command('list').description('List local sessions and check their current AWS state')
    .action(async (_options: unknown, command: Command) => executeSession(command, async manager => {
      const result = await manager.list();
      if (result.sessions.some(item => item.error)) exitCode = 1;
      return result;
    }));
  session.command('status').description('Check a named session against AWS')
    .argument('<name>', 'session name', textArgument)
    .action(async (name: string, _options: unknown, command: Command) => executeSession(command, manager => manager.status(name)));
  session.command('stop').description('Terminate a named VM and remove its SSH connection keys')
    .argument('<name>', 'session name', textArgument)
    .action(async (name: string, _options: unknown, command: Command) => executeSession(command, manager => manager.stop(name)));
  session.command('recover').description('Bind an explicitly chosen VM after an uncertain start')
    .argument('<name>', 'session name', textArgument)
    .requiredOption('--id <vm-id>', 'VM ID to validate and bind', idArgument)
    .action(async (name: string, options: { id: string }, command: Command) =>
      executeSession(command, manager => manager.recover(name, options.id)));

  session.command('desktop').description('View the VM desktop in a local browser; keep this command running')
    .argument('<name>', 'session name', textArgument)
    .option('--no-open', 'print the private connection URL instead of opening a browser')
    .option('--port <port>', 'local loopback port (0 selects a free port)', integer(0, 65535), 0)
    .action(async (name: string, desktopOptions: { open: boolean; port: number }, command: Command) => {
      requireStream(command);
      await executeSession(command, async (manager, options) => {
        await manager.status(name);
        const record = manager.store.get(name);
        const context = await sessionAws(options, controller.signal, record.binding);
        service = context.service;
        const connection = await prepareSessionSsh(manager.store, record, service, options, controller.signal);
        exitCode = await sessionDesktop(connection, desktopOptions, controller.signal, prepared);
        return undefined;
      });
    });

  for (const operation of ['ssh', 'with-ssh', 'code'] as const) {
    const connect = session.command(operation)
      .description(operation === 'code' ? 'Open /workspace in a dedicated VS Code instance' :
        operation === 'with-ssh' ? 'Run a local tool with persistent MVM_SSH_CONFIG and MVM_SSH_HOST' : 'Connect to a named session using SSH')
      .argument('<name>', 'session name', textArgument);
    if (operation !== 'code') connect.argument(operation === 'with-ssh' ? '<command...>' : '[command...]', 'program and arguments');
    connect.action(async (...values: unknown[]) => {
      const name = values[0] as string;
      const args = operation === 'code' ? [] : values[1] as string[];
      const command = values.at(-1) as Command;
      requireStream(command);
      await executeSession(command, async (manager, options) => {
        await manager.status(name);
        const record = manager.store.get(name);
        const context = await sessionAws(options, controller.signal, record.binding);
        service = context.service;
        const connection = await prepareSessionSsh(manager.store, record, service, options, controller.signal);
        prepared();
        exitCode = operation === 'code' ? await sessionCode(connection, controller.signal) :
          operation === 'with-ssh' ? await sessionSsh(connection, args, controller.signal, true) :
            await sessionSsh(connection, args, controller.signal);
        return undefined;
      });
    });
  }
  program.command('session-proxy', { hidden: true })
    .argument('<id>', 'immutable session ID', textArgument)
    .requiredOption('--generation <id>', 'SSH generation', textArgument)
    .action(async (id: string, proxyOptions: { generation: string }, command: Command) => {
      requireStream(command);
      await executeSession(command, async (manager, options) => {
        const record = manager.store.getById(id);
        if (record.desired !== 'running' || !record.vmId || !record.ssh || record.ssh.generation !== proxyOptions.generation ||
            record.observed?.state === 'TERMINATED') {
          throw new OperationError('SessionConnectionUnavailable', 'This session connection is no longer active. Use session status to inspect it.');
        }
        const context = await sessionAws(options, controller.signal, record.binding);
        service = context.service;
        await sshProxy(service, record.vmId, Buffer.from(record.ssh.publicKey).toString('base64'), controller.signal, prepared);
        return undefined;
      });
    });

  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await program.parseAsync(argv, { from: 'user' });
    if (output) await write(process.stdout, program.opts<CommonOptions>().json ? JSON.stringify(output) + '\n' : readable(output));
    return interrupted ? 130 : exitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const failure = controller.signal.aborted
      ? { code: interrupted ? 'Interrupted' : 'Timeout', message: sessions
        ? 'Operation stopped waiting. The session record is retained; use session status/list. An uncertain start requires session recover with an explicitly chosen VM ID.'
        : 'Operation stopped waiting. A VM may still exist; use the recovery ID with status/stop, or retry start with the same token and inputs.' }
      : safeError(error);
    const recovery = sessions ? { ...sessions.recovery, ...service?.recovery } : service?.recovery;
    const result = { error: { ...failure, ...(recovery && Object.keys(recovery).length ? { recovery } : {}) } };
    if (program.opts<CommonOptions>().json || argv.includes('--json')) await write(process.stderr, JSON.stringify(result) + '\n');
    else await write(process.stderr, `${failure.code}: ${failure.message}\n${recovery && Object.keys(recovery).length ? `Recovery: ${JSON.stringify(recovery)}\n` : ''}`);
    return interrupted ? 130 : error instanceof CommanderError ? 2 : 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    service?.close();
    sessions?.close();
  }
}
