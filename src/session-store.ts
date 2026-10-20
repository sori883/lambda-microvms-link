import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RunMicrovmRequest } from '@aws-sdk/client-lambda-microvms';
import { OperationError } from './microvms.ts';
import type { AwsBinding } from './session-aws.ts';

export type SessionSsh = { generation: string; publicKey: string; hostKey: string };
export type SessionObservation = { state: string; at: string; startedAt?: string; expiresAt?: string };
export type SessionSource = { image: string; imageVersion?: string; duration: number };
export type SessionRecord = {
  id: string;
  name: string;
  project: string;
  binding: AwsBinding;
  request: RunMicrovmRequest;
  source: SessionSource;
  pending: 'prepared' | 'request-unknown' | null;
  vmId?: string;
  desired: 'running' | 'terminated';
  createdAt: string;
  requestedAt?: string;
  revision: number;
  observed?: SessionObservation;
  hostPin?: string;
  ssh?: SessionSsh;
};

type Reservation = Pick<SessionRecord, 'name' | 'project' | 'binding' | 'request' | 'source'>;
type Row = { record: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hostKey = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/;

export function sessionName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new OperationError('InvalidSessionName', 'Use a lowercase session name beginning with a letter, followed by letters, digits or hyphens (up to 63 characters).');
  }
  return name;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(json: string): SessionRecord {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new OperationError('InvalidSessionStore', 'The session database contains invalid data.'); }
  if (!object(value) || typeof value.id !== 'string' || !uuid.test(value.id) ||
    typeof value.name !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(value.name) ||
    typeof value.project !== 'string' || !value.project.startsWith('/') ||
    !object(value.binding) || typeof value.binding.accountId !== 'string' || !/^\d{12}$/.test(value.binding.accountId) ||
    typeof value.binding.region !== 'string' || !value.binding.region ||
    (value.binding.profile !== undefined && typeof value.binding.profile !== 'string') ||
    !object(value.request) || typeof value.request.imageIdentifier !== 'string' ||
    typeof value.request.imageVersion !== 'string' || !value.request.imageVersion ||
    typeof value.request.clientToken !== 'string' || !value.request.clientToken ||
    typeof value.request.maximumDurationInSeconds !== 'number' ||
    !object(value.source) || typeof value.source.image !== 'string' || typeof value.source.duration !== 'number' ||
    (value.source.imageVersion !== undefined && typeof value.source.imageVersion !== 'string') ||
    !['prepared', 'request-unknown', null].includes(value.pending as string | null) ||
    !['running', 'terminated'].includes(value.desired as string) ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    (value.requestedAt !== undefined && (typeof value.requestedAt !== 'string' || !Number.isFinite(Date.parse(value.requestedAt)))) ||
    typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0 ||
    (value.vmId !== undefined && (typeof value.vmId !== 'string' || !/^microvm-[A-Za-z0-9-]+$/.test(value.vmId))) ||
    (value.hostPin !== undefined && (typeof value.hostPin !== 'string' || !hostKey.test(value.hostPin))) ||
    (value.observed !== undefined && (!object(value.observed) || typeof value.observed.state !== 'string' ||
      typeof value.observed.at !== 'string' || !Number.isFinite(Date.parse(value.observed.at)))) ||
    (value.ssh !== undefined && (!object(value.ssh) || typeof value.ssh.generation !== 'string' || !uuid.test(value.ssh.generation) ||
      typeof value.ssh.publicKey !== 'string' || !hostKey.test(value.ssh.publicKey) ||
      typeof value.ssh.hostKey !== 'string' || !hostKey.test(value.ssh.hostKey) || value.ssh.hostKey !== value.hostPin))) {
    throw new OperationError('InvalidSessionStore', 'The session database contains invalid data.');
  }
  return value as SessionRecord;
}

export class SessionStore {
  readonly root: string;
  private readonly db: Database;

