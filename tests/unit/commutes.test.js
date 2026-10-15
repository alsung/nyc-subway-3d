import { describe, it, expect, vi, beforeEach } from 'vitest';

let authFetchMock;
vi.mock('../../src/core/auth.js', () => ({
    authFetch: (...args) => authFetchMock(...args),
}));

const { loadCommutes, getCommutes, saveCommute, updateLabel, deleteCommute, onCommutesChange } =
    await import('../../src/core/commutes.js');

function mockResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(data),
    };
}

describe('commutes', () => {
    beforeEach(() => {
        authFetchMock = vi.fn();
        // Reset cache by loading an empty list
        authFetchMock.mockResolvedValueOnce(mockResponse({ commutes: [] }));
        return loadCommutes();
    });

    it('starts with an empty list', () => {
        expect(getCommutes()).toEqual([]);
    });

    it('loadCommutes fetches and caches', async () => {
        const commutes = [
            { id: '1', originStopId: 'A', originName: 'A St', destStopId: 'B', destName: 'B St', label: 'Test' },
        ];
        authFetchMock.mockResolvedValueOnce(mockResponse({ commutes }));
        await loadCommutes();
        expect(getCommutes()).toEqual(commutes);
    });

    it('saveCommute posts and adds to cache', async () => {
        const created = { id: '2', originStopId: 'X', originName: 'X St', destStopId: 'Y', destName: 'Y St', label: 'New' };
        authFetchMock.mockResolvedValueOnce(mockResponse(created, 201));
        const result = await saveCommute('X', 'X St', 'Y', 'Y St', 'New');
        expect(result).toEqual(created);
        expect(getCommutes()).toContainEqual(created);
    });

    it('saveCommute throws on error', async () => {
        authFetchMock.mockResolvedValueOnce(mockResponse({ error: 'maximum of 20 saved commutes' }, 400));
        await expect(saveCommute('A', 'A', 'B', 'B', '')).rejects.toThrow('maximum of 20');
    });

    it('updateLabel patches and updates cache', async () => {
        const commutes = [{ id: '3', originStopId: 'A', originName: 'A', destStopId: 'B', destName: 'B', label: 'Old' }];
        authFetchMock.mockResolvedValueOnce(mockResponse({ commutes }));
        await loadCommutes();

        authFetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));
        await updateLabel('3', 'New');
        expect(getCommutes()[0].label).toBe('New');
    });

    it('deleteCommute removes from cache', async () => {
        const commutes = [
            { id: '4', originStopId: 'A', originName: 'A', destStopId: 'B', destName: 'B', label: 'x' },
            { id: '5', originStopId: 'C', originName: 'C', destStopId: 'D', destName: 'D', label: 'y' },
        ];
        authFetchMock.mockResolvedValueOnce(mockResponse({ commutes }));
        await loadCommutes();

        authFetchMock.mockResolvedValueOnce({ ok: true, status: 204 });
        await deleteCommute('4');
        expect(getCommutes()).toHaveLength(1);
        expect(getCommutes()[0].id).toBe('5');
    });

    it('notifies listeners on change', async () => {
        const listener = vi.fn();
        const unsubscribe = onCommutesChange(listener);

        const commutes = [{ id: '6', originStopId: 'A', originName: 'A', destStopId: 'B', destName: 'B', label: 'x' }];
        authFetchMock.mockResolvedValueOnce(mockResponse({ commutes }));
        await loadCommutes();
        expect(listener).toHaveBeenCalledWith(commutes);

        unsubscribe();
        authFetchMock.mockResolvedValueOnce(mockResponse({ commutes: [] }));
        await loadCommutes();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('loadCommutes handles fetch failure gracefully', async () => {
        const commutes = [{ id: '7', originStopId: 'A', originName: 'A', destStopId: 'B', destName: 'B', label: 'x' }];
        authFetchMock.mockResolvedValueOnce(mockResponse({ commutes }));
        await loadCommutes();

        authFetchMock.mockRejectedValueOnce(new Error('network'));
        await loadCommutes();
        // Cache should retain the previous value
        expect(getCommutes()).toEqual(commutes);
    });
});
