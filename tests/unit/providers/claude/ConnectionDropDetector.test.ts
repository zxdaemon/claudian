import {
  appendTextTail,
  isConnectionDropMessage,
  looksLikeApiError,
  tailEndsWithConnectionDrop,
} from '@/providers/claude/execution/ConnectionDropDetector';

describe('looksLikeApiError', () => {
  it('matches the API Error prefix with leading whitespace', () => {
    expect(looksLikeApiError('API Error: something broke')).toBe(true);
    expect(looksLikeApiError('  \nAPI Error: something broke')).toBe(true);
  });

  it('rejects messages without the prefix', () => {
    expect(looksLikeApiError('Something went wrong')).toBe(false);
    expect(looksLikeApiError('The API Error: looks similar')).toBe(false);
  });
});

describe('isConnectionDropMessage', () => {
  it('matches the observed disconnect signature (#5/#6)', () => {
    expect(isConnectionDropMessage(
      'API Error: 代理或上游连接读取失败，部分响应已成功传输',
    )).toBe(true);
    expect(isConnectionDropMessage(
      'API Error: connection reset while reading response, partial response transferred',
    )).toBe(true);
  });

  it('matches ECONNRESET / socket hang up variants', () => {
    expect(isConnectionDropMessage('API Error: socket hang up')).toBe(true);
    expect(isConnectionDropMessage('API Error: read ECONNRESET')).toBe(true);
  });

  it('rejects non-connection API errors (HTTP-level retryable)', () => {
    expect(isConnectionDropMessage('API Error: 429 Too Many Requests')).toBe(false);
    expect(isConnectionDropMessage('API Error: 500 internal server error')).toBe(false);
    expect(isConnectionDropMessage('API Error: invalid_request_error unknown field')).toBe(false);
  });

  it('rejects messages without API Error prefix', () => {
    expect(isConnectionDropMessage('connection reset by peer')).toBe(false);
    expect(isConnectionDropMessage('代理或上游连接读取失败')).toBe(false);
  });
});

describe('appendTextTail', () => {
  it('accumulates deltas and truncates to the window', () => {
    const first = appendTextTail('', 'hello ');
    expect(first).toBe('hello ');
    const second = appendTextTail(first, 'world');
    expect(second).toBe('hello world');

    const big = 'x'.repeat(5000);
    const tail = appendTextTail('', big);
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(tail).toBe(big.slice(-4096));
  });
});

describe('tailEndsWithConnectionDrop', () => {
  it('detects a disconnect message ending the turn tail', () => {
    const tail = appendTextTail('', 'normal text before. ');
    const withError = appendTextTail(
      tail,
      'API Error: 代理或上游连接读取失败，部分响应已成功传输',
    );
    expect(tailEndsWithConnectionDrop(withError)).toBe(true);
  });

  it('finds the last API Error occurrence when earlier text contains one', () => {
    const tail = 'user asked about API Error: something '
      + 'then the real tail is API Error: 代理或上游连接读取失败，部分响应已成功传输';
    expect(tailEndsWithConnectionDrop(tail)).toBe(true);
  });

  it('returns false for a clean tail', () => {
    expect(tailEndsWithConnectionDrop('all done, no errors here')).toBe(false);
  });

  it('returns false when the last API Error is not connection-level', () => {
    expect(tailEndsWithConnectionDrop('API Error: 429 Too Many Requests')).toBe(false);
  });
});
