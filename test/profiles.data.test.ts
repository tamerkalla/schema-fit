import { describe, expect, it } from 'vitest';
import { profiles } from '../src/profiles.js';
import type { Profile } from '../src/types.js';

/**
 * The profiles are the library's contract with three providers, so they are
 * pinned field by field. A change to any of them should have to be a deliberate
 * edit here as well as there — with a documentation link to back it up.
 */

const openaiStrict: Profile = {
  id: 'openai-strict',
  rootMustBeObject: true,
  additionalPropertiesMustBeFalse: true,
  allPropertiesMustBeRequired: true,
  refs: 'internal',
  supports: {
    oneOf: false,
    anyOf: true,
    allOf: false,
    not: false,
    enum: true,
    const: false,
    patternProperties: false,
    additionalItems: false,
    tupleItems: false,
    formats: ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'],
    numericBounds: true,
    stringBounds: true,
    arrayBounds: true,
    defaults: false,
    nullableViaType: true,
  },
  maxDepth: 10,
  maxProperties: 5000,
  unknownKeywords: 'strip',
};

const anthropic: Profile = {
  id: 'anthropic',
  rootMustBeObject: true,
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

const gemini: Profile = {
  id: 'gemini',
  rootMustBeObject: false,
  additionalPropertiesMustBeFalse: false,
  allPropertiesMustBeRequired: false,
  refs: 'none',
  supports: {
    oneOf: false,
    anyOf: true,
    allOf: false,
    not: false,
    enum: true,
    const: false,
    patternProperties: false,
    additionalItems: false,
    tupleItems: false,
    formats: ['date-time', 'date', 'time', 'duration', 'enum', 'float', 'double', 'int32', 'int64'],
    numericBounds: true,
    stringBounds: true,
    arrayBounds: true,
    defaults: true,
    nullableViaType: false,
  },
  maxDepth: null,
  maxProperties: null,
  unknownKeywords: 'strip',
};

describe('the shipped profiles', () => {
  it('ships exactly three', () => {
    expect(Object.keys(profiles).sort()).toEqual(['anthropic', 'gemini', 'openaiStrict']);
  });

  it('openaiStrict is exactly this', () => {
    expect(profiles.openaiStrict).toEqual(openaiStrict);
  });

  it('anthropic is exactly this', () => {
    expect(profiles.anthropic).toEqual(anthropic);
  });

  it('gemini is exactly this', () => {
    expect(profiles.gemini).toEqual(gemini);
  });

  it('gives every profile a distinct id', () => {
    const ids = Object.values(profiles).map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every bounds group on, since dropping one is the only rewrite that widens', () => {
    for (const profile of Object.values(profiles)) {
      expect(profile.supports.numericBounds, profile.id).toBe(true);
      expect(profile.supports.stringBounds, profile.id).toBe(true);
      expect(profile.supports.arrayBounds, profile.id).toBe(true);
    }
  });

  it('lists formats as a list or the word all, never anything else', () => {
    for (const profile of Object.values(profiles)) {
      const { formats } = profile.supports;
      if (formats !== 'all') {
        expect(Array.isArray(formats), profile.id).toBe(true);
        expect(formats.length, profile.id).toBeGreaterThan(0);
        expect(new Set(formats).size, profile.id).toBe(formats.length);
      }
    }
  });
});
