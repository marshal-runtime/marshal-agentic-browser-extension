import type { KeyVaultEntry, KeyVaultEntryMetadata, KeyVaultStore } from './contracts.js';
import { validateEntry } from './validation.js';

/** Test/dev store only. Production Marshal hosts should bind an OS-keychain-backed service. */
export class InMemoryKeyVaultStore implements KeyVaultStore {
  private readonly entries = new Map<string, KeyVaultEntry>();

  get(key: string): Promise<KeyVaultEntry | undefined> {
    const entry = this.entries.get(key);
    return Promise.resolve(entry === undefined ? undefined : structuredClone(entry));
  }

  put(entry: KeyVaultEntry): Promise<void> {
    const validated = validateEntry(entry);
    this.entries.set(validated.key, validated);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  listMetadata(): Promise<readonly KeyVaultEntryMetadata[]> {
    return Promise.resolve(
      [...this.entries.values()].map(({ key, allowedUrlPatterns, notBefore, expiresAt }) => ({
        key,
        allowedUrlPatterns: [...allowedUrlPatterns],
        notBefore,
        expiresAt,
      })),
    );
  }
}
