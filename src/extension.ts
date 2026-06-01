import * as vscode from 'vscode';
import { SimulatorPanelProvider } from './simulatorPanel';

let panelProvider: SimulatorPanelProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  panelProvider = new SimulatorPanelProvider(
    context.extensionUri,
    context.extensionPath,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SimulatorPanelProvider.viewType,
      panelProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ios-simulator.open', () => {
      void vscode.commands.executeCommand('ios-simulator.panel.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ios-simulator.refresh', () => {
      panelProvider?.refresh();
    }),
  );

  context.subscriptions.push({
    dispose: () => panelProvider?.dispose(),
  });
}

export function deactivate(): void {
  panelProvider?.dispose();
  panelProvider = undefined;
}
