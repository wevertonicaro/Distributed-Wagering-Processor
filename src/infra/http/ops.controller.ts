import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { registry } from '../observability/metrics';
import type { HttpResponse } from './domain-exception.filter';

const timeout = (ms: number) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref());

async function check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
  try {
    await Promise.race([probe(), timeout(2000)]);
    return 'up';
  } catch {
    return 'down';
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: HttpResponse) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.ds.query('SELECT 1')),
      check(() =>
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: env.sqs.wagerQueueUrl, AttributeNames: ['QueueArn'] })),
      ),
    ]);
    const checks = { postgres, sqs };
    const ok = Object.values(checks).every((v) => v === 'up');
    if (!ok) res.status(503);
    return { status: ok ? 'ok' : 'unavailable', checks };
  }
}

@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', registry.contentType)
  metrics(): Promise<string> {
    return registry.metrics();
  }
}