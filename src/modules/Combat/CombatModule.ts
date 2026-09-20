import { Bot } from 'mineflayer';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';
import { GameKnowledge } from '../GameKnowledge/GameKnowledge';
import { goals } from 'mineflayer-pathfinder';

const WEAPON_TIER = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
];

/**
 * Combat Module
 * Handles self-defense, mob avoidance, weapon selection.
 */
export class CombatModule implements Module {
    name = 'CombatModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private gameKnowledge: GameKnowledge | null = null;
    private combatInterval: NodeJS.Timeout | null = null;
    private isFleeing = false;

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;

        // Auto-defense: attack hostile mobs that are attacking us
        bot.on('entityHurt', (entity) => {
            if (entity === bot.entity) {
                this.defendSelf();
            }
        });

        logger.info('Combat', 'Combat module initialized');
    }

    setGameKnowledge(gk: GameKnowledge): void {
        this.gameKnowledge = gk;
    }

    async cleanup(): Promise<void> {
        if (this.combatInterval) {
            clearInterval(this.combatInterval);
            this.combatInterval = null;
        }
        this.bot = null;
    }

    /**
     * Attack a specific entity.
     */
    async attack(entity: any): Promise<void> {
        if (!this.bot || !entity) return;

        await this.equipBestWeapon();

        try {
            this.bot.attack(entity);
        } catch (e) {
            logger.debug('Combat', `Attack failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Defend against the nearest hostile mob attacking us.
     */
    private async defendSelf(): Promise<void> {
        if (!this.bot || !this.gameKnowledge || this.isFleeing) return;

        // Find nearest hostile entity
        const hostile = this.bot.nearestEntity((entity) => {
            if (!entity) return false;
            const name = entity.name || '';
            const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
                'pillager', 'vindicator', 'drowned', 'husk', 'stray', 'phantom',
                'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'warden', 'ravager', 'evoker'];
            return hostiles.some(h => name.includes(h));
        });

        if (!hostile) return;

        const threat = this.gameKnowledge.getThreatLevel(hostile);
        const confidence = this.gameKnowledge.getCombatConfidence();
        const dist = this.bot.entity.position.distanceTo(hostile.position);
        const enclosed = this.gameKnowledge.isEnclosed();

        // 1. Extreme Threat / Warden: Run instantly
        if (threat >= 100) {
            logger.warn('Combat', `EXTREME THREAT detected (${hostile.name})! Fleeing immediately.`);
            await this.flee(hostile);
            return;
        }

        // 2. Tactical Fleeing: If we are weak, enclosed, or outmatched
        const shouldFlee = (threat > confidence + 10) || (enclosed && threat > 30) || (this.bot.health < 6);

        if (shouldFlee) {
            logger.warn('Combat', `Situational disadvantage (Threat: ${threat}, Conf: ${confidence}, Enclosed: ${enclosed}). Retreating...`);
            await this.flee(hostile);
            return;
        }

        // 3. Creeper proximity (Special case)
        if (hostile.name === 'creeper' && dist < 4) {
            logger.warn('Combat', 'Creeper too close! Jumping back...');
            await this.flee(hostile, 8); // Short burst flee
            return;
        }

        // 4. Fight back if we are confident
        if (dist < 4) {
            await this.attack(hostile);
        }
    }

    /**
     * Flee from a threat to a safe distance.
     */
    private async flee(threat: any, distance: number = 24): Promise<void> {
        if (!this.bot || !threat || this.isFleeing) return;

        this.isFleeing = true;
        try {
            const pos = this.bot.entity.position;
            const threatPos = threat.position;

            // Calculate a point away from the threat
            const dir = pos.minus(threatPos).normalize();
            const fleeDest = pos.plus(dir.scaled(distance));

            logger.info('Combat', `Fleeing to safe distance...`);
            await this.bot.pathfinder.goto(new goals.GoalNear(fleeDest.x, fleeDest.y, fleeDest.z, 2));

            // Brief cooldown to avoid instant re-engagement loop
            await sleep(2000);
        } catch (e) {
            logger.debug('Combat', `Flee failed: ${e instanceof Error ? e.message : String(e)}`);
            // Fallback: simple movement
            this.bot.setControlState('back', true);
            this.bot.setControlState('sprint', true);
            await sleep(1500);
            this.bot.clearControlStates();
        } finally {
            this.isFleeing = false;
        }
    }

    /**
     * Equip the best weapon from inventory.
     */
    async equipBestWeapon(): Promise<void> {
        if (!this.bot) return;

        for (const weapon of WEAPON_TIER) {
            const item = this.bot.inventory.items().find(i => i.name === weapon);
            if (item) {
                try {
                    await this.bot.equip(item, 'hand');
                } catch (_) { }
                return;
            }
        }
    }
}
