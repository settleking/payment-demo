import { HttpException, HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * A small per-address limit on the public write routes (bookings, plans, memberships): enough for a
 * sample to stop one visitor flooding SettleKing with checkouts or agreements through it. A real
 * site would use its gateway's limits or a shared store.
 */
@Injectable()
export class ThrottleMiddleware implements NestMiddleware {
  static readonly LIMIT = 30;
  static readonly WINDOW_MS = 60_000;
  private readonly hits = new Map<string, number[]>();

  use(request: Request, _response: Response, next: NextFunction): void {
    if (request.method === 'GET') return next();
    const key = request.ip ?? 'unknown';
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < ThrottleMiddleware.WINDOW_MS);
    if (recent.length >= ThrottleMiddleware.LIMIT) {
      throw new HttpException('Too many requests. Wait a minute and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    next();
  }
}
