import type {
  ProviderConnectionDroppedEvent,
  ProviderExecutionEvent,
} from '@/core/execution';
import {
  AutoResumeController,
  type AutoResumeDeps,
  extractHotFocus,
  resetAutoResumeSchedulingLock,
} from '@/features/chat/tabs/AutoResumeController';

function createDeps(overrides: Partial<AutoResumeDeps> = {}): {
  deps: AutoResumeDeps;
  sent: string[];
  log: string[];
  notices: string[];
} {
  const sent: string[] = [];
  const log: string[] = [];
  const notices: string[] = [];
  const deps: AutoResumeDeps = {
    isEnabled: () => true,
    canStartTurn: () => true,
    sendResume: async (content) => {
      sent.push(content);
      return true;
    },
    readHotMd: async () => '',
    appendLog: async (line) => {
      log.push(line);
    },
    notice: (message) => {
      notices.push(message);
    },
    ...overrides,
  };
  return { deps, sent, log, notices };
}

function droppedEvent(message = 'API Error: connection reset'): ProviderConnectionDroppedEvent {
  return {
    type: 'connection_dropped',
    category: 'transport',
    message,
  } as ProviderConnectionDroppedEvent;
}

function turnCompleted(): ProviderExecutionEvent {
  return { type: 'turn_completed', reason: 'completed' } as ProviderExecutionEvent;
}

const HOT_MD = `# Hot Cache

## 当前焦点

**fork 实施**：用户定案 fork 路线。探索完成。
**下一步**：① npm install 待批准 ② 哨兵退役待拍板

## 待办项

- [ ] 事项
`;

describe('AutoResumeController backoff state machine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    resetAutoResumeSchedulingLock();
    jest.useRealTimers();
    jest.clearAllTimers();
  });

  it('schedules a resume after the first drop with 30s backoff', async () => {
    const { deps, sent, log, notices } = createDeps({
      readHotMd: async () => HOT_MD,
    });
    const controller = new AutoResumeController(deps);
    controller.handleConnectionDropped(droppedEvent());
    expect(sent).toHaveLength(0);
    expect(notices[0]).toContain('30');
    expect(log[0]).toContain('DROP #1');

    jest.advanceTimersByTime(29_000);
    expect(sent).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('继续推进');
    expect(sent[0]).toContain('第 1 次');
    controller.dispose();
  });

  it('resets the failure count after the wake turn completes', async () => {
    const { deps, sent } = createDeps();
    const controller = new AutoResumeController(deps);
    controller.handleConnectionDropped(droppedEvent());
    await jest.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);

    controller.handleExecutionEvent(turnCompleted());
    controller.handleConnectionDropped(droppedEvent('second drop'));
    jest.advanceTimersByTime(29_000);
    expect(sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('第 1 次');
    controller.dispose();
  });

  it('keeps accumulating when the wake turn drops again before turn_completed is consumed', async () => {
    const { deps, sent, log } = createDeps();
    const controller = new AutoResumeController(deps);
    controller.handleConnectionDropped(droppedEvent('first'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);

    // 唤醒回合又断连：connection_dropped 同步先到（调度 60s），
    // turn_completed 随后被异步消费 —— 不得清零。
    controller.handleConnectionDropped(droppedEvent('wake turn dropped'));
    expect(log[1]).toContain('DROP #2');
    controller.handleExecutionEvent(turnCompleted());
    controller.handleConnectionDropped(droppedEvent('third'));

    // 第三轮应显示第 3 次（未被打断清零）
    jest.advanceTimersByTime(120_000 + 60_000);
    expect(log.some(line => line.includes('DROP #3'))).toBe(true);
    controller.dispose();
  });

  it('stops with a notice after three consecutive drops', () => {
    const { deps, notices } = createDeps();
    const controller = new AutoResumeController(deps);
    controller.handleConnectionDropped(droppedEvent());
    controller.handleConnectionDropped(droppedEvent());
    controller.handleConnectionDropped(droppedEvent());
    controller.handleConnectionDropped(droppedEvent());
    expect(notices.some(n => n.includes('停止'))).toBe(true);
    controller.dispose();
  });

  it('reschedules when the tab cannot take input, then stops after repeated failure', async () => {
    const { deps, sent } = createDeps({ canStartTurn: () => false });
    const controller = new AutoResumeController(deps);
    controller.handleConnectionDropped(droppedEvent());
    jest.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(0);
    // 3 次重调度（30s each），第 4 次判定停止
    jest.advanceTimersByTime(90_000);
    jest.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(0);
    controller.dispose();
  });

  it('does nothing when disabled or disposed', () => {
    const { deps, sent, log } = createDeps({ isEnabled: () => false });
    const controller = new AutoResumeController(deps);
    controller.handleConnectionDropped(droppedEvent());
    jest.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(0);
    expect(log).toHaveLength(0);
    controller.dispose();
  });

  it('injects the hot.md focus hint into the resume message', async () => {
    const { deps, sent } = createDeps({ readHotMd: async () => HOT_MD });
    const controller = new AutoResumeController(deps);
    controller.handleConnectionDropped(droppedEvent());
    await jest.advanceTimersByTimeAsync(30_000);
    expect(sent[0]).toContain('fork 实施');
    expect(sent[0]).toContain('npm install 待批准');
    controller.dispose();
  });
});

describe('extractHotFocus', () => {
  it('extracts focus and next-step from a hot.md', () => {
    const hint = extractHotFocus(HOT_MD);
    expect(hint).not.toBeNull();
    expect(hint!.focus).toContain('fork 实施');
    expect(hint!.focus).not.toContain('**');
    expect(hint!.next).toContain('npm install');
  });

  it('returns null when the section is absent', () => {
    expect(extractHotFocus('# No focus here')).toBeNull();
  });

  it('filters table separator lines from markdown', () => {
    const md = '## 当前焦点\n\ntext\n| --- | --- |\n**col**\n\n## 其他\n';
    const hint = extractHotFocus(md);
    expect(hint).not.toBeNull();
    expect(hint!.focus).not.toContain('|');
  });
});