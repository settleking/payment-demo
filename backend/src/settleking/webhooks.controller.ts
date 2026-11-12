import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';

import { WebhooksService } from './webhooks.service';

/**
 * Receives SettleKing webhooks. The signature is checked against the raw request bytes (enabled
 * with {@code rawBody: true} in main.ts), so the body must not be re-serialized before checking.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('settleking')
  @HttpCode(200)
  async settleking(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    const result = await this.webhooks.receive(request.rawBody, headers);
    return { received: true, ...result };
  }
}
