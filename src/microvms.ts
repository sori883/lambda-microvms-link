import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  ListMicrovmsCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
  type GetMicrovmResponse,
  type MicrovmItem,
  type RunMicrovmRequest,
} from '@aws-sdk/client-lambda-microvms';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class OperationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export type StartOptions = {
  image: string;
  imageVersion?: string;
  duration: number;
  clientToken?: string;
  wait: boolean;
};

function endpointUrl(address: string | undefined) {
  try {
    const endpoint = new URL(address?.includes('://') ? address : `https://${address ?? ''}`);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || endpoint.port) throw new Error();
    return endpoint;
  } catch {
    throw new OperationError('InvalidEndpoint', 'AWS did not return a valid HTTPS endpoint.');
  }
}

export function vmView(vm: GetMicrovmResponse | MicrovmItem) {
  return {
    microvmId: vm.microvmId,
    state: vm.state,
    imageArn: vm.imageArn,
    imageVersion: vm.imageVersion,
    startedAt: vm.startedAt,
    ...('endpoint' in vm ? {
      endpoint: vm.endpoint,
      maximumDurationInSeconds: vm.maximumDurationInSeconds,
      terminatedAt: vm.terminatedAt,
      stateReason: vm.stateReason,
    } : {}),
  };
}

export class Microvms {
  readonly recovery: Record<string, string | number> = {};

  constructor(
    private readonly client: LambdaMicrovmsClient,
    private readonly signal: AbortSignal,
    private readonly fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
  ) {}

