import { describe, expect, it } from 'vitest';
import { hubLink, hubTeamsPage } from './hub-links';

describe('hubLink', () => {
  it('leaves the base untouched with no return target', () => {
    expect(hubLink('https://account.example.test')).toBe('https://account.example.test');
  });

  it('encodes the return target once, as a query parameter', () => {
    expect(hubLink('https://account.example.test/', 'https://tool.example.test/members')).toBe(
      'https://account.example.test/?return_to=https%3A%2F%2Ftool.example.test%2Fmembers'
    );
    expect(hubLink('https://account.example.test/orgs', 'https://tool.example.test/a b')).toBe(
      'https://account.example.test/orgs?return_to=https%3A%2F%2Ftool.example.test%2Fa%20b'
    );
  });

  it('appends to an existing query string instead of starting a second one', () => {
    expect(
      hubLink('https://account.example.test/no-access?client_id=tool-1', 'https://tool.example.test/')
    ).toBe(
      'https://account.example.test/no-access?client_id=tool-1&return_to=https%3A%2F%2Ftool.example.test%2F'
    );
  });
});

describe('hubTeamsPage', () => {
  it("joins the Teams page onto the hub's root, with or without its trailing slash", () => {
    expect(hubTeamsPage('https://account.example.test')).toBe('https://account.example.test/teams');
    expect(hubTeamsPage('https://account.example.test/')).toBe('https://account.example.test/teams');
  });

  it("names one team's page by its hub id, encoded", () => {
    expect(hubTeamsPage('https://account.example.test', 'team 1')).toBe(
      'https://account.example.test/teams/team%201'
    );
    expect(hubTeamsPage('https://account.example.test', null)).toBe('https://account.example.test/teams');
  });

  it('carries the return target through hubLink like any hub page', () => {
    expect(
      hubLink(hubTeamsPage('https://account.example.test', 't1'), 'https://tool.example.test/teams')
    ).toBe('https://account.example.test/teams/t1?return_to=https%3A%2F%2Ftool.example.test%2Fteams');
  });
});
