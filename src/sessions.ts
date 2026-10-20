import { realpath, stat } from 'node:fs/promises';
import type { GetMicrovmResponse } from '@aws-sdk/client-lambda-microvms';
import { OperationError } from './microvms.ts';
import { sessionAws, type AwsOptions } from './session-aws.ts';
import { SessionStore, sessionName, type SessionRecord, type SessionObservation } from './session-store.ts';
import { cleanupSessionSsh } from './session-ssh.ts';

export type SessionView = {
  id: string; name: string; project: string; accountId: string; region: string; profile?: string;
  microvmId: string | undefined; state: string; pending: SessionRecord['pending'];
  desired: SessionRecord['desired']; observedAt?: string; expiresAt?: string;
  error?: { code: string; message: string };
};
export type CreateSessionInput = { name: string; project: string; image: string; imageVersion?: string; duration: number };

function view(record: SessionRecord, unknown?: { code: string; message: string }): SessionView {
  return {
    id: record.id, name: record.name, project: record.project, ...record.binding,
    microvmId: record.vmId, state: unknown ? 'UNKNOWN' : record.observed?.state ?? (record.pending === 'prepared' ? 'PREPARED' : 'UNKNOWN'),
    pending: record.pending, desired: record.desired,
    observedAt: record.observed?.at, expiresAt: record.observed?.expiresAt,
    ...(unknown ? { error: unknown } : {}),
  };
}

function safeError(error: unknown) {
  if (error instanceof OperationError) return { code: error.code, message: error.message };
  const code = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(error.name) ? error.name : 'SessionRefreshFailed';
  return { code, message: 'Could not refresh this session. Check AWS credentials, permissions, region and network access.' };
}

function observation(vm: GetMicrovmResponse): SessionObservation {
  if (!vm.state) throw new OperationError('InvalidResponse', 'AWS did not return a VM state.');
  return {
    state: vm.state, at: new Date().toISOString(),
    ...(vm.startedAt ? { startedAt: vm.startedAt.toISOString() } : {}),
    ...(vm.startedAt && vm.maximumDurationInSeconds ? {
      expiresAt: new Date(vm.startedAt.getTime() + vm.maximumDurationInSeconds * 1000).toISOString(),
    } : {}),
  };
}

export class Sessions {
  readonly store: SessionStore;
  readonly recovery: Record<string, string | number> = {};

  constructor(private readonly options: AwsOptions, private readonly signal: AbortSignal, home?: string) {
    this.store = new SessionStore(home);
  }

  private async observed(record: SessionRecord, vm: GetMicrovmResponse) {
    this.signal.throwIfAborted();
    const saved = this.store.observe(record.id, observation(vm));
    if (saved.observed?.state === 'TERMINATED') await cleanupSessionSsh(this.store, saved);
    return view(this.store.getById(record.id));
  }

