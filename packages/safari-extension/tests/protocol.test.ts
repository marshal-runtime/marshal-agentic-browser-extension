import { describe, expect, it } from 'vitest';
import {
  SAFARI_NATIVE_PORT_MESSAGE,
  isSafariSecretTypeRequest,
  isSafariSecretTypeResponse,
} from '../src/protocol.js';

describe('Safari native protocol', () => {
  it('accepts an internal secret request envelope', () => {
    expect(
      isSafariSecretTypeRequest({
        kind: SAFARI_NATIVE_PORT_MESSAGE,
        requestId: 'request-1',
        browserInstanceId: 'safari-profile-1',
        selector: '#password',
        fieldKind: 'password',
        text: 'secret',
        allowedUrlPatterns: ['https://example.test/*'],
      }),
    ).toBe(true);
  });

  it('recognizes only secret-free completion receipts', () => {
    const response = {
      kind: SAFARI_NATIVE_PORT_MESSAGE,
      requestId: 'request-1',
      browserInstanceId: 'safari-profile-1',
      success: true,
    };
    expect(isSafariSecretTypeResponse(response)).toBe(true);
    expect(response).not.toHaveProperty('text');
  });
});
