import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';
import { AsyncLock } from '../../utils/safety';
import { GameKnowledge } from '../GameKnowledge/GameKnowledge';

const ORE_NAMES = [
    'coal_ore', 'deepslate_coal_ore',
    'iron_ore', 'deepslate_iron_ore',
    'gold_ore', 'deepslate_gold_ore',
    'diamond_ore', 'deepslate_diamond_ore',
    'copper_ore', 'deepslate_copper_ore',
    'lapis_ore', 'deepslate_lapis_ore',
    'redstone_ore', 'deepslate_redstone_ore',
    'emerald_ore', 'deepslate_emerald_ore',
    'ancient_debris',
];

/**
 * Mining Module — Handles mining, tree chopping, and tool management.
 * Rewritten for reliability: proper null checks, item collection, pillar mining.
 */
export class MiningModule implements Module {
    name = 'MiningModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private miningLock = new AsyncLock();
    private isMining = false;
    private gameKnowledge: GameKnowledge | null = null;

    setGameKnowledge(gk: GameKnowledge): void {
        this.gameKnowledge = gk;
    }

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Mining', 'Mining module initialized');
    }

    async cleanup(): Promise<void> {
        this.isMining = false;
        this.bot = null;
        this.eventBus = null;
    }

    // ─── Public API ──────────────────────────────────────────

    /**
     * Mine a specific block type nearby.
     */
    async mineBlock(blockName: string, count: number = 1, maxRange: number = 64): Promise<number> {
        if (!this.bot || !this.bot.entity) return 0;

        await this.miningLock.acquire();
        this.isMining = true;
        let mined = 0;

        try {
            const mcData = require('minecraft-data')(this.bot.version);

            // Resolve block name (fuzzy match)
            let resolvedName = blockName;
            if (!mcData.blocksByName[blockName]) {
                const matches = Object.keys(mcData.blocksByName).filter(n => n.includes(blockName));
                if (matches.length === 0) {
                    logger.warn('Mining', `Unknown block: ${blockName}`);
                    return 0;
                }
                resolvedName = matches[0];
                logger.info('Mining', `Resolved "${blockName}" → "${resolvedName}"`);
            }

            for (let i = 0; i < count && this.isMining; i++) {
                if (!this.bot || !this.bot.entity) break;

                const block = this.bot.findBlock({
                    matching: (b: any) => b.name === resolvedName || b.name.includes(resolvedName),
                    maxDistance: maxRange,
                });

                if (!block) {
                    logger.info('Mining', `No ${resolvedName} found within ${maxRange} blocks`);
                    break;
                }

                // Navigate close to the block
                const reached = await this.safeNavigate(block.position, 3, 12000);
                if (!reached) {
                    logger.warn('Mining', `Can't reach ${resolvedName} at ${block.position}`);
                    await sleep(500);
                    continue;
                }

                // Equip best tool and dig
                const target = this.bot.blockAt(block.position);
                if (!target || target.name === 'air') continue;

                await this.equipBestTool(target);

                try {
                    await this.bot.dig(target);
                    mined++;
                    logger.info('Mining', `Mined ${resolvedName} (${mined}/${count})`);
                    await this.collectNearbyItems();
                    await sleep(150);
                } catch (e) {
                    logger.warn('Mining', `Dig failed: ${e instanceof Error ? e.message : String(e)}`);
                    await sleep(500);
                }
            }
        } catch (e) {
            logger.error('Mining', `mineBlock error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.isMining = false;
            this.miningLock.release();
        }

        return mined;
    }

    /**
     * Chop trees (mine logs) nearby.
     * Much more robust: finds bottom of tree, mines upward, collects items.
     */
    async chopTrees(count: number = 3): Promise<number> {
        if (!this.bot || !this.bot.entity) return 0;

        await this.miningLock.acquire();
        this.isMining = true;
        let chopped = 0;

        try {
            for (let t = 0; t < count && this.isMining; t++) {
                if (!this.bot || !this.bot.entity) break;

                // Find nearby log blocks
                const logPositions = this.bot.findBlocks({
                    matching: (b: any) => b.name.endsWith('_log') || b.name.endsWith('_stem'),
                    maxDistance: 64,
                    count: 20,
                });

                if (logPositions.length === 0) {
                    logger.info('Mining', 'No trees found nearby');
                    break;
                }

                // Sort by distance (closest first)
                const botPos = this.bot.entity.position;
                logPositions.sort((a, b) =>
                    a.distanceTo(botPos) - b.distanceTo(botPos)
                );

                // Find the bottom-most log of the nearest tree
                let treeChopped = false;

                for (const pos of logPositions) {
                    if (!this.isMining || !this.bot || !this.bot.entity) break;

                    const block = this.bot.blockAt(pos);
                    if (!block || !(block.name.endsWith('_log') || block.name.endsWith('_stem'))) continue;

                    // Find the bottom of this tree (lowest connected log)
                    let bottomY = pos.y;
                    for (let dy = -1; dy >= -10; dy--) {
                        const below = this.bot.blockAt(pos.offset(0, dy, 0));
                        if (below && (below.name.endsWith('_log') || below.name.endsWith('_stem'))) {
                            bottomY = pos.y + dy;
                        } else {
                            break;
                        }
                    }

                    // Navigate to the base of the tree
                    const treeBase = pos.offset(0, bottomY - pos.y, 0);
                    const reached = await this.safeNavigate(treeBase, 2, 10000);
                    if (!reached) {
                        await sleep(300);
                        continue;
                    }

                    // Re-verify bottom log still exists
                    const bottomBlock = this.bot.blockAt(treeBase);
                    if (!bottomBlock || !(bottomBlock.name.endsWith('_log') || bottomBlock.name.endsWith('_stem'))) {
                        continue;
                    }

                    // Equip axe
                    await this.equipBestTool(bottomBlock);

                    // Mine the entire tree column from bottom to top
                    let logsMined = 0;
                    for (let dy = 0; dy < 30 && this.isMining; dy++) {
                        if (!this.bot || !this.bot.entity) break;

                        const logBlock = this.bot.blockAt(treeBase.offset(0, dy, 0));
                        if (!logBlock || !(logBlock.name.endsWith('_log') || logBlock.name.endsWith('_stem'))) break;

                        // Check if we can reach this block
                        const reachDist = logBlock.position.distanceTo(this.bot.entity.position);
                        if (reachDist > 5) {
                            // Try to look up and dig — if still too far, stop
                            break;
                        }

                        try {
                            await this.bot.dig(logBlock);
                            logsMined++;
                            await sleep(50); // tiny pause for block update
                        } catch (e) {
                            logger.debug('Mining', `Dig log failed at dy=${dy}: ${e instanceof Error ? e.message : String(e)}`);
                            break;
                        }
                    }

                    if (logsMined > 0) {
                        chopped++;
                        logger.info('Mining', `Chopped tree ${chopped}/${count} (${logsMined} logs)`);

                        // Collect dropped items
                        await this.collectNearbyItems();
                        treeChopped = true;
                        break; // Go to next tree target
                    }
                }

                if (!treeChopped) {
                    logger.info('Mining', 'Could not reach any trees');
                    break;
                }
            }
        } catch (e) {
            logger.error('Mining', `chopTrees error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.isMining = false;
            this.miningLock.release();
        }

        return chopped;
    }

    /**
     * Stop any active mining.
     */
    stopMining(): void {
        this.isMining = false;
        if (this.bot) {
            try { this.bot.stopDigging(); } catch (_) { }
            try { this.bot.pathfinder.stop(); } catch (_) { }
        }
    }

    // ─── Internal ───────────────────────────────────────

    /**
     * Safe navigation with null checks and timeout.
     */
    private async safeNavigate(pos: any, range: number = 2, timeoutMs: number = 12000): Promise<boolean> {
        if (!this.bot || !this.bot.entity) return false;

        try {
            const goal = new goals.GoalNear(pos.x, pos.y, pos.z, range);

            // Race between pathfinding and a timeout
            await Promise.race([
                this.bot.pathfinder.goto(goal),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('Navigation timeout')), timeoutMs)
                ),
            ]);

            return true;
        } catch (e) {
            // Stop pathfinder on timeout/failure
            try { this.bot?.pathfinder?.stop(); } catch (_) { }
            logger.debug('Mining', `Navigation failed: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * Collect nearby dropped items by walking to them.
     */
    private async collectNearbyItems(): Promise<void> {
        if (!this.bot || !this.bot.entity) return;

        try {
            // Wait a moment for items to spawn
            await sleep(300);

            // Find nearby items
            const items = Object.values(this.bot.entities).filter(entity =>
                entity.name === 'item' &&
                entity.position.distanceTo(this.bot!.entity.position) < 8
            );

            if (items.length === 0) return;

            // Sort by distance
            items.sort((a, b) =>
                a.position.distanceTo(this.bot!.entity.position) -
                b.position.distanceTo(this.bot!.entity.position)
            );

            // Walk toward the closest items (they auto-pickup on contact)
            for (const item of items.slice(0, 5)) {
                if (!this.bot || !this.bot.entity) break;
                const dist = item.position.distanceTo(this.bot.entity.position);
                if (dist < 2) continue; // Already close enough

                try {
                    await Promise.race([
                        this.bot.pathfinder.goto(
                            new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0)
                        ),
                        new Promise<void>((_, reject) =>
                            setTimeout(() => reject(new Error('pickup timeout')), 3000)
                        ),
                    ]);
                } catch (_) {
                    // pickup failed, no big deal
                }
            }

            // Brief wait for all nearby auto-pickups
            await sleep(200);
        } catch (_) {
            // Non-critical
        }
    }

    /**
     * Equip the best tool for the given block.
     */
    private async equipBestTool(block: any): Promise<void> {
        if (!this.bot) return;

        // Use GameKnowledge for smart tool selection
        if (this.gameKnowledge) {
            const bestTool = this.gameKnowledge.getBestToolForBlock(block);
            if (bestTool) {
                try {
                    await this.bot.equip(bestTool, 'hand');
                    return;
                } catch (_) { }
            }
        }

        // Fallback: use pathfinder's bestHarvestTool
        try {
            const bestTool = this.bot.pathfinder.bestHarvestTool(block);
            if (bestTool) {
                await this.bot.equip(bestTool, 'hand');
                return;
            }
        } catch (_) { }
    }
}
