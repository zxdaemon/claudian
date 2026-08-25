import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { StreamChunk } from '@/core/types/chat';
import { shouldDedupTextChunk } from '@/providers/claude/execution/ClaudeExecutionEventNormalizer';

/** 构造最小 assistant SDKMessage（仅 helper 用到的字段）。 */
function assistantMessage(): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [] },
  } as unknown as SDKMessage;
}

function textChunk(content: string): StreamChunk {
  return { type: 'text', content };
}

describe('shouldDedupTextChunk', () => {
  it('dedups ordinary assistant-message text when text was streamed', () => {
    expect(shouldDedupTextChunk(
      assistantMessage(),
      textChunk('普通正文'),
      true,
    )).toBe(true);
  });

  it('does not dedup when no text was streamed in this turn', () => {
    expect(shouldDedupTextChunk(
      assistantMessage(),
      textChunk('普通正文'),
      false,
    )).toBe(false);
  });

  it('does not dedup non-assistant messages', () => {
    const user = { type: 'user', message: { role: 'user' } } as unknown as SDKMessage;
    expect(shouldDedupTextChunk(user, textChunk('x'), true)).toBe(false);
  });

  it('does not dedup non-text chunks', () => {
    const thinking: StreamChunk = { type: 'thinking', content: 'thinking...' };
    expect(shouldDedupTextChunk(assistantMessage(), thinking, true)).toBe(false);
  });

  it('forces through API Error text even when text was streamed (ARCD false-negative fix)', () => {
    // SDK 流中断后合成的断连尾消息：文本从未流式传输，但 sawStreamText 已置位。
    expect(shouldDedupTextChunk(
      assistantMessage(),
      textChunk('API Error: 代理或上游连接读取失败，部分响应已成功传输'),
      true,
    )).toBe(false);
  });
});
