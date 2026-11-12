import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

import { AppConfig } from '../config';

/**
 * The studio admin API: a shared token in the {@code X-Admin-Token} header, set with ADMIN_TOKEN.
 * Enough for a sample; a real studio puts its staff behind proper sign-in.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.adminToken) {
      throw new ForbiddenException('The studio admin is turned off. Set ADMIN_TOKEN to use it.');
    }
    const given = context.switchToHttp().getRequest<Request>().header('x-admin-token') ?? '';
    // Compare digests so the check takes the same time whatever the token's length or content.
    if (!timingSafeEqual(digest(given), digest(this.config.adminToken))) {
      throw new UnauthorizedException('Wrong admin token');
    }
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
