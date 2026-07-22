import { describe, expect, it } from 'vitest';
import { compareVersions, isOlderThan } from '../state-manager.js';

describe('compareVersions', () => {
    it('orders numeric segments (not lexicographically)', () => {
        expect(compareVersions('4.10.0', '4.5.0')).toBeGreaterThan(0);
        expect(compareVersions('4.5.0', '4.10.0')).toBeLessThan(0);
    });

    it('treats equal versions as 0', () => {
        expect(compareVersions('5.5.13', '5.5.13')).toBe(0);
        expect(compareVersions('3.16.13', '3.16.13')).toBe(0);
    });

    it('pads missing segments as 0', () => {
        expect(compareVersions('3.16', '3.16.0')).toBe(0);
        expect(compareVersions('3.16.1', '3.16')).toBeGreaterThan(0);
    });

    it('handles empty / falsy as 0', () => {
        expect(compareVersions('', '0')).toBe(0);
        expect(compareVersions(null, '1.0.0')).toBeLessThan(0);
    });
});

describe('isOlderThan', () => {
    it('treats unset / empty current as older', () => {
        expect(isOlderThan(undefined, '5.5.13')).toBe(true);
        expect(isOlderThan('', '5.5.13')).toBe(true);
        expect(isOlderThan(null, '3.5.2')).toBe(true);
    });

    it('is true when current is strictly older', () => {
        expect(isOlderThan('5.5.12', '5.5.13')).toBe(true);
        expect(isOlderThan('3.16.13', '3.16.14')).toBe(true);
        expect(isOlderThan('4.4.0', '4.5.0')).toBe(true);
    });

    it('is false when current equals or exceeds target', () => {
        expect(isOlderThan('5.5.13', '5.5.13')).toBe(false);
        expect(isOlderThan('5.5.14', '5.5.13')).toBe(false);
        expect(isOlderThan('4.10.0', '4.5.0')).toBe(false);
    });
});
