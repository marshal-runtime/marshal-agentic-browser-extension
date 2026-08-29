import {
  RUNTIME_PANEL_CHANNEL,
  isRuntimePanelChannelMessage,
  type RuntimePanelChannelMessage,
  type UiProtocolMessage,
  type UiProtocolTransport,
} from '@marshal/runtime-browser-panel';

export function createChromeRuntimePanelTransport(): UiProtocolTransport {
  return {
    request<TResult>(
      method: string,
      params: unknown,
      options?: { readonly signal?: AbortSignal },
    ): Promise<TResult> {
      if (options?.signal?.aborted) {
        return Promise.reject(toError(options.signal.reason, 'Runtime panel request aborted'));
      }

      const id = crypto.randomUUID();
      const envelope: RuntimePanelChannelMessage = {
        channel: RUNTIME_PANEL_CHANNEL,
        message: { jsonrpc: '2.0', id, method, params },
      };

      return new Promise<TResult>((resolve, reject) => {
        const handleAbort = (): void => {
          reject(toError(options?.signal?.reason, 'Runtime panel request aborted'));
        };
        options?.signal?.addEventListener('abort', handleAbort, { once: true });

        void chrome.runtime.sendMessage(envelope).then(
          (value: unknown) => {
            options?.signal?.removeEventListener('abort', handleAbort);
            if (!isRuntimePanelChannelMessage(value) || value.message.id !== id) {
              reject(new Error('Runtime panel returned an invalid protocol response'));
              return;
            }
            if (value.message.error) {
              reject(
                new Error(
                  value.message.error.code === undefined
                    ? value.message.error.message
                    : `[${String(value.message.error.code)}] ${value.message.error.message}`,
                ),
              );
              return;
            }
            resolve(value.message.result as TResult);
          },
          (error: unknown) => {
            options?.signal?.removeEventListener('abort', handleAbort);
            reject(toError(error, 'Runtime panel request failed'));
          },
        );
      });
    },

    notify(method: string, params: unknown): void {
      const envelope: RuntimePanelChannelMessage = {
        channel: RUNTIME_PANEL_CHANNEL,
        message: { jsonrpc: '2.0', method, params },
      };
      void chrome.runtime.sendMessage(envelope).catch((error: unknown) => {
        console.error('Failed to notify the Marshal runtime panel bridge', error);
      });
    },

    subscribe(listener: (message: UiProtocolMessage) => void): () => void {
      const handleMessage = (value: unknown): void => {
        if (isRuntimePanelChannelMessage(value)) {
          listener(value.message);
        }
      };
      chrome.runtime.onMessage.addListener(handleMessage);
      return () => {
        chrome.runtime.onMessage.removeListener(handleMessage);
      };
    },
  };
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return new Error(String(value));
  }
  return new Error(fallback);
}
