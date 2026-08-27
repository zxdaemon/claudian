/**
 * ARCD（Auto-Resume on Connection Drop）检测纯函数。
 *
 * 断连实证签名（claude-agent-sdk 连接级错误，见 #5/#6 事故）：
 *   "API Error: 代理或上游连接读取失败，部分响应已成功传输"
 * —— 即最后一条 assistant 消息以 "API Error:" 开头，且消息体含连接级特征。
 * 这类错误在 SDK 层表现为"query 正常 resolve、尾巴带 API Error 文本"（result 路径），
 * 或在传输中断时 reject（finishError 路径）。
 * 退避策略见 core/execution/autoResumeBackoff（共享层，避免 features→provider 依赖）。
 */

/** 文本滑窗大小（字符），用于跨 delta 累积 assistant 文本尾巴。 */
export const TEXT_TAIL_WINDOW = 4096;

const API_ERROR_PREFIX = 'API Error:';

/**
 * 连接级错误特征。与 HTTP 级可重试错误（429/5xx）区分：
 * 连接级错误不重试（issue #37077），HTTP 级由 SDK 自行重试。
 */
const CONNECTION_DROP_PATTERNS: readonly RegExp[] = Object.freeze([
  /read\s*failed/i,
  /读取失败/,
  /econnreset/i,
  /connection\s*(lost|reset|closed|refused|terminated|dropped)/i,
  /mid[- ]?\s*response/i,
  /incomplete/i,
  /socket\s*hang\s*up/i,
  /proxy\s*(error|failed)/i,
  /upstream\s*(error|failure|reset)/i,
  /partial(ly)?\s*response/i,
  /部分响应/,
]);

/** 消息文本是否以 "API Error:" 开头。 */
export function looksLikeApiError(message: string): boolean {
  return message.trimStart().startsWith(API_ERROR_PREFIX);
}

/** 消息是否为连接级断连错误（"API Error:" 前缀 + 连接级特征）。 */
export function isConnectionDropMessage(message: string): boolean {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith(API_ERROR_PREFIX)) return false;
  const body = trimmed.slice(API_ERROR_PREFIX.length);
  return CONNECTION_DROP_PATTERNS.some(pattern => pattern.test(body));
}

/**
 * 结构判类：SDK 是否为该 assistant 消息打了 API 错误注解。
 * server_error 家族实证（2026-08-27）：SDK 重试耗尽后合成的最终
 * assistant 消息携带 `isApiErrorMessage: true`（语言/签名无关），
 * 比文本模式表更权威；缺注解（undefined/false）回退文本判类。
 */
export function isApiErrorAnnotatedMessage(message: unknown): boolean {
  return (
    typeof message === 'object'
    && message !== null
    && (message as { isApiErrorMessage?: unknown }).isApiErrorMessage === true
  );
}

/** 向文本滑窗追加一个 delta，返回截断到窗口大小的新尾巴。 */
export function appendTextTail(current: string, delta: string): string {
  return (current + delta).slice(-TEXT_TAIL_WINDOW);
}

/**
 * turn 结束时的文本尾巴是否以断连错误消息收尾。
 * 在窗口内找最后一个 "API Error:" 出现点，从该点判断整段。
 * 该出现点必须贴近尾巴末尾：真实断连消息是 turn 的最后文本；
 * 助手输出中复述签名（如取证报告引用断连原文）时其后还有大量正文，
 * 用距离排除这类自引用误报（实测 2026-08-25 假阳性根因）。
 */
const MAX_SIGNATURE_END_SPAN = 512;

export function tailEndsWithConnectionDrop(textTail: string): boolean {
  const index = textTail.lastIndexOf(API_ERROR_PREFIX);
  if (index < 0) return false;
  if (textTail.length - index > MAX_SIGNATURE_END_SPAN) return false;
  return isConnectionDropMessage(textTail.slice(index));
}
