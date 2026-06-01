import * as vscode from 'vscode';

/** Push annotation markdown into Cursor/VS Code Chat input (draft, not auto-send). */
export async function sendAnnotationToChat(text: string): Promise<'chat' | 'clipboard'> {
  const attempts: Array<[string, Record<string, unknown>]> = [
    ['workbench.action.chat.open', { query: text, isPartialQuery: true }],
    ['workbench.panel.chat.view.copilot.focus', { query: text, isPartialQuery: true }],
    ['aichat.newchataction', { query: text }],
    ['composer.open', { query: text }],
  ];

  for (const [command, args] of attempts) {
    try {
      await vscode.commands.executeCommand(command, args);
      return 'chat';
    } catch {
      // Command unavailable in this host — try next.
    }
  }

  await vscode.env.clipboard.writeText(text);
  return 'clipboard';
}
