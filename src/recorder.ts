import type { Change } from './types.js';

/**
 * Where a subschema sits relative to the instances the whole schema accepts.
 *
 * Most positions are `positive`: making the subschema stricter makes the whole
 * schema stricter. Inside `not` the direction flips, so a rewrite that narrows
 * a subschema *widens* the schema around it — which would break the guarantee.
 * Inside `if` it does neither reliably, since the subschema only chooses which
 * of `then` and `else` applies.
 */
export type Polarity = 'positive' | 'negative' | 'invariant';

/** What a rewrite does to the set of instances the subschema accepts. */
export type Effect = 'exact' | 'narrowing' | 'widening';

export function flipPolarity(polarity: Polarity): Polarity {
  if (polarity === 'positive') return 'negative';
  if (polarity === 'negative') return 'positive';
  return 'invariant';
}

export function polarityFor(parent: Polarity, keyword: string): Polarity {
  if (keyword === 'not') return flipPolarity(parent);
  // `if` only picks which of `then` and `else` applies, and `oneOf` counts how
  // many options match — changing an option either way changes the count. In
  // both, only a rewrite that keeps the exact same values is safe.
  if (keyword === 'if' || keyword === 'oneOf') return 'invariant';
  return parent;
}

/** The weakest position that covers both, for a definition used in two places. */
export function combinePolarity(a: Polarity, b: Polarity): Polarity {
  return a === b ? a : 'invariant';
}

/** True when a rewrite with this effect keeps the whole schema sound. */
export function permitted(effect: Effect, polarity: Polarity): boolean {
  if (effect === 'exact') return true;
  if (polarity === 'positive') return true;
  if (polarity === 'negative') return effect === 'widening';
  return false;
}

/** Whether the rewrite rejects instances the original accepted. */
export function narrows(effect: Effect, polarity: Polarity): boolean {
  if (effect === 'exact') return false;
  if (polarity === 'positive') return effect === 'narrowing';
  return true;
}

/** Returned by a rewrite that cannot be applied where it stands. */
export interface Poison {
  readonly poison: true;
  readonly rule: string;
}

export function poison(rule: string): Poison {
  return { poison: true, rule };
}

export function isPoison(value: unknown): value is Poison {
  return typeof value === 'object' && value !== null && (value as Poison).poison === true;
}

export class Recorder {
  readonly changes: Change[] = [];

  mark(): number {
    return this.changes.length;
  }

  /** Forget everything recorded since `mark`, for a subtree being thrown away. */
  rollback(mark: number): void {
    this.changes.length = mark;
  }

  record(path: string, rule: string, message: string, narrowing: boolean): void {
    this.changes.push({ path, rule, message, narrowing });
  }

  /**
   * Record a rewrite if its effect is sound where it stands. Returns false when
   * it is not, which means the caller must give up and poison the position.
   */
  apply(path: string, rule: string, message: string, effect: Effect, polarity: Polarity): boolean {
    if (!permitted(effect, polarity)) return false;
    this.record(path, rule, message, narrows(effect, polarity));
    return true;
  }
}
