/**
 * Minimal Slack Web API client using built-in fetch (Node 20+).
 */

export interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  /**
   * Optional: captionless file/photo shares (subtype `file_share`) arrive with
   * NO text field. Callers must render a missing text as an empty body, never
   * interpolate it directly (which prints the literal string "undefined").
   */
  text?: string;
  type: string;
  subtype?: string;
  bot_id?: string;
}

/**
 * Timeout for Slack Web API calls. Without it a black-holed connection hangs
 * the await forever — and checkSlackWatch is awaited inside the fast-checker
 * tick loop, so one hung call would stall ALL inbound (Telegram included)
 * until daemon restart.
 */
const API_TIMEOUT_MS = 10_000;

export class SlackAPI {
  private readonly baseUrl = 'https://slack.com/api';
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Shared fetch wrapper: bounded timeout + HTTP-status checking before JSON
   * parsing. Slack app-level errors come back HTTP 200 with `ok:false` (the
   * caller checks those), but transport-level failures (429 rate limit, 5xx,
   * proxy HTML pages) would otherwise surface as an opaque JSON parse error.
   * 429s include the Retry-After header in the error message so operators can
   * see the server-requested pause in the log line.
   */
  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      ...init,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new Error(
          `Slack API ${path} rate limited (HTTP 429${retryAfter ? `, retry after ${retryAfter}s` : ''})`,
        );
      }
      throw new Error(`Slack API ${path} failed: HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  async postMessage(
    channel: string,
    text: string,
    opts?: { thread_ts?: string; reply_broadcast?: boolean },
  ): Promise<void> {
    const payload: Record<string, unknown> = { channel, text };
    if (opts?.thread_ts) payload.thread_ts = opts.thread_ts;
    if (opts?.reply_broadcast) payload.reply_broadcast = true;
    const data = await this.requestJson<{ ok: boolean; error?: string }>('chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!data.ok) {
      throw new Error(`Slack postMessage failed: ${data.error ?? 'unknown'}`);
    }
  }

  async getHistory(channel: string, oldest: string): Promise<SlackMessage[]> {
    const params = new URLSearchParams({ channel, oldest, limit: '50', inclusive: 'false' });
    const data = await this.requestJson<{ ok: boolean; messages?: SlackMessage[]; error?: string }>(
      `conversations.history?${params}`,
      { headers: { 'Authorization': `Bearer ${this.token}` } },
    );
    if (!data.ok) {
      throw new Error(`Slack conversations.history failed: ${data.error ?? 'unknown'}`);
    }
    return (data.messages ?? []).reverse();
  }

  async getUserName(userId: string): Promise<string> {
    try {
      const params = new URLSearchParams({ user: userId });
      const data = await this.requestJson<{ ok: boolean; user?: { real_name?: string; name?: string } }>(
        `users.info?${params}`,
        { headers: { 'Authorization': `Bearer ${this.token}` } },
      );
      if (data.ok && data.user) {
        return data.user.real_name ?? data.user.name ?? userId;
      }
    } catch { /* fall through */ }
    return userId;
  }

  /**
   * Resolve a user's Slack handle + display name via users.info.
   * Returns null on ok:false or any error (never throws) so callers can
   * treat lookup failure as "unresolved" and retry later.
   */
  async getUserInfo(
    userId: string,
  ): Promise<{ handle: string | null; displayName: string } | null> {
    try {
      const params = new URLSearchParams({ user: userId });
      const data = await this.requestJson<{
        ok: boolean;
        user?: { name?: string; real_name?: string; profile?: { display_name?: string } };
      }>(`users.info?${params}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (data.ok && data.user) {
        const handle = data.user.name ?? null;
        const displayName =
          data.user.real_name ?? data.user.profile?.display_name ?? data.user.name ?? userId;
        return { handle, displayName };
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * Resolve the authenticated bot's own user id via auth.test.
   *
   * Used by the inbound path to drop the agent's own outbound messages
   * (self-echo guard). Returns null on ok:false or any error (never throws) so
   * a failed lookup degrades to "own id unknown" — the caller skips the
   * own-id check rather than killing inbound entirely.
   */
  async getBotUserId(): Promise<string | null> {
    try {
      const data = await this.requestJson<{ ok: boolean; user_id?: string }>('auth.test', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (data.ok && data.user_id) {
        return data.user_id;
      }
    } catch { /* fall through */ }
    return null;
  }
}
