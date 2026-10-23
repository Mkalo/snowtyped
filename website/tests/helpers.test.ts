import { describe, expect, it } from 'vitest';
import { describeRelease } from '../src/release';
import { visibleSnippet } from '../src/snippet';

describe('describeRelease', () => {
  it('labels prerelease versions with their channel', () => {
    expect(describeRelease('0.1.0-alpha.1')).toEqual({
      version: '0.1.0-alpha.1',
      channel: 'alpha',
      stable: false,
    });
    expect(describeRelease('1.0.0-beta.0').channel).toBe('beta');
  });

  it('labels versions without a prerelease tag as stable', () => {
    expect(describeRelease('1.2.3')).toEqual({ version: '1.2.3', channel: 'stable', stable: true });
    expect(describeRelease('1.2.3+build.5').stable).toBe(true);
  });
});

describe('visibleSnippet', () => {
  it('hides setup above the cut marker', () => {
    expect(visibleSnippet("import { db } from './fixtures.js';\n// ---cut---\nawait db;\n")).toBe(
      'await db;',
    );
    expect(visibleSnippet('setup;\r\n// ---cut---\r\nshown;\r\n')).toBe('shown;');
  });

  it('shows the whole file without a marker', () => {
    expect(visibleSnippet('\nconst a = 1;\n')).toBe('const a = 1;');
  });
});
