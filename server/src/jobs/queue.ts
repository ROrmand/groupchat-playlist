import { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';

export interface FanOutTrackAdditionJob {
  eventId: string;
  groupPlaylistId: string;
  canonicalTrackId: string;
}
export interface FanOutTrackRemovalJob {
  eventId: string;
  groupPlaylistId: string;
  canonicalTrackId: string;
}
export interface BackfillMembershipJob {
  membershipId: string;
  groupPlaylistId: string;
  userId: string;
}
export interface RecreatePlaylistJob {
  membershipId: string;
  groupPlaylistId: string;
  userId: string;
}
export interface JobPayloads {
  'provision-membership': { attemptId: string };
  'deliver-membership': { membershipId: string; throughSequence: number };
  'fan-out-track-addition': FanOutTrackAdditionJob;
  'fan-out-track-removal': FanOutTrackRemovalJob;
  'backfill-membership': BackfillMembershipJob;
  'recreate-playlist': RecreatePlaylistJob;
}
export const queueNames = [
  'provision-membership',
  'fan-out-track-addition', 'fan-out-track-removal', 'backfill-membership', 'recreate-playlist', 'deliver-membership',
] as const satisfies readonly (keyof JobPayloads)[];

export class JobQueue {
  private readonly boss: PgBoss;

  constructor(databaseUrl: string, private readonly concurrency: number, onError: (error: Error) => void) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid worker concurrency');
    this.boss = new PgBoss({ connectionString: databaseUrl });
    this.boss.on('error', onError);
  }

  async start(): Promise<void> {
    try {
      await this.boss.start();
      for (const name of queueNames) {
        await this.boss.createQueue(name, { retryLimit: 5, retryDelay: 2, retryBackoff: true });
      }
    } catch (error) {
      await this.boss.stop();
      throw error;
    }
  }

  async register<Name extends keyof JobPayloads>(name: Name, handler: (payload: JobPayloads[Name]) => Promise<void>): Promise<void> {
    await this.boss.work<JobPayloads[Name]>(name, { localConcurrency: this.concurrency, batchSize: 1 }, async jobs => {
      for (const job of jobs) await handler(job.data);
    });
  }

  async send<Name extends keyof JobPayloads>(name: Name, payload: JobPayloads[Name]): Promise<string | null> {
    return this.boss.send(name, payload);
  }

  async sendInTransaction<Name extends keyof JobPayloads>(client: PoolClient, name: Name, payload: JobPayloads[Name], delaySeconds = 0): Promise<void> {
    const identifier = await this.boss.send(name, payload, {
      startAfter: delaySeconds,
      db: { executeSql: (text, values) => client.query(text, values) },
    });
    if (!identifier) throw new Error('Transactional job was not created');
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10000 });
  }
}
