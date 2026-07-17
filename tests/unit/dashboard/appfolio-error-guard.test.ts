import { describe, it, expect } from 'vitest';
import { isApiErrorBody } from '../../../dashboard/src/lib/appfolio/stack-api.connector.js';

describe('isApiErrorBody', () => {
  it('detects an error key', () => {
    expect(isApiErrorBody({ error: 'Unsupported ContentType' })).toBe(true);
  });

  it('detects a capitalised Error key', () => {
    expect(isApiErrorBody({ Error: 'Something went wrong' })).toBe(true);
  });

  it('detects a message-only body (no results key)', () => {
    expect(isApiErrorBody({ message: 'Unauthorized' })).toBe(true);
  });

  it('does NOT flag a legitimate empty result set', () => {
    expect(isApiErrorBody({ results: [] })).toBe(false);
  });

  it('does NOT flag a legitimate empty result set with a message', () => {
    expect(isApiErrorBody({ results: [], message: 'No records found' })).toBe(false);
  });

  it('does NOT flag a paginated result with next_page_url', () => {
    expect(isApiErrorBody({ results: [{ id: 1 }], next_page_url: 'https://x.appfolio.com/next' })).toBe(false);
  });

  it('does NOT flag an array response (legacy format)', () => {
    expect(isApiErrorBody([{ id: 1 }])).toBe(false);
    expect(isApiErrorBody([])).toBe(false);
  });

  it('does NOT flag null/undefined/primitives', () => {
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody(undefined)).toBe(false);
    expect(isApiErrorBody('string')).toBe(false);
    expect(isApiErrorBody(42)).toBe(false);
  });

  it('flags error alongside results (error wins)', () => {
    expect(isApiErrorBody({ error: 'bad request', results: [] })).toBe(true);
  });
});
