import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRelease } from '../src/fetchRelease';

const TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}${release}/vscodium-reh-${os}-${arch}-${version}${release}.tar.gz';
const logger = { info: vi.fn(), error: vi.fn(), trace: vi.fn() } as any;

function redirectTo(location: string | null, status = 302) {
    return { status, headers: new Headers(location ? { location } : {}) };
}
function json(body: unknown, status = 200) {
    return { status, headers: new Headers(), json: async () => body };
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchRelease "latest"', () => {
    it('resolves from the releases/latest redirect without calling the API', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            redirectTo('https://github.com/VSCodium/vscodium/releases/tag/1.140.06880'));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchRelease(TEMPLATE, '1.138.0', '', 'latest', logger))
            .resolves.toEqual({ version: '1.140.0', build: '6880' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://github.com/VSCodium/vscodium/releases/latest');
    });

    it('falls back to the API when the redirect has no tag', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(redirectTo(null, 200))
            .mockResolvedValueOnce(json([{ name: '1.135.06055' }, { name: '1.140.06880' }]));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchRelease(TEMPLATE, '1.138.0', '', 'latest', logger))
            .resolves.toEqual({ version: '1.140.0', build: '6880' });
    });

    it('reports the API error message instead of crashing on a non-array body', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(json({ message: 'API rate limit exceeded for 1.2.3.4' }, 403));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchRelease(TEMPLATE, '1.138.0', '', 'latest', logger))
            .resolves.toEqual({ version: '1.138.0', build: '' });
        const errorArgs = logger.error.mock.calls.at(-1);
        expect(String(errorArgs[1])).toContain('HTTP 403: API rate limit exceeded');
    });
});

describe('fetchRelease other objectives', () => {
    it('"closest" still uses the API only', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(json([{ name: '1.140.06880' }, { name: '1.140.05000' }]));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchRelease(TEMPLATE, '1.140.0', '', 'closest', logger))
            .resolves.toEqual({ version: '1.140.0', build: '6880' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain('api.github.com');
    });
});
