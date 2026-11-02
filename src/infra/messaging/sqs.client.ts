import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../config/env';

export const createSqsClient = () => new SQSClient({ region: env.aws.region, endpoint: env.aws.endpoint });