import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import fc from 'fast-check';
import jsf from 'json-schema-faker';
import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { fit } from '../src/fit.js';
import { profiles } from '../src/profiles.js';
import { UnfittableSchemaError } from '../src/types.js';
import type { JSONSchema, Profile } from '../src/types.js';
import { instanceArbitrary, schemaArbitrary } from './arbitrary.js';
import { narrow, noBounds, noRefs, noSiblings, permissive, shallow, variant } from './profiles.js';

const RUNS = Number(process.env['SCHEMA_FIT_RUNS'] ?? 200);

/**
 * Profiles that never drop a constraint the validator would have enforced, so
 * the soundness guarantee applies in full. See the README: a profile that turns
 * off a bounds group is asking `fit` to hand the provider a schema wider than
 * the original, and only the provider's own view of it stays sound.
 */
const soundProfiles: Profile[] = [
  profiles.openaiStrict,
  profiles.anthropic,
  profiles.gemini,
  permissive,
  noRefs,
  noSiblings,
  narrow,
  shallow,
  variant(permissive, { supports: { oneOf: false, anyOf: false, allOf: false, not: false } }),
  variant(permissive, { supports: { enum: false, const: false, patternProperties: false, tupleItems: false } }),
  variant(permissive, { rootMustBeObject: true, additionalPropertiesMustBeFalse: true, allPropertiesMustBeRequired: true }),
];

const allProfiles: Profile[] = [...soundProfiles, noBounds];

const soundProfile = fc.constantFrom(...soundProfiles);
const anyProfile = fc.constantFrom(...allProfiles);

const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });

function compile(schema: JSONSchema): ValidateFunction | undefined {
  try {
    return ajv.compile(structuredClone(schema) as object);
  } catch {
    return undefined;
  }
}

jsf.option({
  alwaysFakeOptionals: true,
  failOnInvalidTypes: false,
  failOnInvalidFormat: false,
  requiredOnly: false,
  useDefaultValue: false,
  fillProperties: false,
});

/** Instances drawn from the fitted schema itself, where the implication bites. */
function fakeInstances(schema: JSONSchema, count: number): unknown[] {
  const out: unknown[] = [];
  for (let index = 0; index < count; index++) {
    try {
      out.push(jsf.generate(structuredClone(schema) as never));
    } catch {
      // json-schema-faker gives up on plenty of valid schemas; that is fine,
      // the arbitrary instances still exercise the implication.
    }
  }
  return out;
}

function fitOrSkip(schema: JSONSchema, profile: Profile) {
  try {
    return fit(schema, profile);
  } catch (error) {
    // The one documented throw. Nothing to assert about a schema that cannot
    // be fitted at all.
    expect(error).toBeInstanceOf(UnfittableSchemaError);
    return undefined;
  }
}

