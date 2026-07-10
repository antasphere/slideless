import type { Command } from 'commander';
import { CliUsageError, type CliIo } from '../context.js';

/**
 * Shell completion scripts, generated from the live command tree (so a new
 * command is picked up automatically). Word-level completion: top-level
 * commands, then subcommands where they exist.
 */

interface CmdInfo {
  name: string;
  subs: string[];
}

function commandTree(program: Command): CmdInfo[] {
  return program.commands
    .filter((c) => !c.name().startsWith('help'))
    .map((c) => ({
      name: c.name(),
      subs: c.commands.map((s) => s.name())
    }));
}

function bashScript(tree: CmdInfo[]): string {
  const top = tree.map((c) => c.name).join(' ');
  const cases = tree
    .filter((c) => c.subs.length > 0)
    .map(
      (c) =>
        `    ${c.name}) COMPREPLY=( $(compgen -W "${c.subs.join(' ')}" -- "$cur") ); return ;;`
    )
    .join('\n');
  return `# bash completion for slideless — eval "$(slideless completion bash)"
_slideless_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )
    return
  fi
  case "$prev" in
${cases}
  esac
}
complete -F _slideless_completions slideless
`;
}

function zshScript(tree: CmdInfo[]): string {
  const top = tree.map((c) => c.name).join(' ');
  const cases = tree
    .filter((c) => c.subs.length > 0)
    .map((c) => `    ${c.name}) compadd ${c.subs.join(' ')} ;;`)
    .join('\n');
  return `#compdef slideless
# zsh completion for slideless — eval "$(slideless completion zsh)"
_slideless() {
  if (( CURRENT == 2 )); then
    compadd ${top}
    return
  fi
  case "\${words[2]}" in
${cases}
  esac
}
compdef _slideless slideless
`;
}

function fishScript(tree: CmdInfo[]): string {
  const lines = [
    '# fish completion for slideless — slideless completion fish | source',
    `complete -c slideless -f -n "__fish_use_subcommand" -a "${tree.map((c) => c.name).join(' ')}"`
  ];
  for (const c of tree) {
    if (c.subs.length > 0) {
      lines.push(
        `complete -c slideless -f -n "__fish_seen_subcommand_from ${c.name}" -a "${c.subs.join(' ')}"`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function registerCompletionCommand(program: Command, io: CliIo): void {
  program
    .command('completion <shell>')
    .description('Print a completion script for bash, zsh, or fish')
    .action(async (shell: string) => {
      const tree = commandTree(program);
      switch (shell) {
        case 'bash':
          io.out.write(bashScript(tree));
          return;
        case 'zsh':
          io.out.write(zshScript(tree));
          return;
        case 'fish':
          io.out.write(fishScript(tree));
          return;
        default:
          throw new CliUsageError(`Unsupported shell "${shell}" — bash, zsh, or fish.`);
      }
    });
}
