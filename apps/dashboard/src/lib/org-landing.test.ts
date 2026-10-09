import { describe, expect, it } from 'vitest';
import { readOrgLanding, withoutOrgLanding } from './org-landing';

const ORG = '2f1c3a9e-5b7d-4c21-9e0a-7b8c9d0e1f2a';

describe('readOrgLanding (the organization a hub tool card names, PRDCT-3321)', () => {
  it('reads a well-formed organization id', () => {
    expect(readOrgLanding(new URLSearchParams(`org=${ORG}`))).toBe(ORG);
    expect(readOrgLanding(new URLSearchParams(`org=${ORG.toUpperCase()}`))).toBe(ORG.toUpperCase());
  });

  it('reads nothing from an absent, empty or malformed value', () => {
    expect(readOrgLanding(new URLSearchParams(''))).toBeNull();
    expect(readOrgLanding(new URLSearchParams('org='))).toBeNull();
    expect(readOrgLanding(new URLSearchParams('org=my-org'))).toBeNull();
    expect(readOrgLanding(new URLSearchParams(`org=${ORG}x`))).toBeNull();
    expect(readOrgLanding(new URLSearchParams("org=' OR 1=1"))).toBeNull();
  });
});

describe('withoutOrgLanding', () => {
  it('strips the landing and keeps the path, the other parameters and the fragment', () => {
    expect(withoutOrgLanding(`/?org=${ORG}`)).toBe('/');
    expect(withoutOrgLanding(`/items/abc?tab=notes&org=${ORG}#row-3`)).toBe('/items/abc?tab=notes#row-3');
    expect(withoutOrgLanding(`/items?org=${ORG}&tab=notes`)).toBe('/items?tab=notes');
  });

  it('hands back an address without a landing untouched', () => {
    expect(withoutOrgLanding('/')).toBe('/');
    expect(withoutOrgLanding('/items/abc?tab=notes')).toBe('/items/abc?tab=notes');
  });
});
