// The billing campaign: the record of a run. One row per scenario in
// `results.json` (name, group, status, evidence, duration, the path each
// scenario took), written after EVERY scenario so a run cut short still
// leaves its rows, and `report.md` at the end. A scenario is `green`, `red`
// (a product defect, with its evidence: the ticket's material) or `unrun`
// (what it needs is not on the pair yet, the reason named). Nothing is
// green by default: a scenario that throws is red.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class Report {
  constructor({ bundleDir, runNumber, heads }) {
    const dir = path.join(bundleDir, 'campaign');
    mkdirSync(dir, { recursive: true });
    if (!runNumber) {
      const existing = readdirSync(dir)
        .map((d) => Number((d.match(/^run-(\d+)$/) ?? [])[1] ?? 0))
        .filter(Boolean);
      runNumber = (existing.length ? Math.max(...existing) : 0) + 1;
    }
    this.dir = path.join(dir, `run-${runNumber}`);
    mkdirSync(this.dir, { recursive: true });
    this.runNumber = runNumber;
    this.startedAt = new Date();
    this.heads = heads;
    this.rows = [];
    this.notes = [];
  }
  add(row) {
    this.rows.push(row);
    this.write();
  }
  note(text) {
    this.notes.push(text);
  }
  tally() {
    const t = { green: 0, red: 0, unrun: 0 };
    for (const r of this.rows) t[r.status] = (t[r.status] ?? 0) + 1;
    return t;
  }
  write(finishedAt) {
    const results = {
      v: 1,
      run: this.runNumber,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt ? finishedAt.toISOString() : null,
      heads: this.heads,
      tally: this.tally(),
      notes: this.notes,
      scenarios: this.rows
    };
    writeFileSync(path.join(this.dir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    return results;
  }
  markdown(finishedAt) {
    const t = this.tally();
    const ms = finishedAt.getTime() - this.startedAt.getTime();
    const lines = [];
    lines.push(`# The confidence campaign, run ${this.runNumber}`);
    lines.push('');
    const img = (w) =>
      w
        ? `image ${w.image} ${w.id}${w.created ? `, built ${w.created.slice(0, 16)}Z` : ''}`
        : 'image unknown';
    lines.push(
      `Started ${this.startedAt.toISOString()}, finished ${finishedAt.toISOString()} (${Math.round(ms / 60000)} min). Pair ${this.heads.pair}: hub worktree ${this.heads.hub} (${img(this.heads.images?.hub)}), Slideless worktree ${this.heads.slideless} (${img(this.heads.images?.app)}). The worktree head is what was checked out; the image is what answered. The Stripe sandbox only; nothing charged to a real person.`
    );
    lines.push('');
    lines.push(`**${t.green} green · ${t.red} red · ${t.unrun} unrun** over ${this.rows.length} scenarios.`);
    lines.push('');
    for (const n of this.notes) lines.push(`- ${n}`);
    if (this.notes.length) lines.push('');
    const groups = [...new Set(this.rows.map((r) => r.group))];
    for (const g of groups) {
      lines.push(`## ${g}`);
      lines.push('');
      lines.push('| Scenario | Status | Path | Duration | Evidence |');
      lines.push('|---|---|---|---|---|');
      for (const r of this.rows.filter((x) => x.group === g)) {
        const ev =
          r.status === 'green'
            ? summarize(r.evidence)
            : r.status === 'red'
              ? `**${r.error ?? ''}** ${summarize(r.evidence)}`
              : (r.reason ?? '');
        lines.push(
          `| ${r.name} | ${badge(r.status)} | ${r.path ?? ''} | ${(r.durationMs / 1000).toFixed(1)} s | ${ev.replace(/\|/g, '\\|')} |`
        );
      }
      lines.push('');
    }
    const reds = this.rows.filter((r) => r.status === 'red');
    if (reds.length) {
      lines.push('## The red scenarios, with their evidence');
      lines.push('');
      for (const r of reds) {
        lines.push(`### ${r.group} · ${r.name}`);
        lines.push('');
        lines.push(`${r.error ?? ''}`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(r.evidence ?? {}, null, 2).slice(0, 6000));
        lines.push('```');
        lines.push('');
      }
    }
    writeFileSync(path.join(this.dir, 'report.md'), `${lines.join('\n')}\n`);
  }
}

const badge = (s) => (s === 'green' ? 'green' : s === 'red' ? '**red**' : 'unrun');

function summarize(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(ev)) {
    if (v === undefined) continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}: ${s.length > 160 ? `${s.slice(0, 160)}…` : s}`);
    if (parts.join('; ').length > 700) break;
  }
  return parts.join('; ');
}
