import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { API_ROUTES } from '../src/index.js';

describe('API_ROUTES', () => {
  it('can be imported through the package export on Node 22', () => {
    const output = execFileSync(process.execPath, [
      '--input-type=module', '-e',
      'import { API_ROUTES } from "@zhidedeng/shared"; console.log(Object.keys(API_ROUTES).length);',
    ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    expect(output.trim()).toBe('33');
  });

  it('covers every method and path listed in docs/spec.md', () => {
    const spec = readFileSync(new URL('../../docs/spec.md', import.meta.url), 'utf8');
    const apiSection = spec.split('## API（')[1]!;
    const expected = [...new Set([...apiSection.matchAll(/`(GET|POST|PATCH|PUT|DELETE) (\/[^`?\s]*)/g)]
      .map(([, method, path]) => `${method} /api${path}`))];
    const actual = Object.values(API_ROUTES).map(({ method, path }) => `${method} ${path}`);

    expect(expected).toHaveLength(33);
    expect(actual.sort()).toEqual(expected.sort());
  });
});
