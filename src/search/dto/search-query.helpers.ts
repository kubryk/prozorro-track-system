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

export function toOptionalStringArray({
  value,
}: TransformFnParams): string[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .flatMap((entry) =>
      typeof entry === 'string' ? entry.split(',') : [String(entry)],
    )
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  return normalized.length > 0 ? normalized : undefined;
}
