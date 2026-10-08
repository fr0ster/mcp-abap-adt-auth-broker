/**
 * The recording accessor notes the fields a build reads — and nothing a
 * promise check touches: awaiting an answer reads its `then`, which is no
 * field of the means (§6.2).
 */

import {
  type BuildIdentity,
  IdentityRecorder,
  type SourceName,
  StoreReads,
} from '../../buildIdentity';

function readsOf(answer: object | null): StoreReads {
  return new StoreReads(async (_name: SourceName) => answer);
}

describe('IdentityRecorder', () => {
  async function recorded(answer: object): Promise<BuildIdentity> {
    const recorder = new IdentityRecorder(readsOf(answer));
    // An async read hands the proxy through a promise: its `then` is read.
    const means = await recorder.read<{ serviceUrl?: string }>('means');
    expect(means?.serviceUrl).toBe('https://abap.example.com');
    return recorder.seal();
  }

  it('does not note `then`: an answer that now has one is unchanged', async () => {
    const identity = await recorded({ serviceUrl: 'https://abap.example.com' });

    // A non-callable `then`: the answer still resolves as itself.
    const withThen = Object.defineProperty(
      { serviceUrl: 'https://abap.example.com' },
      'then',
      { value: 1, enumerable: true },
    );
    await expect(identity.unchanged(readsOf(withThen))).resolves.toBe(true);
  });

  it('does note a field the build read', async () => {
    const identity = await recorded({ serviceUrl: 'https://abap.example.com' });

    await expect(
      identity.unchanged(readsOf({ serviceUrl: 'https://other.example.com' })),
    ).resolves.toBe(false);
  });
});
