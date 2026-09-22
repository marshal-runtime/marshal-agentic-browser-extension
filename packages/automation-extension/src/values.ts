/**
 * Resolves the text to type into a TYPE_TEXT field from the planner-supplied
 * `values` map (field label -> text), matching case-insensitively by exact
 * label first, then by best (longest) substring match either direction.
 * There is no text-generation model call anywhere in this executor - if no
 * value matches, the caller must stop and report `needs_value`.
 */
export function resolveFieldValue(
  label: string,
  values: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!values) return undefined;
  const normalizedLabel = label.trim().toLowerCase();
  if (normalizedLabel.length === 0) return undefined;

  for (const [key, value] of Object.entries(values)) {
    if (key.trim().toLowerCase() === normalizedLabel) return value;
  }

  let best: { readonly value: string; readonly score: number } | undefined;
  for (const [key, value] of Object.entries(values)) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey.length === 0) continue;
    const matches =
      normalizedLabel.includes(normalizedKey) || normalizedKey.includes(normalizedLabel);
    if (!matches) continue;
    const score = Math.min(normalizedKey.length, normalizedLabel.length);
    if (!best || score > best.score) {
      best = { value, score };
    }
  }
  return best?.value;
}

/** Fields whose typed value must never appear verbatim in step records - only its length. */
export function looksLikeSecretField(label: string): boolean {
  return /password|passcode|secret|pin\b/i.test(label);
}
