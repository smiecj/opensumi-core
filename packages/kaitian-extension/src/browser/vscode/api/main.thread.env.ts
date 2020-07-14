import * as vscode from 'vscode';
import { Injectable, Optinal, Autowired } from '@ali/common-di';
import { IRPCProtocol } from '@ali/ide-connection';
import { ILoggerManagerClient } from '@ali/ide-logs/lib/browser';
import { IMainThreadEnv, IExtHostEnv, ExtHostAPIIdentifier } from '../../../common/vscode';
import { ClientAppConfigProvider, IOpenerService } from '@ali/ide-core-browser';
import { getLanguageId, URI } from '@ali/ide-core-common';
import { HttpOpener } from '@ali/ide-core-browser/lib/opener/http-opener';

@Injectable({multiple: true})
export class MainThreadEnv implements IMainThreadEnv {
  @Autowired(ILoggerManagerClient)
  loggerManger: ILoggerManagerClient;

  private eventDispose;
  private readonly proxy: IExtHostEnv;

  @Autowired(IOpenerService)
  private readonly openerService: IOpenerService;

  // 检测下支持的协议，以防打开内部协议
  private isSupportedLink(uri: URI) {
    return HttpOpener.standardSupportedLinkSchemes.has(uri.scheme);
  }

  constructor(@Optinal(IRPCProtocol) private rpcProtocol: IRPCProtocol) {
    this.proxy = this.rpcProtocol.getProxy(ExtHostAPIIdentifier.ExtHostEnv);

    this.eventDispose = this.loggerManger.onDidChangeLogLevel((level) => {
      this.proxy.$fireChangeLogLevel(level);
    });
    this.setLogLevel();
    this.proxy.$setEnvValues({
      appName: ClientAppConfigProvider.get().applicationName,
      uriScheme: ClientAppConfigProvider.get().uriScheme,
      language: getLanguageId(),
    });
  }

  public dispose() {
    this.eventDispose.dispose();
  }

  private async setLogLevel() {
    const value = await this.loggerManger.getGlobalLogLevel();
    await this.proxy.$setLogLevel(value);
  }

  async $clipboardReadText() {
    try {
      const value = await navigator.clipboard.readText();
      return value;
    } catch (e) {
      return '';
    }
  }

  $clipboardWriteText(text): Thenable<void> {
    return new Promise(async (resolve) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {}
      resolve();
    });
  }

  $openExternal(target: vscode.Uri): Thenable<boolean> {
    if (this.isSupportedLink(URI.from(target))) {
      this.openerService.open(target.toString(true));
    }
    return Promise.resolve(true);
  }
}
