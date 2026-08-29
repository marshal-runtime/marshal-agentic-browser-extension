import {
  RuntimePanelMethod,
  isRecord,
  isRuntimePanelBrowserCommandResult,
  isRuntimePanelRestorationResult,
  isRuntimePanelState,
  type RuntimeLifecycleEvent,
  type RuntimePanelArtifactNotification,
  type RuntimePanelBrowserCommandRequest,
  type RuntimePanelBrowserCommandResult,
  type RuntimePanelCleanupRequest,
  type RuntimePanelRestorationRequest,
  type RuntimePanelRestorationResult,
  type RuntimePanelSessionSync,
  type RuntimePanelState,
  type RuntimePanelToolLogNotification,
  type RuntimePanelUiLifecycleNotification,
  type UiProtocolTransport,
} from './protocol.js';

export class RuntimePanelClient {
  constructor(private readonly transport: UiProtocolTransport) {}

  async getState(signal?: AbortSignal): Promise<RuntimePanelState> {
    const result = await this.transport.request(RuntimePanelMethod.getState, {}, { signal });
    if (!isRecord(result) || !isRuntimePanelState(result['state'])) {
      throw new Error('Runtime panel returned an invalid state payload');
    }
    return result['state'];
  }

  async selectSession(sessionId: string): Promise<RuntimePanelState> {
    const result = await this.transport.request(RuntimePanelMethod.selectSession, {
      sessionId,
    });
    if (!isRecord(result) || !isRuntimePanelState(result['state'])) {
      throw new Error('Runtime panel returned an invalid session selection payload');
    }
    return result['state'];
  }

  async executeBrowserCommand(
    request: RuntimePanelBrowserCommandRequest,
  ): Promise<RuntimePanelBrowserCommandResult> {
    const result = await this.transport.request(RuntimePanelMethod.browserCommand, request);
    if (!isRuntimePanelBrowserCommandResult(result)) {
      throw new Error('Runtime panel returned an invalid browser command payload');
    }
    return result;
  }

  async restoreSession(
    request: RuntimePanelRestorationRequest,
  ): Promise<RuntimePanelRestorationResult> {
    const result = await this.transport.request(RuntimePanelMethod.restoreSession, request);
    if (!isRuntimePanelRestorationResult(result)) {
      throw new Error('Runtime panel returned an invalid restoration payload');
    }
    return result;
  }

  async cleanupSession(request: RuntimePanelCleanupRequest): Promise<RuntimePanelState> {
    const result = await this.transport.request(RuntimePanelMethod.cleanupSession, request);
    if (!isRecord(result) || !isRuntimePanelState(result['state'])) {
      throw new Error('Runtime panel returned an invalid cleanup payload');
    }
    return result['state'];
  }

  notifySessionSync(sync: RuntimePanelSessionSync): void {
    this.transport.notify(RuntimePanelMethod.sessionSync, sync);
  }

  notifyRuntimeLifecycle(event: RuntimeLifecycleEvent): void {
    this.transport.notify(RuntimePanelMethod.runtimeLifecycle, event);
  }

  notifyUiLifecycle(notification: RuntimePanelUiLifecycleNotification): void {
    this.transport.notify(RuntimePanelMethod.uiLifecycle, notification);
  }

  notifyArtifact(notification: RuntimePanelArtifactNotification): void {
    this.transport.notify(RuntimePanelMethod.artifact, notification);
  }

  notifyToolLog(notification: RuntimePanelToolLogNotification): void {
    this.transport.notify(RuntimePanelMethod.toolLog, notification);
  }

  subscribeState(listener: (state: RuntimePanelState) => void): () => void {
    return this.transport.subscribe((message) => {
      if (message.method !== RuntimePanelMethod.stateChanged || !isRecord(message.params)) {
        return;
      }
      const state = message.params['state'];
      if (isRuntimePanelState(state)) {
        listener(state);
      }
    });
  }
}
