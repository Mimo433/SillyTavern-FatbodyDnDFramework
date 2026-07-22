/**
 * Relationship instruction / sysprompt string builders.
 */

import { getNpcRelationshipMax, relPctOfMax } from './relationship-math.js';

export function buildNpcRelationshipInstruction(max) {
    const m = max ?? getNpcRelationshipMax();
    const p = (f) => relPctOfMax(f, m);
    return `## NPC RELATIONSHIPS
When recording a NEW NPC, set their starting relationship values using the \`rel\` parameter in your commit call. Infer appropriate starting deltas from the narrative context. Valid range: -${m} to +${m}.
- Long-time friends, regular companions, mentors, or close partners: set a strong starting friendship (e.g., +${p(0.30)} to +${p(0.60)}).
- Casual friends, helpful acquaintances, or positive encounters: set a minor starting friendship (e.g., +${p(0.10)} to +${p(0.25)}).
- Romantically interested or close loved ones: set starting affection and/or friendship (e.g., +${p(0.20)} to +${p(0.50)}).
- Minor foes, hostile rivals, or unfriendly targets: set a minor negative starting friendship (e.g., ${p(-0.05)} to ${p(-0.15)}).
- Direct enemies, antagonist figures, or deadly threats: set a strong negative starting friendship (e.g., ${p(-0.20)} to ${p(-0.60)}).
- Unknown/neutral: default to 0 (no delta).
Ongoing relationship changes are tracked automatically by the system from the narrative output. Do NOT emit relationship deltas for existing NPCs.`;
}

/**
 * Basic-mode router prompt block for [[REL:]] tags — same scaled guidelines.
 * @param {number} [max]
 * @returns {string}
 */
export function buildRouterRelationshipInstruction(max) {
    const m = max ?? getNpcRelationshipMax();
    const p = (f) => relPctOfMax(f, m);
    return `## NPC INITIAL RELATIONSHIP VALUES
When you record a NEW NPC, you MUST set their starting relationship values using [[REL:]] tags based on narrative context. This is ONLY for initial values when first recording an NPC — ongoing relationship changes are tracked automatically by the system. Valid range: -${m} to +${m}. Examples:
  [[REL: NameOrUID | friendship | +${p(0.30)}]]
  [[REL: NameOrUID | affection | ${p(-0.05)}]]
Starting value guidelines:
- Long-time friends, regular companions, mentors, or close partners: set a strong starting friendship (e.g., +${p(0.30)} to +${p(0.60)}).
- Casual friends, helpful acquaintances, or positive encounters: set a minor starting friendship (e.g., +${p(0.10)} to +${p(0.25)}).
- Romantically interested or close loved ones: set starting affection and/or friendship (e.g., +${p(0.20)} to +${p(0.50)}).
- Minor foes, hostile rivals, or unfriendly targets: set a minor negative starting friendship (e.g., ${p(-0.05)} to ${p(-0.15)}).
- Direct enemies, antagonist figures, or deadly threats: set a strong negative starting friendship (e.g., ${p(-0.20)} to ${p(-0.60)}).
- Unknown/neutral: default to 0 (no delta).`;
}

/**
 * Narrator sysprompt <relationship_tracking> block — scale line tied to configured max.
 * Delta guide magnitudes stay absolute (same point awards at any range width).
 * @param {number} [max]
 * @returns {string}
 */
export function buildRelationshipTrackingSysprompt(max) {
    const m = max ?? getNpcRelationshipMax();
    return `RELATIONSHIP TRACKING — only active when [NPC_RELATIONS] appears in context.

[NPC_RELATIONS] at the top of each turn shows current standings with active NPCs. Scale: -${m} (deep hostility) to +${m} (deep bond). Friendship = platonic trust. Affection = romantic/emotional warmth. Point changes are absolute increments clamped to ±${m}.

WHEN TO EMIT:
Be selective and natural. Only emit when {{user}} directly and meaningfully interacted with an NPC — a real moment worth noting. Magnitude MUST reflect the NPC's personality: a stoic warrior shifts less than a warm innkeeper for the same act.

DO NOT EMIT when: the interaction has no emotional weight (buying supplies, directions), the NPC is absent, or nothing meaningful happened between {{user}} and that NPC this turn.

INLINE ANNOTATION (visible — place immediately after the triggering moment):
*(Friendship: Marcus +10 — saved his life in the alley)*
*(Affection: Elena +2 — she seemed touched by the compliment)*

FRIENDSHIP scale (guides, not hard rules):
+1/+2 ... Casual warmth, shared laugh, pleasant campfire talk, small kindness
+2/+5 ... Compliment, meaningful help, bonding over shared memories or interests
+5/+10 .. Surviving danger together, heartfelt conversation, completing a shared goal
+10/+15 . Defending/protecting them, act of loyalty, keeping a difficult promise
+15/+25 . Saving their life, major self-sacrifice
+25/+30 . Blood oath, brotherhood/sisterhood pact
-1/-3 ... Dismissiveness, mild rudeness, forgetting something important to them
-3/-5 ... Small broken promise, ignoring them in a group, letting them down
-5/-10 .. Insult, belittling, disrespecting their values or beliefs
-10/-20 . Public humiliation, badmouthing them (if overheard)
-20/-30 . Abandoning them in danger, breaking a major promise
-40/-60 . Betraying them to an enemy

AFFECTION scale (guides, not hard rules):
+1 ...... Subtle kind gesture, noticing a small detail about them
+2/+3 ... Sincere compliment on appearance, wit, or spirit; flirtatious banter (if receptive)
+5/+10 .. Meaningful gift, intimate conversation, shared vulnerability, romantic gesture
+10/+20 . Protective act in romantic context, vulnerable confession of feelings
+20/+30 . Romantic proposal (if receptive)
-1/-2 ... Awkward or tone-deaf comment, mild social blunder
-2/-3 ... Cold or dismissive behavior
-5/-10 .. Public rejection or embarrassment
-8/-15 .. Flirting with someone else in their presence
-40/-60 . Romantic betrayal or cheating

Typical range: 1-5 for minor moments, 5-15 for major events. Only use 15+ for life-altering ones.

EXAMPLE — end of a response where {{user}} complimented Elena:
*(Affection: Elena +2 — she seemed genuinely moved by the words)*`;
}

/**
 * Builds the NPC instruction string based on current NPC settings.
 * @param {number} majorWords
 * @param {number} minorWords
 * @returns {string}
 */
