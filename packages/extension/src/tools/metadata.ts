/**
 * Page metadata tool handler.
 *
 * Validates incoming parameters via {@link MetadataParamsSchema} and
 * delegates to the browser adapter to extract page metadata (title,
 * description, canonical URL, Open Graph data, favicon, language).
 */

import type { IBrowserAdapter, PageMetadata } from '@agentic-browser/shared';
import { MetadataParamsSchema } from '@agentic-browser/shared';

/**
 * Creates a metadata extraction command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod and executes a script
 * in the page context to extract metadata from the DOM.
 */
export function createMetadataHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<PageMetadata> => {
    const parsed = MetadataParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid metadata params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const result = await adapter.executeScript({
      script: `
        const title = document.title || '';
        const metaTags = {};
        const ogData = {};

        const metaElements = document.querySelectorAll('meta');
        for (const meta of metaElements) {
          const name = meta.getAttribute('name') || meta.getAttribute('property') || '';
          const content = meta.getAttribute('content') || '';
          if (!name || !content) continue;
          if (name.startsWith('og:')) {
            ogData[name.slice(3)] = content;
          }
          metaTags[name] = content;
        }

        const canonicalLink = document.querySelector('link[rel="canonical"]');
        const canonicalUrl = canonicalLink ? canonicalLink.getAttribute('href') || undefined : undefined;

        const language = document.documentElement.lang || undefined;

        const faviconLink = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
        const favicon = faviconLink ? faviconLink.getAttribute('href') || undefined : undefined;

        const description = metaTags['description'] || undefined;

        return {
          title,
          description,
          canonicalUrl,
          language,
          favicon,
          openGraph: {
            title: ogData['title'] || undefined,
            description: ogData['description'] || undefined,
            image: ogData['image'] || undefined,
            url: ogData['url'] || undefined,
            type: ogData['type'] || undefined,
            siteName: ogData['site_name'] || undefined,
          },
          metaTags,
        };
      `,
    });

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return result.value as PageMetadata;
  };
}