  constructor(root = process.env.MVM_HOME ?? join(homedir(), '.mvm')) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) {
      throw new OperationError('InvalidSessionStore', 'The session directory must be a regular directory.');
    }
    chmodSync(this.root, 0o700);
    const path = join(this.root, 'sessions.sqlite');
    try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) {
      if (!object(error) || error.code !== 'EEXIST') throw error;
    }
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new OperationError('InvalidSessionStore', 'The session database must be a regular file.');
    }
    chmodSync(path, 0o600);
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 2000');
      this.db.transaction(() => {
        const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (version === 0) {
          if (this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().length) {
            throw new OperationError('InvalidSessionStore', 'An unrecognized database exists at the session database path.');
          }
          this.db.exec(`CREATE TABLE sessions (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
            account_id TEXT NOT NULL, region TEXT NOT NULL, vm_id TEXT,
            revision INTEGER NOT NULL, record TEXT NOT NULL,
            UNIQUE(account_id, region, vm_id)
          ); PRAGMA user_version = 1`);
        } else if (version !== 1) {
          throw new OperationError('UnsupportedSessionSchema', 'This session database version is not supported by this CLI.');
        }
        const columns = this.db.query('PRAGMA table_info(sessions)').all() as { name: string }[];
        if (columns.map(column => column.name).join(',') !== 'id,name,account_id,region,vm_id,revision,record') {
          throw new OperationError('InvalidSessionStore', 'The session database schema is invalid.');
        }
      }).immediate();
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  find(name: string): SessionRecord | undefined {
    sessionName(name);
    const row = this.db.query<Row, [string]>('SELECT record FROM sessions WHERE name = ?').get(name);
    return row ? parseRecord(row.record) : undefined;
  }

  get(name: string): SessionRecord {
    const record = this.find(name);
    if (!record) throw new OperationError('SessionNotFound', `Session ${name} does not exist.`);
    return record;
  }

  getById(id: string): SessionRecord {
    const row = this.db.query<Row, [string]>('SELECT record FROM sessions WHERE id = ?').get(id);
    if (!row) throw new OperationError('SessionNotFound', 'The session does not exist.');
    return parseRecord(row.record);
  }

  list(): SessionRecord[] {
    return this.db.query<Row, []>('SELECT record FROM sessions ORDER BY name').all().map(row => parseRecord(row.record));
  }

  reserve(input: Reservation): { record: SessionRecord; created: boolean } {
    sessionName(input.name);
    return this.db.transaction(() => {
      const existing = this.find(input.name);
      if (existing) return { record: existing, created: false };
      const record: SessionRecord = {
        ...input, id: randomUUID(), pending: 'prepared', desired: 'running',
        createdAt: new Date().toISOString(), revision: 0,
      };
      parseRecord(JSON.stringify(record));
      this.db.query('INSERT INTO sessions (id, name, account_id, region, vm_id, revision, record) VALUES (?, ?, ?, ?, NULL, ?, ?)')
        .run(record.id, record.name, record.binding.accountId, record.binding.region, record.revision, JSON.stringify(record));
      return { record, created: true };
    }).immediate();
  }

  private change(id: string, update: (record: SessionRecord) => void): SessionRecord {
    return this.db.transaction(() => {
      const record = this.getById(id);
      const revision = record.revision;
      update(record);
      record.revision++;
      parseRecord(JSON.stringify(record));
      this.db.query('UPDATE sessions SET vm_id = ?, revision = ?, record = ? WHERE id = ? AND revision = ?')
        .run(record.vmId ?? null, record.revision, JSON.stringify(record), id, revision);
      return record;
    }).immediate();
  }

  claimRun(id: string): SessionRecord {
    return this.change(id, record => {
      if (record.pending !== 'prepared' || record.desired !== 'running') {
        throw new OperationError('SessionRecoveryRequired', 'The session cannot send another start request. Inspect it or recover with an explicit VM ID.');
      }
      record.pending = 'request-unknown';
      record.requestedAt = new Date().toISOString();
    });
  }

  bind(id: string, vmId: string): SessionRecord {
    return this.change(id, record => {
      if (!/^microvm-[A-Za-z0-9-]+$/.test(vmId)) throw new OperationError('InvalidVmId', 'AWS did not return a valid VM ID.');
      if (record.vmId && record.vmId !== vmId) throw new OperationError('SessionAlreadyBound', 'A session cannot be moved to another VM.');
      const existing = this.db.query<{ id: string }, [string, string, string]>(
        'SELECT id FROM sessions WHERE account_id = ? AND region = ? AND vm_id = ?',
      ).get(record.binding.accountId, record.binding.region, vmId);
      if (existing && existing.id !== id) throw new OperationError('VmAlreadyBound', 'This VM already belongs to another session.');
      record.vmId = vmId;
      record.pending = null;
    });
  }

  requestStop(id: string): SessionRecord {
    return this.change(id, record => {
      record.desired = 'terminated';
      if (record.pending === 'prepared') {
        record.pending = null;
        record.observed = { state: 'TERMINATED', at: new Date().toISOString() };
      }
    });
  }

  observe(id: string, observation: SessionObservation): SessionRecord {
    return this.change(id, record => {
      if (record.observed?.state === 'TERMINATED') return;
      record.observed = observation;
      if (observation.state === 'TERMINATED') record.desired = 'terminated';
    });
  }

  publishSsh(id: string, candidate: SessionSsh): SessionRecord {
    if (!uuid.test(candidate.generation) || !hostKey.test(candidate.publicKey) || !hostKey.test(candidate.hostKey)) {
      throw new OperationError('InvalidSshGeneration', 'The SSH generation is invalid.');
    }
    return this.change(id, record => {
      if (!record.vmId || record.desired !== 'running' || record.observed?.state === 'TERMINATED') {
        throw new OperationError('SessionStopped', 'This session no longer accepts SSH connections.');
      }
      if (record.hostPin && record.hostPin !== candidate.hostKey) {
        throw new OperationError('HostKeyMismatch', 'The VM host key differs from the saved session host key.');
      }
      record.hostPin ??= candidate.hostKey;
      record.ssh ??= candidate;
    });
  }

  clearSsh(id: string, generation: string): boolean {
    let cleared = false;
    this.change(id, record => {
      if (record.observed?.state !== 'TERMINATED') throw new OperationError('SessionNotTerminated', 'SSH files can only be removed after VM termination is confirmed.');
      if (record.ssh?.generation === generation) {
        delete record.ssh;
        cleared = true;
      }
    });
    return cleared;
  }

  close() { this.db.close(); }
}
