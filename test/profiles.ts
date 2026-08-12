import type { Profile } from '../src/types.js';
import { profiles } from '../src/profiles.js';

/** A profile with a few fields changed, for exercising rules the shipped three never hit. */
export function variant(base: Profile, overrides: Partial<Omit<Profile, 'supports'>> & { supports?: Partial<Profile['supports']> }): Profile {
  return {
    ...base,
    ...overrides,
    supports: { ...base.supports, ...(overrides.supports ?? {}) },
  };
}

export const permissive: Profile = {
  id: 'permissive',
  rootMustBeObject: false,
  additionalPropertiesMustBeFalse: false,
  allPropertiesMustBeRequired: false,
  refs: 'internal',
  supports: {
    oneOf: true,
    anyOf: true,
    allOf: true,
    not: true,
    enum: true,
    const: true,
    patternProperties: true,
    additionalItems: true,
    tupleItems: true,
    formats: 'all',
    numericBounds: true,
    stringBounds: true,
    arrayBounds: true,
    defaults: true,
    nullableViaType: true,
  },
  maxDepth: null,
  maxProperties: null,
  unknownKeywords: 'keep',
};

export const noSiblings = variant(permissive, { id: 'no-siblings', refs: 'internal-no-siblings' });
export const noRefs = variant(permissive, { id: 'no-refs', refs: 'none' });
export const shallow = variant(permissive, { id: 'shallow', maxDepth: 2 });
export const narrow = variant(permissive, { id: 'narrow', maxProperties: 2 });
export const noBounds = variant(permissive, {
  id: 'no-bounds',
  supports: { numericBounds: false, stringBounds: false, arrayBounds: false, defaults: false },
});

export const shipped = [profiles.openaiStrict, profiles.anthropic, profiles.gemini];
