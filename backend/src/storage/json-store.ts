import { Injectable, OnModuleInit } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppConfig } from '../config';
import type { Booking } from '../bookings/booking.model';
import type { Member } from '../memberships/member.model';
import type { Subscription } from '../plans/plan.model';

interface Data {
  bookings: Booking[];
  /** Monthly members and their saved cards (SettleKing ids, brand and last 4 only). */
  members: Member[];
  /** Webhook ids already handled, newest first; deliveries are retried, so repeats happen. */
  /** Plans: SettleKing payment agreements (subscriptions and pay-as-you-dance). */
  plans: Subscription[];
  webhookIds: string[];
  nextReference: number;
}

const MAX_WEBHOOK_IDS = 500;

/**
 * A tiny file-backed store, enough for a sample: the state lives in {@code data/db.json}, each
 * change is written atomically and changes run one at a time. Use a real database in production.
 */
@Injectable()
export class JsonStore implements OnModuleInit {
  private data: Data = { bookings: [], members: [], plans: [], webhookIds: [], nextReference: 1001 };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly config: AppConfig) {
    this.file = join(config.dataDir, 'db.json');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Data>;
      this.data = {
        bookings: stored.bookings ?? [],
        members: stored.members ?? [],
        plans: stored.plans ?? [],
        webhookIds: stored.webhookIds ?? [],
        nextReference: stored.nextReference ?? 1001,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.flush();
    }
  }

  bookings(): readonly Booking[] {
    return this.data.bookings;
  }

  booking(id: string): Booking | undefined {
    return this.data.bookings.find((booking) => booking.id === id);
  }

  bookingByCheckout(checkoutSessionId: string): Booking | undefined {
    return this.data.bookings.find((booking) => booking.checkoutSessionId === checkoutSessionId);
  }

  members(): readonly Member[] {
    return this.data.members;
  }

  member(id: string): Member | undefined {
    return this.data.members.find((member) => member.id === id);
  }

  memberByEmail(email: string): Member | undefined {
    return this.data.members.find((member) => member.email === email);
  }

  plans(): readonly Subscription[] {
    return this.data.plans;
  }

  plan(id: string): Subscription | undefined {
    return this.data.plans.find((plan) => plan.id === id);
  }

  hasWebhook(webhookId: string): boolean {
    return this.data.webhookIds.includes(webhookId);
  }

  /** Runs {@code change} against the live data, then persists it; changes never interleave. */
  update<T>(change: (data: Data) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const result = change(this.data);
      this.data.webhookIds = this.data.webhookIds.slice(0, MAX_WEBHOOK_IDS);
      await this.flush();
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async flush(): Promise<void> {
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data, null, 2));
    await rename(temporary, this.file);
  }
}
