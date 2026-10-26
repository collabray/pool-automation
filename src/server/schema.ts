/** Tiny strict schema validator. Unknown keys are rejected (mass-assignment protection). */
export class ValidationError extends Error {
  details: string[];
  constructor(details: string[]) { super('Validation failed'); this.details = details; }
}
export type Field =
  | { t: 'str'; min?: number; max?: number; re?: RegExp; opt?: boolean }
  | { t: 'int'; min?: number; max?: number; opt?: boolean }
  | { t: 'bool'; opt?: boolean }
  | { t: 'enum'; values: readonly string[]; opt?: boolean }
  | { t: 'obj'; shape: Record<string, Field>; opt?: boolean }
  | { t: 'free'; opt?: boolean } // arbitrary JSON object validated later by domain code (e.g. pricing)
  | { t: 'arr'; item: Field; max: number; opt?: boolean };

export const f = {
  str: (o: Omit<Extract<Field, { t: 'str' }>, 't'> = {}): Field => ({ t: 'str', ...o }),
  int: (o: Omit<Extract<Field, { t: 'int' }>, 't'> = {}): Field => ({ t: 'int', ...o }),
  bool: (o: { opt?: boolean } = {}): Field => ({ t: 'bool', ...o }),
  enum: (values: readonly string[], o: { opt?: boolean } = {}): Field => ({ t: 'enum', values, ...o }),
  obj: (shape: Record<string, Field>, o: { opt?: boolean } = {}): Field => ({ t: 'obj', shape, ...o }),
  free: (o: { opt?: boolean } = {}): Field => ({ t: 'free', ...o }),
  arr: (item: Field, max: number, o: { opt?: boolean } = {}): Field => ({ t: 'arr', item, max, ...o }),
};

function check(fl: Field, v: unknown, path: string, errs: string[]): void {
  if (v === undefined || v === null) { if (!fl.opt) errs.push(`${path}: required`); return; }
  switch (fl.t) {
    case 'str':
      if (typeof v !== 'string') return void errs.push(`${path}: must be a string`);
      if (v.length < (fl.min ?? 0)) errs.push(`${path}: too short`);
      if (v.length > (fl.max ?? 500)) errs.push(`${path}: too long`);
      if (fl.re && !fl.re.test(v)) errs.push(`${path}: invalid format`);
      return;
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return void errs.push(`${path}: must be an integer`);
      if (v < (fl.min ?? -Number.MAX_SAFE_INTEGER)) errs.push(`${path}: too small`);
      if (v > (fl.max ?? Number.MAX_SAFE_INTEGER)) errs.push(`${path}: too large`);
      return;
    case 'bool': if (typeof v !== 'boolean') errs.push(`${path}: must be true or false`); return;
    case 'enum': if (typeof v !== 'string' || !fl.values.includes(v)) errs.push(`${path}: must be one of ${fl.values.join(', ')}`); return;
    case 'free': if (typeof v !== 'object' || Array.isArray(v)) errs.push(`${path}: must be an object`); else if (JSON.stringify(v).length > 8000) errs.push(`${path}: too large`); return;
    case 'arr':
      if (!Array.isArray(v)) return void errs.push(`${path}: must be an array`);
      if (v.length > fl.max) return void errs.push(`${path}: too many items`);
      v.forEach((x, i) => check(fl.item, x, `${path}[${i}]`, errs));
      return;
    case 'obj': {
      if (typeof v !== 'object' || Array.isArray(v)) return void errs.push(`${path}: must be an object`);
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) if (!(k in fl.shape)) errs.push(`${path}.${k}: unknown field`);
      for (const [k, sub] of Object.entries(fl.shape)) check(sub, o[k], `${path}.${k}`, errs);
    }
  }
}
export function validate<T = Record<string, any>>(shape: Record<string, Field>, body: unknown): T {
  const errs: string[] = [];
  check({ t: 'obj', shape }, body ?? {}, 'body', errs);
  if (errs.length) throw new ValidationError(errs);
  return (body ?? {}) as T;
}