  private async imageArn(identifier: string) {
    if (identifier.startsWith('arn:')) return identifier;
    let nextToken: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.client.send(new ListMicrovmImagesCommand({ nextToken }), { abortSignal: this.signal });
      const match = page.items?.find(image => image.name === identifier);
      if (match?.imageArn) return match.imageArn;
      nextToken = page.nextToken;
      if (nextToken && seen.has(nextToken)) throw new OperationError('InvalidPagination', 'AWS returned a repeated image pagination token.');
      if (nextToken) seen.add(nextToken);
    } while (nextToken);
    throw new OperationError('ImageNotFound', 'No image with that name exists in the selected account and region.');
  }

  async prepareStart(options: StartOptions, pinVersion = false): Promise<RunMicrovmRequest> {
    const clientToken = options.clientToken ?? randomUUID();
    Object.assign(this.recovery, {
      clientToken, image: options.image, duration: options.duration,
      ...(options.imageVersion ? { imageVersion: options.imageVersion } : {}),
    });
    const imageIdentifier = await this.imageArn(options.image);
    const image = await this.client.send(new GetMicrovmImageCommand({ imageIdentifier }), { abortSignal: this.signal });
    const arn = image.imageArn?.match(/^arn:([a-z0-9-]+):lambda:([a-z0-9-]+):\d{12}:microvm-image:/);
    if (!arn) throw new OperationError('InvalidImage', 'AWS did not return a valid image ARN.');
    const region = await this.client.config.region();
    if (arn[2] !== region) throw new OperationError('RegionMismatch', 'The image and client regions must match.');
    const imageVersion = options.imageVersion ?? (pinVersion ? image.latestActiveImageVersion : undefined);
    if (pinVersion && !imageVersion) throw new OperationError('InvalidImage', 'The image has no active version to start.');
    return {
      imageIdentifier,
      imageVersion,
      maximumDurationInSeconds: options.duration,
      clientToken,
      ingressNetworkConnectors: ['HTTP_INGRESS', 'SHELL_INGRESS'].map(name => `arn:${arn[1]}:lambda:${region}:aws:network-connector:aws-network-connector:${name}`),
      logging: { disabled: {} },
    };
  }

  async runPrepared(input: RunMicrovmRequest) {
    Object.assign(this.recovery, { clientToken: input.clientToken, image: input.imageIdentifier, duration: input.maximumDurationInSeconds });
    const started = await this.client.send(new RunMicrovmCommand(input), { abortSignal: this.signal });
    if (!started.microvmId) throw new OperationError('InvalidResponse', 'AWS accepted the request without returning a VM ID; retry with the same client token and inputs.');
    this.recovery.microvmId = started.microvmId;
    this.recovery.state = started.state ?? 'UNKNOWN';
    return started;
  }

  async start(options: StartOptions) {
    const input = await this.prepareStart(options);
    const started = await this.runPrepared(input);
    const vm = options.wait ? await this.waitFor(started.microvmId!, 'RUNNING') : started;
    return { ...vmView(vm), clientToken: input.clientToken };
  }

  async list(image?: string) {
    const imageIdentifier = image ? await this.imageArn(image) : undefined;
    const microvms: ReturnType<typeof vmView>[] = [];
    let nextToken: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.client.send(new ListMicrovmsCommand({ imageIdentifier, nextToken }), { abortSignal: this.signal });
      microvms.push(...(page.items ?? []).map(vmView));
      nextToken = page.nextToken;
      if (nextToken && seen.has(nextToken)) throw new OperationError('InvalidPagination', 'AWS returned a repeated pagination token.');
      if (nextToken) seen.add(nextToken);
    } while (nextToken);
    return { microvms };
  }

  async status(id: string) {
    this.recovery.microvmId = id;
    const vm = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: id }), { abortSignal: this.signal });
    this.recovery.state = vm.state ?? 'UNKNOWN';
    return vm;
  }

  async waitFor(id: string, target: 'RUNNING' | 'TERMINATED') {
    for (;;) {
      const vm = await this.status(id);
      if (vm.state === target) return vm;
      if (target === 'RUNNING' && vm.state !== 'PENDING') {
        throw new OperationError('UnexpectedState', `VM entered ${vm.state ?? 'UNKNOWN'} before RUNNING. Inspect it with status.`);
      }
      await delay(1_000, undefined, { signal: this.signal });
    }
  }

  async stop(id: string, wait: boolean) {
    const vm = await this.status(id);
    if (vm.state === 'TERMINATED') return vmView(vm);
    if (vm.state !== 'TERMINATING') {
      await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }), { abortSignal: this.signal });
    }
    if (wait) return vmView(await this.waitFor(id, 'TERMINATED'));
    return { microvmId: id, terminationRequested: true };
  }

  async check(id: string, port: number, path: string) {
    const vm = await this.status(id);
    if (vm.state !== 'RUNNING') throw new OperationError('NotRunning', `VM is ${vm.state ?? 'UNKNOWN'}; check requires RUNNING.`);
    const endpoint = endpointUrl(vm.endpoint);
    const url = new URL(path, endpoint);
    if (url.origin !== endpoint.origin) throw new OperationError('InvalidPath', 'The check path must stay on the VM endpoint.');
    const { authToken } = await this.client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: id,
      expirationInMinutes: 1,
      allowedPorts: [{ port }],
    }), { abortSignal: this.signal });
    const token = authToken?.['X-aws-proxy-auth'];
    if (!token) throw new OperationError('InvalidTokenResponse', 'AWS did not return the required proxy authentication header.');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers: { 'X-aws-proxy-auth': token, 'X-aws-proxy-port': String(port) },
        redirect: 'manual',
        signal: this.signal,
      });
    } catch {
      throw new OperationError('ConnectionFailed', 'HTTPS connection to the VM failed. Check ingress and the application port.');
    }
    await response.body?.cancel();
    if (!response.ok) throw new OperationError('HttpError', `VM returned HTTP ${response.status}. Redirects are not followed.`);
    return { microvmId: id, url: url.href, port, statusCode: response.status, ok: true };
  }

  async shellAccess(id: string) {
    const vm = await this.status(id);
    if (vm.state !== 'RUNNING') throw new OperationError('NotRunning', `VM is ${vm.state ?? 'UNKNOWN'}; SSH requires RUNNING.`);
    const url = endpointUrl(vm.endpoint);
    url.protocol = 'wss:';
    url.pathname = '/shell';
    const { authToken } = await this.client.send(new CreateMicrovmShellAuthTokenCommand({
      microvmIdentifier: id, expirationInMinutes: 1,
    }), { abortSignal: this.signal });
    const token = authToken?.['X-aws-proxy-auth'];
    if (!token) throw new OperationError('InvalidTokenResponse', 'AWS did not return the required shell token.');
    return { url, token };
  }

  close() {
    this.client.destroy();
  }
}
