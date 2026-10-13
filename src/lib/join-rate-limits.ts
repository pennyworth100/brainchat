type Limiter = { consume(key: string): Promise<unknown> };

// Both started charges must settle, even when the first one rejects. A rejected
// Promise.all is not proof that its sibling's PostgreSQL mutation has finished.
export async function consumeJoinLimits(ipLimiter: Limiter, roomLimiter: Limiter,
  clientIp: string, roomId: string): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => ipLimiter.consume(clientIp)),
    Promise.resolve().then(() => roomLimiter.consume(`${clientIp}:${roomId}`)),
  ]);
  // Stable IP-before-room precedence if both reject; preserve the original
  // rate-limit/error object (including msBeforeNext). No retry or compensation.
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
