import { describe, expect, it } from 'vitest';
import { deckMasterPath, deckMasterUrl } from '../src/index.js';

/**
 * The master route (PRDCT-2280): one path builder shared by the dashboard
 * route, the CLI's push answer and the MCP tool answer, so none can drift.
 */

const ID = '11111111-1111-1111-1111-111111111111';

describe('deckMasterPath', () => {
  it('is /decks/{id}/present', () => {
    expect(deckMasterPath(ID)).toBe(`/decks/${ID}/present`);
  });

  it('percent-encodes an id that is not a plain segment', () => {
    expect(deckMasterPath('a/b?c')).toBe('/decks/a%2Fb%3Fc/present');
  });
});

describe('deckMasterUrl', () => {
  it('joins the base and the path', () => {
    expect(deckMasterUrl('https://slides.example.com', ID)).toBe(
      `https://slides.example.com/decks/${ID}/present`
    );
  });

  it('drops trailing slashes on the base so both spellings compose the same URL', () => {
    expect(deckMasterUrl('https://slides.example.com/', ID)).toBe(
      deckMasterUrl('https://slides.example.com', ID)
    );
    expect(deckMasterUrl('http://localhost:3000//', ID)).toBe(`http://localhost:3000/decks/${ID}/present`);
  });
});
