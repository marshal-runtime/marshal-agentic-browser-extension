/**
 * Extension content script — injected into web pages.
 *
 * Runs at document_idle on <all_urls> as configured in manifest.json.
 * Initializes the message bridge for communication with the service worker
 * and registers handlers for DOM operation commands.
 */

import { messageBridge } from './message-bridge.js';
import { Logger } from '../infrastructure/logger.js';
import type { CommandName, CommandRequest, CommandResponse } from '@agentic-browser/shared';

const logger = Logger.getInstance();

/** DOM-related commands that the content script handles directly. */
const DOM_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'click',
  'type',
  'hover',
  'scroll',
  'select',
  'focus',
  'getAttribute',
  'getProperty',
  'querySelector',
  'querySelectorAll',
  'getAttributes',
  'getOuterHtml',
  'getInnerHtml',
  'getPageContent',
  'setOuterHtml',
  'setInnerHtml',
  'insertAdjacentHtml',
  'modifyStyle',
  'getComputedStyle',
  'addStyleSheet',
  'waitForSelector',
]);

/**
 * Handles an incoming DOM command from the service worker.
 *
 * Returns a stub acknowledgement for now — actual DOM operation logic
 * will be implemented by dedicated tool handlers in a later task.
 */
function handleDomCommand(
  request: CommandRequest,
  _sender: chrome.runtime.MessageSender,
): CommandResponse {
  if (!DOM_COMMANDS.has(request.command)) {
    return {
      id: request.id,
      success: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `Command "${request.command}" is not a DOM operation`,
      },
    };
  }

  logger.debug('DOM command received', { command: request.command, id: request.id });

  return {
    id: request.id,
    success: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `DOM command "${request.command}" handler not yet implemented`,
    },
  };
}

function initialize(): void {
  messageBridge.init();
  messageBridge.onMessage(handleDomCommand);

  void messageBridge.sendToBackground('isConnected', {}).then(
    (response) => {
      logger.debug('Content script init confirmation sent', {
        url: globalThis.location.href,
        ack: response.success,
      });
    },
    (error: unknown) => {
      logger.warn('Content script init confirmation failed', {
        url: globalThis.location.href,
        error: String(error),
      });
    },
  );

  logger.info('Content script initialized', { url: globalThis.location.href });
}

initialize();
