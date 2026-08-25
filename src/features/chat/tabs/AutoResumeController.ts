/**
 * ARCD（Auto-Resume on Connection Drop）自动唤醒控制器（fork 特性）。
 *
 * 职责：收到 provider 的 connection_dropped 会话事件后，按退避表
 * （30/60/120s，≥3 次停止）调度一次"继续"输入；恢复提示内容取自
 * vault `_meta/hot.md` 的当前焦点段。唤醒回合正常完成（turn_completed）
 * 即清零失败计数。
 *
 * 注入 deps 以便单测（不依赖 Obsidian/网络真实环境）。
 */

import type {
  ProviderConnectionDroppedEvent,
  ProviderExecutionEvent,
} from '../../../core/execution';
import { nextBackoffDelaySeconds } from '../../../core/execution/autoResumeBackoff';

export interface AutoResumeDeps {
  /** settings 开关是否启用（fork 版 autoResumeEnabled）。 */
  isEnabled: () => boolean;
  /** 当前 tab 是否接受新输入（TabSession.acceptsIntents）。 */
  canStartTurn: () => boolean;
  /** 提交恢复消息；返回是否真正发出（未发出时控制器会重新调度）。 */
  sendResume: (content: string) => Promise<boolean>;
  /** 读取 vault `_meta/hot.md` 全文。 */
  readHotMd: () => Promise<string>;
  /** 追加一行恢复日志。 */
  appendLog: (line: string) => Promise<void>;
  /** UI 通知。 */
  notice: (message: string) => void;
}

/** 同一时刻只允许一个 tab 的控制器处于唤醒调度中（hot.md 提示是全局的）。 */
let schedulingController: AutoResumeController | null = null;

/**
 * 释放模块级单飞锁。仅供测试（jest 用例间隔离）与插件卸载场景使用。
 */
export function resetAutoResumeSchedulingLock(): void {
  schedulingController = null;
}

export class AutoResumeController {
  private dropsInARow = 0;
  private stopped = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingFire = false;
  private rescheduleCount = 0;

  constructor(private readonly deps: AutoResumeDeps) {}

  /** 处理 connection_dropped 会话事件。 */
  handleConnectionDropped(event: ProviderConnectionDroppedEvent): void {
    if (this.disposed || !this.deps.isEnabled() || this.stopped) return;
    this.dropsInARow += 1;
    const delay = nextBackoffDelaySeconds(this.dropsInARow - 1);
    if (delay === null) {
      this.stopped = true;
      this.cancelTimer();
      this.deps.notice('ARCD：连续断连超过上限，自动唤醒已停止，请手动恢复');
      void this.deps.appendLog(`STOP: ${event.category} ${event.message}`);
      return;
    }
    this.schedule(delay, event);
  }

  /** 消费 requested 事件：唤醒回合正常完成即清零失败计数。 */
  handleExecutionEvent(event: ProviderExecutionEvent): void {
    if (this.disposed || this.dropsInARow === 0) return;
    if (event.type !== 'turn_completed') return;
    // 唤醒回合若再次断连，connection_dropped（同步通道）会先于本事件
    // 调度新 timer——此时不清零，保留累计计数。
    if (this.timer !== null || this.pendingFire) return;
    const recovered = this.dropsInARow;
    this.dropsInARow = 0;
    this.rescheduleCount = 0;
    this.deps.notice('ARCD：会话已恢复');
    void this.deps.appendLog(`RESUMED after ${recovered} drop(s)`);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    if (schedulingController === this) schedulingController = null;
  }

  private schedule(delaySeconds: number, event: ProviderConnectionDroppedEvent): void {
    this.cancelTimer();
    // 单飞：已有其他 tab 在调度时，本 tab 静默放弃。
    if (schedulingController && schedulingController !== this) return;
    schedulingController = this;
    this.deps.notice(
      `ARCD：检测到连接中断，${delaySeconds}s 后自动恢复（第 ${this.dropsInARow} 次）`,
    );
    void this.deps.appendLog(
      `DROP #${this.dropsInARow} backoff=${delaySeconds}s: ${event.category} ${event.message}`,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delaySeconds * 1000);
  }

  private async fire(): Promise<void> {
    if (this.disposed || this.stopped) {
      if (schedulingController === this) schedulingController = null;
      return;
    }
    if (this.pendingFire) return;
    if (!this.deps.canStartTurn()) {
      // tab 尚不可接收输入：有限重调度，避免唤醒丢失。
      if (this.rescheduleCount >= 3) {
        this.stopped = true;
        this.deps.notice('ARCD：多次尝试均无法提交输入，自动唤醒停止');
        void this.deps.appendLog('STOP: cannot submit input');
        if (schedulingController === this) schedulingController = null;
        return;
      }
      this.rescheduleCount += 1;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.fire();
      }, 30_000);
      return;
    }
    this.rescheduleCount = 0;
    this.pendingFire = true;
    try {
      const hotMd = await this.deps.readHotMd();
      const hint = extractHotFocus(hotMd);
      const focus = hint?.focus ?? '继续推进当前任务';
      const next = hint?.next ? ` 下一步：${hint.next}` : '';
      const sent = await this.deps.sendResume(
        `[ARCD] 会话断连自动恢复（第 ${this.dropsInARow} 次）。请继续推进：${focus}。${next}`,
      );
      if (!sent && !this.disposed && !this.stopped) {
        this.rescheduleCount += 1;
        if (this.rescheduleCount >= 3) {
          this.stopped = true;
          this.deps.notice('ARCD：多次尝试均无法提交输入，自动唤醒停止');
          void this.deps.appendLog('STOP: cannot submit input');
          if (schedulingController === this) schedulingController = null;
          return;
        }
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.fire();
        }, 30_000);
      }
    } catch {
      // 读 hot.md 或发送失败不致命：停止本轮，等待下一次断连事件。
      this.deps.notice('ARCD：自动唤醒执行失败，等待下次断连事件');
      void this.deps.appendLog('ERROR: resume fire failed');
    } finally {
      this.pendingFire = false;
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface HotFocusHint {
  focus: string;
  next: string | null;
}

/**
 * 从 `_meta/hot.md` 全文中提取"当前焦点"段：
 *  - focus：段首焦点描述（去 markdown 强调符，压缩空白，≤800 字）
 *  - next：`**下一步**：` 之后的内容（≤600 字）
 */
export function extractHotFocus(hotMdContent: string): HotFocusHint | null {
  const section = hotMdContent.match(/##\s*当前焦点\s*\n+([\s\S]*?)(?=\n##\s|$)/);
  if (!section) return null;
  let body = section[1].trim();
  let next: string | null = null;
  const nextMatch = body.match(/\*\*下一步\*\*\s*[：:]\s*([\s\S]*)$/);
  if (nextMatch) {
    next = cleanText(nextMatch[1]).slice(0, 600) || null;
    body = body.slice(0, nextMatch.index).trim();
  }
  const focus = cleanText(body).slice(0, 800);
  if (!focus) return null;
  return { focus, next };
}

function cleanText(text: string): string {
  return text
    .replace(/[*_>`#]/g, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('|'))
    .join('\n')
    .trim();
}
