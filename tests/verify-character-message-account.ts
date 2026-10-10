import { describe, it, expect } from 'vitest';
import { characterMessageAccount } from '../packages/renderer/src/session/ServerAccountName.js';
import { buildCharacterCreate, buildCharacterDelete, buildCharacterEnterWorld } from '../packages/network/src/MessageSerializer.js';

// ACE drops CharacterCreate / EnterWorld / Delete silently unless the account
// string equals session.Account (stored lowercased). A typed "abmovA1" never
// created a character; the CharacterList's "abmova1" does.
describe('character messages carry the server\'s account name', () => {
  it('prefers the CharacterList name, else the typed name lowercased', () => {
    expect(characterMessageAccount('abmova1', 'abmovA1')).toBe('abmova1');
    expect(characterMessageAccount(null, 'Aerfalle')).toBe('aerfalle');
    expect(characterMessageAccount('', 'MiXeD')).toBe('mixed');
  });

  it('the built messages contain exactly that account string', () => {
    const acct = characterMessageAccount('abmova1', 'abmovA1');
    const ascii = (b: Uint8Array) => Buffer.from(b).toString('latin1');
    expect(ascii(buildCharacterEnterWorld(0x50000001, acct))).toContain('abmova1');
    expect(ascii(buildCharacterEnterWorld(0x50000001, acct))).not.toContain('abmovA1');
    expect(ascii(buildCharacterDelete(acct, 0))).toContain('abmova1');
  });
});
