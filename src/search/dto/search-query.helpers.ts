import { TransformFnParams } from 'class-transformer';

export function toOptionalNumber({
  value,
}: TransformFnParams): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return Number(value);
}

export function toOptionalString({
  value,
}: TransformFnParams): string | undefined {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
