import {
  appendTextTail,
  isApiErrorAnnotatedMessage,
  isConnectionDropMessage,
  isServerErrorFamilyMessage,
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

  it('matches the English mid-response variant (server_error family)', () => {
    expect(isConnectionDropMessage(
      'API Error: Connection lost mid-response. The response above may be incomplete.',
    )).toBe(true);
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

describe('isApiErrorAnnotatedMessage', () => {
  it('recognizes the SDK annotation regardless of error text language', () => {
    expect(isApiErrorAnnotatedMessage({ isApiErrorMessage: true })).toBe(true);
  });

  it('rejects messages without the annotation', () => {
    expect(isApiErrorAnnotatedMessage({ isApiErrorMessage: false })).toBe(false);
    expect(isApiErrorAnnotatedMessage({})).toBe(false);
    expect(isApiErrorAnnotatedMessage(null)).toBe(false);
    expect(isApiErrorAnnotatedMessage(undefined)).toBe(false);
    expect(isApiErrorAnnotatedMessage('true')).toBe(false);
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

  it('rejects a quoted signature mid-report followed by long body text', () => {
    // 自引用误报：助手报告复述断连签名，其后还有大量正文。
    const report = '取证报告：断连签名为 API Error: 代理或上游连接读取失败，部分响应已成功传输。'
      + '后续正文。'.repeat(200);
    expect(tailEndsWithConnectionDrop(appendTextTail('', report))).toBe(false);
  });
});

describe('isServerErrorFamilyMessage', () => {
  it('matches raw server_error classification strings', () => {
    expect(isServerErrorFamilyMessage('server_error')).toBe(true);
    expect(isServerErrorFamilyMessage('Server error')).toBe(true);
    expect(isServerErrorFamilyMessage('Error: server_error (502)')).toBe(true);
  });

  it('matches API Error prefixed messages', () => {
    expect(isServerErrorFamilyMessage('API Error: Connection lost mid-response.')).toBe(true);
    expect(isServerErrorFamilyMessage('  \napi error: proxy failed')).toBe(true);
  });

  it('rejects ordinary provider messages', () => {
    expect(isServerErrorFamilyMessage('provider internal failure')).toBe(false);
    expect(isServerErrorFamilyMessage('server unavailable check configuration')).toBe(false);
    expect(isServerErrorFamilyMessage('')).toBe(false);
  });
});
