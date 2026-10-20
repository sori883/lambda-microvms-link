import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Microvms, OperationError } from './microvms.ts';

export type AwsBinding = { accountId: string; region: string; profile?: string };
export type AwsOptions = { profile?: string; region?: string };

async function resolveBeforeAbort<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new OperationError('Aborted', 'AWS credential resolution was interrupted.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export async function sessionAws(options: AwsOptions, signal: AbortSignal, expected?: AwsBinding) {
  if (expected && options.region && options.region !== expected.region) {
    throw new OperationError('SessionRegionMismatch', `This session belongs to ${expected.region}.`);
  }
  const profile = options.profile ?? expected?.profile ?? process.env.AWS_PROFILE;
  const client = new LambdaMicrovmsClient({
    profile,
    region: expected?.region ?? options.region,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
  });
  let sts: STSClient | undefined;
  try {
    const region = await resolveBeforeAbort(() => client.config.region(), signal);
    const credentials = await resolveBeforeAbort(() => client.config.credentials(), signal);
    sts = new STSClient({
      region, credentials, profile,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    });
    const identity = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal });
    if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
      throw new OperationError('InvalidAccount', 'AWS did not return a valid caller account.');
    }
    if (expected && identity.Account !== expected.accountId) {
      throw new OperationError('SessionAccountMismatch', `This session belongs to AWS account ${expected.accountId}; the current credentials select another account.`);
    }
    const serviceClient = new LambdaMicrovmsClient({
      region, credentials, profile,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    });
    client.destroy();
    return {
      binding: { accountId: identity.Account, region, ...(profile ? { profile } : {}) } satisfies AwsBinding,
      service: new Microvms(serviceClient, signal),
    };
  } catch (error) {
    client.destroy();
    throw error;
  } finally {
    sts?.destroy();
  }
}
