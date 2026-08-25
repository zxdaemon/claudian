/**
 * ARCD（Auto-Resume on Connection Drop）自动唤醒退避策略（fork 特性）。
 *
 * 放 core 层：provider（检测端）与 features（唤醒端）共享，不违反
 * "features 不依赖具体 provider"的架构边界。
 */

/** 每轮自动唤醒的退避表（秒）。失败次数从 0 起。 */
export const AUTO_RESUME_BACKOFF_SECONDS: readonly number[] = Object.freeze([30, 60, 120]);

/** 最多自动唤醒次数（= 退避表长度）。超过后停止并通知用户。 */
export const AUTO_RESUME_MAX_ATTEMPTS = AUTO_RESUME_BACKOFF_SECONDS.length;

/** 给定连续失败次数（0 起），返回下一次自动唤醒的退避秒数；超上限或非法返回 null（应停止）。 */
export function nextBackoffDelaySeconds(consecutiveFailures: number): number | null {
  if (
    !Number.isInteger(consecutiveFailures)
    || consecutiveFailures < 0
    || consecutiveFailures >= AUTO_RESUME_BACKOFF_SECONDS.length
  ) {
    return null;
  }
  return AUTO_RESUME_BACKOFF_SECONDS[consecutiveFailures];
}