  async create(input: CreateSessionInput): Promise<SessionView> {
    sessionName(input.name);
    this.recovery.sessionName = input.name;
    this.signal.throwIfAborted();
    const project = await realpath(input.project);
    if (!(await stat(project)).isDirectory()) throw new OperationError('InvalidProject', 'The project must be a directory.');
    if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 28800) {
      throw new OperationError('InvalidDuration', 'VM duration must be between 1 and 28800 seconds.');
    }
    let record = this.store.find(input.name);
    if (record) this.checkRetry(record, input, project);
    const { binding, service } = await sessionAws(this.options, this.signal, record?.binding);
    try {
      this.signal.throwIfAborted();
      if (!record) {
        const request = await service.prepareStart({ ...input, wait: false }, true);
        this.signal.throwIfAborted();
        const reserved = this.store.reserve({
          name: input.name, project, binding, request,
          source: { image: input.image, imageVersion: input.imageVersion, duration: input.duration },
        });
        record = reserved.record;
        if (!reserved.created) this.checkRetry(record, input, project);
      }
      if (binding.accountId !== record.binding.accountId || binding.region !== record.binding.region) {
        throw new OperationError('SessionTargetMismatch', 'This session reservation belongs to another AWS account or region.');
      }
      this.recovery.sessionId = record.id;
      this.signal.throwIfAborted();
      record = this.store.claimRun(record.id);
      let started: Awaited<ReturnType<typeof service.runPrepared>>;
      try { started = await service.runPrepared(record.request); } catch {
        throw new OperationError('SessionRecoveryRequired', `The start result for session ${record.name} is unknown. Use session recover with an explicit VM ID; this request will not be resent.`);
      }
      record = this.store.bind(record.id, started.microvmId!);
      this.recovery.microvmId = record.vmId!;
      this.signal.throwIfAborted();
      if (record.desired === 'terminated') {
        await service.stop(record.vmId!, true);
        return await this.observed(record, await service.status(record.vmId!));
      }
      let vm: GetMicrovmResponse;
      try { vm = await service.waitFor(record.vmId!, 'RUNNING'); } catch (error) {
        if (this.store.getById(record.id).desired !== 'terminated') throw error;
        await service.stop(record.vmId!, true);
        vm = await service.status(record.vmId!);
      }
      if (this.store.getById(record.id).desired === 'terminated' && vm.state !== 'TERMINATED') {
        await service.stop(record.vmId!, true);
        vm = await service.status(record.vmId!);
      }
      return await this.observed(record, vm);
    } finally { service.close(); }
  }

  private checkRetry(record: SessionRecord, input: CreateSessionInput, project: string) {
    if (record.pending === 'request-unknown') {
      throw new OperationError('SessionRecoveryRequired', 'The previous start result is unknown. Recover the session with an explicit VM ID; it will not be resent.');
    }
    if (record.pending !== 'prepared' || record.desired !== 'running') {
      throw new OperationError('SessionExists', 'This session name is already reserved. Use a new name for a new VM.');
    }
    if (record.project !== project || record.source.image !== input.image ||
      record.source.imageVersion !== input.imageVersion || record.source.duration !== input.duration) {
      throw new OperationError('SessionInputMismatch', 'The existing session reservation has different project or VM inputs.');
    }
  }

  async list(): Promise<{ sessions: SessionView[] }> {
    const sessions: SessionView[] = [];
    for (const record of this.store.list()) {
      this.signal.throwIfAborted();
      try { sessions.push(await this.status(record.name)); } catch (error) {
        this.signal.throwIfAborted();
        sessions.push(view(this.store.getById(record.id), safeError(error)));
      }
    }
    return { sessions };
  }

  async status(name: string): Promise<SessionView> {
    this.signal.throwIfAborted();
    const record = this.store.get(name);
    Object.assign(this.recovery, { sessionName: name, sessionId: record.id, ...(record.vmId ? { microvmId: record.vmId } : {}) });
    if (!record.vmId) return view(record);
    const { service } = await sessionAws(this.options, this.signal, record.binding);
    try { return await this.observed(record, await service.status(record.vmId)); } finally { service.close(); }
  }

  async stop(name: string): Promise<SessionView> {
    this.signal.throwIfAborted();
    let record = this.store.get(name);
    Object.assign(this.recovery, { sessionName: name, sessionId: record.id, ...(record.vmId ? { microvmId: record.vmId } : {}) });
    const { service } = await sessionAws(this.options, this.signal, record.binding);
    try {
      this.signal.throwIfAborted();
      record = this.store.requestStop(record.id);
      if (!record.vmId) {
        if (record.pending === 'request-unknown') throw new OperationError('SessionRecoveryRequired', 'The stop intent is saved. Recover the unknown start with an explicit VM ID so it can be terminated.');
        return view(record);
      }
      this.recovery.microvmId = record.vmId;
      await service.stop(record.vmId, true);
      return await this.observed(record, await service.status(record.vmId));
    } finally { service.close(); }
  }

  async recover(name: string, id: string): Promise<SessionView> {
    this.signal.throwIfAborted();
    if (!/^microvm-[A-Za-z0-9-]+$/.test(id)) throw new OperationError('InvalidVmId', 'Expected a MicroVM ID beginning with microvm-.');
    let record = this.store.get(name);
    Object.assign(this.recovery, { sessionName: name, sessionId: record.id, microvmId: id });
    if (record.vmId) {
      if (record.vmId !== id) throw new OperationError('SessionAlreadyBound', 'A session cannot be moved to another VM.');
      return record.desired === 'terminated' ? this.stop(name) : this.status(name);
    }
    if (record.pending !== 'request-unknown') throw new OperationError('SessionRecoveryNotNeeded', 'This session has no uncertain start to recover.');
    const { service } = await sessionAws(this.options, this.signal, record.binding);
    try {
      let vm = await service.status(id);
      const earliest = Date.parse(record.requestedAt ?? record.createdAt) - 60_000;
      const latest = Date.parse(record.requestedAt ?? record.createdAt) + 3_600_000;
      if (vm.microvmId !== id || vm.imageArn !== record.request.imageIdentifier ||
        vm.imageVersion !== record.request.imageVersion ||
        vm.maximumDurationInSeconds !== record.request.maximumDurationInSeconds ||
        !vm.startedAt || vm.startedAt.getTime() < earliest || vm.startedAt.getTime() > latest) {
        throw new OperationError('RecoveryVmMismatch', 'The VM does not match the saved image, version, duration and start time. No session binding was changed.');
      }
      this.signal.throwIfAborted();
      record = this.store.bind(record.id, id);
      if (record.desired === 'terminated' && vm.state !== 'TERMINATED') {
        await service.stop(id, true);
        vm = await service.status(id);
      }
      return await this.observed(record, vm);
    } finally { service.close(); }
  }

  close() { this.store.close(); }
}