describe('property 1: soundness', () => {
  it('an instance the fitted schema accepts, the original accepts too', () => {
    fc.assert(
      fc.property(schemaArbitrary(), soundProfile, fc.array(instanceArbitrary, { maxLength: 6 }), (schema, profile, instances) => {
        const result = fitOrSkip(schema, profile);
        if (!result) return;

        const original = compile(schema);
        if (!original) return; // the input was not a schema ajv can compile
        const fitted = compile(result.schema);
        expect(fitted, 'fit produced a schema ajv cannot compile').toBeDefined();

        for (const instance of [...instances, ...fakeInstances(result.schema, 3)]) {
          if (fitted!(instance)) {
            expect(original(instance), `fitted accepted an instance the original rejected: ${JSON.stringify(instance)}`).toBe(true);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('holds for the hand-written cases too', () => {
    const cases: Array<[JSONSchema, unknown[]]> = [
      [{ type: 'object', properties: { a: { type: 'string' } }, required: [] }, [{}, { a: 'x' }, { a: 1 }, { b: 2 }]],
      [{ oneOf: [{ minimum: 1 }, { maximum: 5 }] }, [0, 3, 9, 'x']],
      [{ type: ['string', 'null'] }, [null, 'x', 1]],
      [{ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] }, [['a', 1], ['a'], [1, 'a']]],
      [{ type: 'object', patternProperties: { '^a': { type: 'number' } } }, [{ ab: 1 }, { ab: 'x' }, { z: 'x' }]],
    ];
    for (const profile of soundProfiles) {
      for (const [schema, instances] of cases) {
        const result = fitOrSkip(schema, profile);
        if (!result) continue;
        const original = compile(schema)!;
        const fitted = compile(result.schema)!;
        for (const instance of instances) {
          if (fitted(instance)) expect(original(instance)).toBe(true);
        }
      }
    }
  });
});

describe('property 2: conformance', () => {
  it('a fitted schema always passes check', () => {
    fc.assert(
      fc.property(schemaArbitrary(), anyProfile, (schema, profile) => {
        const result = fitOrSkip(schema, profile);
        if (!result) return;
        const after = check(result.schema, profile);
        expect(after.violations, `fit left violations: ${JSON.stringify(after.violations)}`).toEqual([]);
        expect(after.ok).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('property 3: idempotence', () => {
  it('fitting a fitted schema changes nothing', () => {
    fc.assert(
      fc.property(schemaArbitrary(), anyProfile, (schema, profile) => {
        const once = fitOrSkip(schema, profile);
        if (!once) return;
        const twice = fit(once.schema, profile);
        expect(twice.changes).toEqual([]);
        expect(twice.schema).toEqual(once.schema);
        expect(twice.lossless).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('property 4: identity', () => {
  it('a schema that already conforms is handed back untouched', () => {
    fc.assert(
      fc.property(schemaArbitrary(), anyProfile, (schema, profile) => {
        if (!check(schema, profile).ok) return;
        const result = fit(schema, profile);
        expect(result.changes).toEqual([]);
        expect(result.schema).toEqual(schema);
        expect(result.lossless).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('fitted schemas are the identity case, and there are plenty of them', () => {
    let conforming = 0;
    fc.assert(
      fc.property(schemaArbitrary(), anyProfile, (schema, profile) => {
        const once = fitOrSkip(schema, profile);
        if (!once) return;
        conforming++;
        const again = fit(once.schema, profile);
        expect(again.schema).toBe(once.schema);
      }),
      { numRuns: RUNS },
    );
    expect(conforming).toBeGreaterThan(RUNS / 2);
  });
});

describe('property 5: purity', () => {
  it('neither function touches its input', () => {
    fc.assert(
      fc.property(schemaArbitrary(), anyProfile, (schema, profile) => {
        const before = structuredClone(schema);
        deepFreeze(schema);
        expect(() => check(schema, profile)).not.toThrow();
        try {
          fit(schema, profile);
        } catch (error) {
          expect(error).toBeInstanceOf(UnfittableSchemaError);
        }
        expect(schema).toEqual(before);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('property 6: determinism', () => {
  it('the same call twice gives the same answer', () => {
    fc.assert(
      fc.property(schemaArbitrary(), anyProfile, (schema, profile) => {
        expect(check(schema, profile)).toEqual(check(schema, profile));
        const first = fitOrSkip(schema, profile);
        if (!first) return;
        const second = fit(schema, profile);
        expect(second.schema).toEqual(first.schema);
        expect(second.changes).toEqual(first.changes);
        expect(second.lossless).toBe(first.lossless);
      }),
      { numRuns: RUNS },
    );
  });

  it('violations come back in a stable order', () => {
    fc.assert(
      fc.property(schemaArbitrary(), anyProfile, (schema, profile) => {
        const { violations } = check(schema, profile);
        const sorted = [...violations].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0,
        );
        expect(violations).toEqual(sorted);
      }),
      { numRuns: RUNS },
    );
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
