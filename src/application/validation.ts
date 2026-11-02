import { InvalidRequestError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(field: string, value: unknown): void {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvalidRequestError(`${field} must be a UUID`);
  }
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InvalidRequestError(`${field} must be a string`);
  return value;
}

export function asObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidRequestError('body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}