/**
 * DOM helper for relationship tier badges (kept out of pure math module).
 */

import { getFriendshipTier, getAffectionTier, getRelTierBadgeStyle } from './relationship-math.js';

/** Apply tier label + dynamic pill styling to an existing badge element. */
export function applyRelTierBadgeElement(el, type, value, max) {
    if (!el) return;
    const tier = type === 'friendship' ? getFriendshipTier(value, max) : getAffectionTier(value, max);
    el.className = `rt-npc-tier-badge ${type}`;
    el.setAttribute('style', getRelTierBadgeStyle(type, value, max));
    el.title = tier.hint;
    el.textContent = tier.label;
}
