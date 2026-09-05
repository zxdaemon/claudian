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

/**
 * server_error 家族判类（发现 4，2026-08-27 实弹）。
 * server_error 事件的终止路径是 error 路径而非 result 路径：查询 reject、
 * 无 result 事件、finishCompleted 从不到场。SDK 传递给 finishError 的错误
 * 形态是裸分类串（"server_error"）或 API Error 文本，不含 connection 字样，
 * 分类器原样落进 provider 兜底 → 连接门不放行。
 * 语义：SDK 重试耗尽即连接级失效，归入 transport 同域自愈链。
 */
export function isServerErrorFamilyMessage(message: string): boolean {
  const m = message.trim().toLowerCase();
  return (
    m.includes('server_error')
    || m.includes('server error')
    || m.startsWith('api error')
  );
}

/**
 * 内容过滤拒绝判类（发现 5，2026-09-05 实弹）。
 * API 输入安全过滤拒绝（"input may contain sensitive information"）不是连接级
 * 断连：同上下文重发必然再被拒，ARCD 不应自动恢复（silent by design）。
 * 实证（2026-09-05）：CLI 2.1.231 将该错误作为 assistant 尾巴文本输出且不打
 * isApiErrorMessage 注解；SDK 层对非 success result 合成兜底消息 "unknown"，
 * finishError 收到的 message 无信息量，真实原因只在 textTail。
 * 判定位次：必须先于 isServerErrorFamilyMessage（"API Error:" 前缀会被
 * server_error 家族吃掉归入 transport，导致 ARCD 误恢复）。
 */
export function isContentFilteredMessage(message: string): boolean {
  return message.toLowerCase().includes('sensitive information');
}

/** SDK 兜底消息识别：无信息量（空或 "unknown"），需从 assistant 尾巴回收原文。 */
export function isUninformativeErrorMessage(message: string): boolean {
  const m = message.trim().toLowerCase();
  return m === '' || m === 'unknown';
}

/**
 * 从 assistant 文本尾巴回收最后一条 "API Error:" 起始的原文。
 * CLI 把 API 错误原文写进 assistant 消息（text_delta 流经 textTail）；
 * SDK reject 时 error.message 可能只剩 "unknown"——用本函数回收真实原因。
 */
export function lastApiErrorLine(textTail: string): string | null {
  const index = textTail.lastIndexOf(API_ERROR_PREFIX);
  if (index < 0) return null;
  return textTail.slice(index).trim() || null;
}

/**
 * 判类与展示的有效消息：SDK 兜底消息（无信息量）且有尾巴原文时用原文。
 * 语义：原文参与判类（content-filtered 等特征识别）并透传到 UI，
 * 消除 "Error: unknown" 对真实原因的掩盖。
 */
export function resolveEffectiveMessage(
  message: string,
  tailHint?: string | null,
): string {
  return tailHint && isUninformativeErrorMessage(message) ? tailHint : message;
}
