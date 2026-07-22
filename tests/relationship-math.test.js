import { describe, expect, it } from 'vitest';
import {
    clampRelationshipValue,
    relationshipBarPct,
    relPctOfMax,
    getFriendshipTier,
    getAffectionTier,
    getRelTierIntensity,
    getRelTierBadgeStyle,
    getRelTierDetailedStyle,
} from '../state-manager.js';

const MAX = 100;

describe('clampRelationshipValue', () => {
    it('clamps to ±max and rounds', () => {
        expect(clampRelationshipValue(150, MAX)).toBe(100);
        expect(clampRelationshipValue(-150, MAX)).toBe(-100);
        expect(clampRelationshipValue(12.6, MAX)).toBe(13);
        expect(clampRelationshipValue(0, MAX)).toBe(0);
    });

    it('returns 0 for non-finite input', () => {
        expect(clampRelationshipValue(NaN, MAX)).toBe(0);
        expect(clampRelationshipValue(Infinity, MAX)).toBe(0);
        expect(clampRelationshipValue('x', MAX)).toBe(0);
    });
});

describe('relationshipBarPct / relPctOfMax', () => {
    it('maps absolute value to 0–50% of bar track', () => {
        expect(relationshipBarPct(0, MAX)).toBe(0);
        expect(relationshipBarPct(MAX, MAX)).toBe(50);
        expect(relationshipBarPct(-MAX, MAX)).toBe(50);
        expect(relationshipBarPct(50, MAX)).toBe(25);
    });

    it('scales fractions of max', () => {
        expect(relPctOfMax(0.3, MAX)).toBe(30);
        expect(relPctOfMax(-0.15, MAX)).toBe(-15);
    });
});

describe('getFriendshipTier', () => {
    it('returns NEUTRAL near zero', () => {
        expect(getFriendshipTier(0, MAX).label).toBe('NEUTRAL/ACQUAINTANCE');
        expect(getFriendshipTier(2, MAX).label).toBe('NEUTRAL/ACQUAINTANCE');
    });

    it('hits hostile / bonded extremes at ±max', () => {
        expect(getFriendshipTier(-MAX, MAX).label).toBe('HOSTILE');
        expect(getFriendshipTier(MAX, MAX).label).toBe('BONDED/FAMILY');
    });

    it('maps mid-positive to FRIENDLY', () => {
        expect(getFriendshipTier(30, MAX).label).toBe('FRIENDLY');
    });
});

describe('getAffectionTier', () => {
    it('returns NEUTRAL near zero', () => {
        expect(getAffectionTier(0, MAX).label).toBe('NEUTRAL/NO AFFECTION');
    });

    it('hits revulsion / deeply in love at extremes', () => {
        expect(getAffectionTier(-MAX, MAX).label).toBe('REVULSION');
        expect(getAffectionTier(MAX, MAX).label).toBe('DEEPLY IN LOVE');
    });
});

describe('getRelTierIntensity / badge styles', () => {
    it('intensity is |value|/max', () => {
        expect(getRelTierIntensity(0, MAX)).toBe(0);
        expect(getRelTierIntensity(50, MAX)).toBe(0.5);
        expect(getRelTierIntensity(-100, MAX)).toBe(1);
    });

    it('neutral badge uses muted style', () => {
        const css = getRelTierBadgeStyle('friendship', 0, MAX);
        expect(css).toContain('--rt-text-muted');
    });

    it('positive friendship badge uses green tones', () => {
        const css = getRelTierBadgeStyle('friendship', 50, MAX);
        expect(css).toMatch(/hsl\(142/);
        expect(css).toContain('border:');
    });

    it('detailed style returns a non-empty CSS string', () => {
        const css = getRelTierDetailedStyle('affection', -40, MAX);
        expect(css.length).toBeGreaterThan(20);
        expect(css).toContain('background:');
    });
});
