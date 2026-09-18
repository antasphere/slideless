/**
 * Light syntax tinting for the code the dashboard shows: an embed snippet, a
 * CLI command. It only SPLITS the text into kinds; the component renders
 * every piece through text interpolation.
 *
 * SECURITY: the pieces are text. Nothing here builds markup, and the
 * component must never hand a piece to {@html}: a snippet carries a share
 * link's secret and, one day, could carry user-authored text.
 *
 * The one invariant (pinned by the unit test): the pieces, joined, are the
 * input byte for byte, so what is read is what the copy button copies.
 */
export type CodeLanguage = 'html' | 'shell' | 'text';
export type TintKind = 'plain' | 'tag' | 'attr' | 'value' | 'punct' | 'flag';
export interface TintPiece {
  kind: TintKind;
  text: string;
}

function push(out: TintPiece[], kind: TintKind, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

function tintHtml(code: string): TintPiece[] {
  const out: TintPiece[] = [];
  let i = 0;
  while (i < code.length) {
    const open = /^<\/?[A-Za-z][\w-]*/.exec(code.slice(i));
    if (!open) {
      const next = code.indexOf('<', i + 1);
      const end = next === -1 ? code.length : next;
      push(out, 'plain', code.slice(i, end));
      i = end;
      continue;
    }
    const lead = open[0].startsWith('</') ? 2 : 1;
    push(out, 'punct', open[0].slice(0, lead));
    push(out, 'tag', open[0].slice(lead));
    i += open[0].length;
    // inside the tag, up to its closing bracket
    while (i < code.length) {
      const rest = code.slice(i);
      const close = /^\/?>/.exec(rest);
      if (close) {
        push(out, 'punct', close[0]);
        i += close[0].length;
        break;
      }
      const value = /^"[^"]*"?|^'[^']*'?/.exec(rest);
      if (value) {
        push(out, 'value', value[0]);
        i += value[0].length;
        continue;
      }
      const attr = /^[^\s=>/"']+/.exec(rest);
      if (attr) {
        push(out, 'attr', attr[0]);
        i += attr[0].length;
        continue;
      }
      push(out, rest[0] === '=' ? 'punct' : 'plain', rest[0]!);
      i += 1;
    }
  }
  return out;
}

function tintShell(code: string): TintPiece[] {
  const out: TintPiece[] = [];
  for (const line of code.split(/(\n)/)) {
    let first = true;
    for (const word of line.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) push(out, 'plain', word);
      else if (first) {
        push(out, 'tag', word);
        first = false;
      } else if (word.startsWith('-')) push(out, 'flag', word);
      else push(out, 'plain', word);
    }
  }
  return out;
}

export function tint(code: string, language: CodeLanguage): TintPiece[] {
  if (language === 'html') return tintHtml(code);
  if (language === 'shell') return tintShell(code);
  return code ? [{ kind: 'plain', text: code }] : [];
}
