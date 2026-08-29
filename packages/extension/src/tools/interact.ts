/**
 * Interact tool handler.
 *
 * Routes click, type, select, hover, and scroll commands to the browser
 * adapter, which delegates to the content script DOM operations via the
 * message bridge. Returns structured confirmation of each action.
 */

import { z } from 'zod';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import type { InteractResponseData } from '@agentic-browser/shared';
import {
  ClickParamsSchema,
  TypeParamsSchema,
  HoverParamsSchema,
  ScrollParamsSchema,
  SelectParamsSchema,
} from '@agentic-browser/shared';

/** Supported interaction action names. */
const InteractActionSchema = z.enum(['click', 'type', 'select', 'hover', 'scroll']);

/** Zod schema for the interact tool parameters envelope. */
export const InteractParamsSchema = z.object({
  action: InteractActionSchema,
  selector: z.string().min(1).optional(),
  value: z.string().optional(),
  text: z.string().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().positive().optional(),
  delay: z.number().int().nonnegative().optional(),
  clearFirst: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  label: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  behavior: z.enum(['auto', 'smooth']).optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from InteractParamsSchema. */
export type InteractParams = z.infer<typeof InteractParamsSchema>;

/**
 * Creates an interact command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, routes to the
 * appropriate adapter method based on the `action` field, and returns
 * a structured response confirming the action.
 */
export function createInteractHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<InteractResponseData> => {
    const parsed = InteractParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid interact params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { action } = parsed.data;

    switch (action) {
      case 'click':
        return handleClick(adapter, parsed.data);
      case 'type':
        return handleType(adapter, parsed.data);
      case 'select':
        return handleSelect(adapter, parsed.data);
      case 'hover':
        return handleHover(adapter, parsed.data);
      case 'scroll':
        return handleScroll(adapter, parsed.data);
    }
  };
}

async function handleClick(
  adapter: IBrowserAdapter,
  params: InteractParams,
): Promise<InteractResponseData> {
  const clickParams = ClickParamsSchema.parse({
    selector: params.selector,
    x: params.x,
    y: params.y,
    button: params.button,
    clickCount: params.clickCount,
    timeout: params.timeout,
  });

  const result = await adapter.click(clickParams);

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return { action: 'click', selector: params.selector ?? `(${String(params.x)},${String(params.y)})`, success: true };
}

async function handleType(
  adapter: IBrowserAdapter,
  params: InteractParams,
): Promise<InteractResponseData> {
  const typeParams = TypeParamsSchema.parse({
    selector: params.selector,
    text: params.text ?? params.value ?? '',
    delay: params.delay,
    clearFirst: params.clearFirst,
    timeout: params.timeout,
  });

  const result = await adapter.type(typeParams);

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return { action: 'type', selector: params.selector, success: true };
}

async function handleSelect(
  adapter: IBrowserAdapter,
  params: InteractParams,
): Promise<InteractResponseData> {
  const selectParams = SelectParamsSchema.parse({
    selector: params.selector,
    value: params.value,
    values: params.values,
    label: params.label,
    index: params.index,
    timeout: params.timeout,
  });

  const result = await adapter.select(selectParams);

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return {
    action: 'select',
    selector: params.selector,
    success: true,
    data: result.value,
  };
}

async function handleHover(
  adapter: IBrowserAdapter,
  params: InteractParams,
): Promise<InteractResponseData> {
  const hoverParams = HoverParamsSchema.parse({
    selector: params.selector,
    timeout: params.timeout,
  });

  const result = await adapter.hover(hoverParams);

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return { action: 'hover', selector: params.selector, success: true };
}

async function handleScroll(
  adapter: IBrowserAdapter,
  params: InteractParams,
): Promise<InteractResponseData> {
  const scrollParams = ScrollParamsSchema.parse({
    selector: params.selector,
    x: params.x,
    y: params.y,
    behavior: params.behavior,
    timeout: params.timeout,
  });

  const result = await adapter.scroll(scrollParams);

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return { action: 'scroll', selector: params.selector, success: true };
}
