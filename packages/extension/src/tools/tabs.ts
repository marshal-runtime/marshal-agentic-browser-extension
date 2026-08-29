/**
 * Tabs tool handler.
 *
 * Routes createTab, closeTab, switchTab, and listTabs commands to the
 * browser adapter's tab management methods. Returns structured tab
 * information or errors.
 */

import type { IBrowserAdapter, TabInfo } from '@agentic-browser/shared';
import {
  CreateTabParamsSchema,
  CloseTabParamsSchema,
  SwitchTabParamsSchema,
  ListTabsParamsSchema,
} from '@agentic-browser/shared';

/** Response data for tab operations that return tab info. */
export interface TabResponseData {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly windowId: number;
}

/** Response data for listTabs. */
export interface ListTabsResponseData {
  readonly tabs: readonly TabResponseData[];
}

/** Creates a createTab command handler bound to the given browser adapter. */
export function createCreateTabHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<TabResponseData> => {
    const parsed = CreateTabParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid createTab params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const result = await adapter.createTab(parsed.data);

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return toTabResponse(result.value);
  };
}

/** Creates a closeTab command handler bound to the given browser adapter. */
export function createCloseTabHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<void> => {
    const parsed = CloseTabParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid closeTab params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const result = await adapter.closeTab(parsed.data.tabId);

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }
  };
}

/** Creates a switchTab command handler bound to the given browser adapter. */
export function createSwitchTabHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<void> => {
    const parsed = SwitchTabParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid switchTab params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const result = await adapter.switchTab(parsed.data.tabId);

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }
  };
}

/** Creates a listTabs command handler bound to the given browser adapter. */
export function createListTabsHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<ListTabsResponseData> => {
    const parsed = ListTabsParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid listTabs params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const result = await adapter.listTabs();

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { tabs: result.value.map(toTabResponse) };
  };
}

function toTabResponse(tab: TabInfo): TabResponseData {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
  };
}
