import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { JobQueue } from '../jobs/queue.js';

export class FanOutPlanner {
  constructor(private readonly pool: Pool, private readonly queue: Pick<JobQueue, 'sendInTransaction'>) {}

  async plan(eventId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const events = await client.query<{ group_playlist_id: string; sequence_number: number }>(
        'SELECT group_playlist_id, sequence_number FROM playlist_events WHERE id = $1', [eventId]);
      const event = events.rows[0];
      if (!event) throw new Error('Fan-out event not found');
      const members = await client.query<{ id: string; user_id: string }>(`SELECT membership.id, membership.user_id
        FROM playlist_memberships membership JOIN streaming_connections connection ON connection.id = membership.streaming_connection_id
        WHERE membership.group_playlist_id = $1 AND membership.status = 'active' AND connection.status = 'active'
          AND membership.external_playlist_id IS NOT NULL AND membership.last_synced_sequence < $2`,
      [event.group_playlist_id, event.sequence_number]);
      for (const member of members.rows) {
        await client.query(`INSERT INTO sync_delivery_logs (id, playlist_event_id, user_id, status)
          VALUES ($1, $2, $3, 'pending') ON CONFLICT (playlist_event_id, user_id) DO NOTHING`, [randomUUID(), eventId, member.user_id]);
        await this.queue.sendInTransaction(client, 'deliver-membership', { membershipId: member.id, throughSequence: event.sequence_number });
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
