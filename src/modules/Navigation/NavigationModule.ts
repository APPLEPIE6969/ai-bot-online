import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';
import { withTimeout } from '../../utils/safety';

/**
 * Navigation Module
 * Handles pathfinding, safe movement, pillar up, bridge, staircase.
 */
export class NavigationModule implements Module {
    name = 'NavigationModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Navigation', 'Navigation module initialized');
    }

    async cleanup(): Promise<void> {
        this.bot = null;
        this.eventBus = null;
    }

    /**
     * Navigate to a position with timeout.
     */
    async goTo(x: number, y: number, z: number, range: number = 2, timeoutMs: number = 30000): Promise<boolean> {
        if (!this.bot) return false;

        try {
            await withTimeout(
                this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, range)),
                timeoutMs,
                `Navigate to ${x},${y},${z}`
            );
            return true;
        } catch (e) {
            logger.warn('Navigation', `Failed to reach (${x},${y},${z}): ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * Navigate to a player by name.
     */
    async goToPlayer(username: string, range: number = 3): Promise<boolean> {
        if (!this.bot) return false;

        const player = this.bot.players[username];
        if (!player?.entity) {
            logger.warn('Navigation', `Player "${username}" not found or too far`);
            return false;
        }

        const pos = player.entity.position;
        return await this.goTo(pos.x, pos.y, pos.z, range);
    }

    /**
     * Follow a player continuously.
     */
    followPlayer(username: string, range: number = 3): void {
        if (!this.bot) return;

        const player = this.bot.players[username];
        if (!player?.entity) {
            logger.warn('Navigation', `Player "${username}" not visible`);
            return;
        }

        this.bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, range), true);
        logger.info('Navigation', `Following ${username}`);
    }

    /**
     * Stop all movement.
     */
    stop(): void {
        if (!this.bot) return;
        this.bot.pathfinder.stop();
        this.bot.clearControlStates();
        logger.info('Navigation', 'Stopped');
    }

    /**
     * Pillar up by placing blocks below the bot.
     */
    async pillarUp(height: number): Promise<boolean> {
        if (!this.bot) return false;

        const pillarBlocks = ['cobblestone', 'dirt', 'stone', 'netherrack', 'cobbled_deepslate'];
        let placed = 0;

        for (let i = 0; i < height; i++) {
            // Find a placeable block in inventory
            const block = this.bot.inventory.items().find(item => pillarBlocks.some(b => item.name.includes(b)));
            if (!block) {
                logger.warn('Navigation', 'No blocks for pillaring');
                break;
            }

            try {
                await this.bot.equip(block, 'hand');
                this.bot.setControlState('jump', true);
                await sleep(400);

                const below = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
                if (below) {
                    await this.bot.placeBlock(below, { x: 0, y: 1, z: 0 } as any);
                    placed++;
                }
                this.bot.setControlState('jump', false);
                await sleep(200);
            } catch (e) {
                this.bot.setControlState('jump', false);
                logger.debug('Navigation', `Pillar place error: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        this.bot.clearControlStates();
        return placed > 0;
    }
}
