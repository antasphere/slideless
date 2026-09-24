// The billing campaign: Mailpit's API, the way a scenario reads a mail the
// pair sent (the hub's invoice and balance mails, the password reset).
import { request, waitFor } from './http.mjs';

export class Mailpit {
  constructor(port) {
    this.target = { host: '127.0.0.1', port };
  }
  async list(limit = 50) {
    const res = await request(this.target, { path: `/api/v1/messages?limit=${limit}` });
    return res.json?.messages ?? [];
  }
  async total() {
    const res = await request(this.target, { path: '/api/v1/messages?limit=1' });
    return res.json?.total ?? 0;
  }
  async message(id) {
    const res = await request(this.target, { path: `/api/v1/message/${id}` });
    return res.json;
  }
  /** The messages to one address whose subject contains `subject`, newest first (summaries). */
  async find({ to, subject, after = 0 }) {
    const all = await this.list(200);
    return all.filter(
      (m) =>
        (!to || m.To.some((t) => t.Address === to)) &&
        (!subject || m.Subject.includes(subject)) &&
        (!after || new Date(m.Created).getTime() >= after)
    );
  }
  /** Wait for such a mail; the full message (with `Text`), or null. */
  async waitFor(match, timeoutMs = 60_000) {
    const summary = await waitFor(async () => (await this.find(match))[0] ?? null, { timeoutMs });
    return summary ? this.message(summary.ID) : null;
  }
  /** The first URL of a message's text part, or the one matching `re`. */
  static link(message, re) {
    const text = message?.Text ?? '';
    const m = re ? text.match(re) : text.match(/https?:\/\/\S+/);
    return m ? m[1] ?? m[0] : null;
  }
}
