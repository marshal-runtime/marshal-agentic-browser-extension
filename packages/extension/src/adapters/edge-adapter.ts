/**
 * Edge browser adapter extending {@link ChromeAdapter}.
 *
 * Edge Chromium shares the same extension APIs as Chrome, so this adapter
 * is a thin wrapper that overrides {@link connect} to report the correct
 * browser name.
 */

import type {
  ConnectOptions,
  ConnectionStatus,
  ErrorResponse,
  Result,
} from '@agentic-browser/shared';
import { ErrorCode, ok, err } from '@agentic-browser/shared';
import { ChromeAdapter } from './chrome-adapter.js';

/**
 * Edge extension adapter. Inherits all Chrome extension behaviour and
 * identifies itself as "Edge" when connecting.
 */
class EdgeAdapter extends ChromeAdapter {
  /** Connects the adapter and reports the browser as Edge. */
  override async connect(
    options?: ConnectOptions,
  ): Promise<Result<ConnectionStatus, ErrorResponse>> {
    try {
      const result = await super.connect(options);

      if (!result.ok) {
        return result;
      }

      const status: ConnectionStatus = {
        ...result.value,
        browserName: 'Edge',
      };

      return ok(status);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown connection error';
      return err({ code: ErrorCode.CONNECTION_FAILED, message });
    }
  }
}

export { EdgeAdapter };
