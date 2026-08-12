import { describe, expect, it } from 'vitest';
import type { Effect, Polarity } from '../src/recorder.js';
import {
  Recorder,
  combinePolarity,
  flipPolarity,
  isPoison,
  narrows,
  permitted,
  poison,
  polarityFor,
} from '../src/recorder.js';
import { UnfittableSchemaError } from '../src/types.js';

describe('positions', () => {
  it('flips ordinary and flipped, and leaves the undecidable one alone', () => {
    expect(flipPolarity('positive')).toBe('negative');
    expect(flipPolarity('negative')).toBe('positive');
    expect(flipPolarity('invariant')).toBe('invariant');
  });

  it('flips under not, goes undecidable under if and oneOf, and passes through elsewhere', () => {
    expect(polarityFor('positive', 'not')).toBe('negative');
    expect(polarityFor('negative', 'not')).toBe('positive');
    expect(polarityFor('positive', 'if')).toBe('invariant');
    expect(polarityFor('negative', 'if')).toBe('invariant');
    expect(polarityFor('positive', 'oneOf')).toBe('invariant');
    expect(polarityFor('negative', 'oneOf')).toBe('invariant');
    for (const keyword of ['properties', 'anyOf', 'allOf', 'then', 'else', 'items', '$defs']) {
      expect(polarityFor('positive', keyword), keyword).toBe('positive');
      expect(polarityFor('negative', keyword), keyword).toBe('negative');
      expect(polarityFor('invariant', keyword), keyword).toBe('invariant');
    }
  });

  it('combines two positions into the weaker one', () => {
    expect(combinePolarity('positive', 'positive')).toBe('positive');
    expect(combinePolarity('negative', 'negative')).toBe('negative');
    expect(combinePolarity('invariant', 'invariant')).toBe('invariant');
    expect(combinePolarity('positive', 'negative')).toBe('invariant');
    expect(combinePolarity('negative', 'positive')).toBe('invariant');
    expect(combinePolarity('positive', 'invariant')).toBe('invariant');
  });
});

describe('what a rewrite is allowed to do where', () => {
  const cases: Array<[Effect, Polarity, boolean, boolean]> = [
    // effect, position, permitted, reported as narrowing
    ['exact', 'positive', true, false],
    ['exact', 'negative', true, false],
    ['exact', 'invariant', true, false],
    ['narrowing', 'positive', true, true],
    ['narrowing', 'negative', false, true],
    ['narrowing', 'invariant', false, true],
    ['widening', 'positive', true, false],
    ['widening', 'negative', true, true],
    ['widening', 'invariant', false, true],
  ];

  for (const [effect, polarity, allowed, narrowing] of cases) {
    it(`${effect} in a ${polarity} position is ${allowed ? 'allowed' : 'refused'}`, () => {
      expect(permitted(effect, polarity)).toBe(allowed);
      expect(narrows(effect, polarity)).toBe(narrowing);
    });
  }
});

describe('poison', () => {
  it('carries the rule that could not be applied', () => {
    const value = poison('no-enum');
    expect(isPoison(value)).toBe(true);
    expect(value.rule).toBe('no-enum');
  });

  it('is not confused with anything else', () => {
    expect(isPoison(null)).toBe(false);
    expect(isPoison(undefined)).toBe(false);
    expect(isPoison({})).toBe(false);
    expect(isPoison({ poison: false })).toBe(false);
    expect(isPoison(true)).toBe(false);
    expect(isPoison('poison')).toBe(false);
  });
});

describe('Recorder', () => {
  it('records what it is given', () => {
    const out = new Recorder();
    out.record('/a', 'rule', 'message', true);
    expect(out.changes).toEqual([{ path: '/a', rule: 'rule', message: 'message', narrowing: true }]);
  });

  it('rolls back to a mark', () => {
    const out = new Recorder();
    out.record('/a', 'r', 'm', false);
    const mark = out.mark();
    expect(mark).toBe(1);
    out.record('/b', 'r', 'm', false);
    out.record('/c', 'r', 'm', false);
    out.rollback(mark);
    expect(out.changes.map((change) => change.path)).toEqual(['/a']);
  });

  it('applies a rewrite the position allows, and reports how it narrows', () => {
    const out = new Recorder();
    expect(out.apply('/a', 'r', 'm', 'narrowing', 'positive')).toBe(true);
    expect(out.apply('/b', 'r', 'm', 'widening', 'negative')).toBe(true);
    expect(out.changes.map((change) => change.narrowing)).toEqual([true, true]);
  });

  it('refuses one the position does not, recording nothing', () => {
    const out = new Recorder();
    expect(out.apply('/a', 'r', 'm', 'narrowing', 'negative')).toBe(false);
    expect(out.apply('/a', 'r', 'm', 'widening', 'invariant')).toBe(false);
    expect(out.changes).toEqual([]);
  });
});

describe('UnfittableSchemaError', () => {
  it('is an Error carrying the path that could not be inlined', () => {
    const error = new UnfittableSchemaError('/$defs/node/$ref');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UnfittableSchemaError);
    expect(error.name).toBe('UnfittableSchemaError');
    expect(error.path).toBe('/$defs/node/$ref');
    expect(error.message).toContain('/$defs/node/$ref');
    expect(error.message).toContain('$ref');
  });

  it('names the root when the path is empty', () => {
    expect(new UnfittableSchemaError('').message).toContain('/');
  });

  it('takes a message of its own', () => {
    const error = new UnfittableSchemaError('/x', 'said so');
    expect(error.message).toBe('said so');
    expect(error.path).toBe('/x');
  });
});
