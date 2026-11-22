/** Format a private supergroup topic link for display. */
export function telegramTopicUrl(chatId: number, threadId: number): string | undefined {
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId) || threadId <= 0) return undefined;
  const match = /^-100([1-9][0-9]*)$/.exec(String(chatId));
  return match?.[1] === undefined ? undefined : `https://t.me/c/${match[1]}/${threadId}`;
}
