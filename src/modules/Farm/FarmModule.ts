import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';
import { withTimeout } from '../../utils/safety';
import { Vec3 } from 'vec3';

const CROP_SEEDS: Record<string, string> = {
    wheat_seeds: 'wheat',
    beetroot_seeds: 'beetroots',
    carrot: 'carrots',
    potato: 'potatoes',
    melon_seeds: 'melon_stem',
    pumpkin_seeds: 'pumpkin_stem',
};

const MATURE_AGE = 7; // Wheat, carrots, potatoes
const BEETROOT_MATURE = 3;

/**
 * Farm Module
 * Builds and maintains crop farms, auto-harvests, replants.
 */
export class FarmModule implements Module {
    name = 'FarmModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private isFarming = false;

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Farm', 'Farm module initialized');
    }

    async cleanup(): Promise<void> {
        this.isFarming = false;
        this.bot = null;
    }

    /**
     * Create a simple crop farm: till soil, plant seeds, water in center.
     * Creates a 9x9 farm with a water source in the middle.
     */
    async createFarm(origin?: Vec3, size: number = 9): Promise<number> {
        if (!this.bot) return 0;
        this.isFarming = true;

        const pos = origin || this.bot.entity.position.offset(3, 0, 0).floored();
        let tilled = 0;

        // Equip hoe
        const hoe = this.bot.inventory.items().find(i => i.name.includes('_hoe'));
        if (!hoe) {
            logger.warn('Farm', 'No hoe in inventory');
            this.isFarming = false;
            return 0;
        }

        try {
            await this.bot.equip(hoe, 'hand');
        } catch (_) { }

        const center = Math.floor(size / 2);

        for (let x = 0; x < size && this.isFarming; x++) {
            for (let z = 0; z < size && this.isFarming; z++) {
                // Skip center (water hole)
                if (x === center && z === center) continue;

                const blockPos = pos.offset(x, -1, z);
                const block = this.bot.blockAt(blockPos);

                if (block && (block.name === 'dirt' || block.name === 'grass_block')) {
                    try {
                        // Navigate closer if needed
                        const dist = this.bot.entity.position.distanceTo(blockPos);
                        if (dist > 4) {
                            await withTimeout(
                                this.bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y + 1, blockPos.z, 2)),
                                8000,
                                'Farm navigate'
                            );
                        }

                        // Till the soil
                        await this.bot.dig(block);
                        tilled++;
                        await sleep(150);
                    } catch (e) {
                        logger.debug('Farm', `Till failed at ${blockPos}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
        }

        // Place water in center
        const bucket = this.bot.inventory.items().find(i => i.name === 'water_bucket');
        if (bucket) {
            try {
                const centerPos = pos.offset(center, -1, center);
                // Dig a hole first
                const centerBlock = this.bot.blockAt(centerPos);
                if (centerBlock) {
                    await this.bot.dig(centerBlock);
                    await this.bot.equip(bucket, 'hand');
                    // Place water
                    const belowBlock = this.bot.blockAt(centerPos.offset(0, -1, 0));
                    if (belowBlock) {
                        await this.bot.placeBlock(belowBlock, new Vec3(0, 1, 0));
                    }
                }
            } catch (e) {
                logger.debug('Farm', `Water placement failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        this.isFarming = false;
        logger.info('Farm', `Created farm: ${tilled} blocks tilled`);
        this.eventBus?.emit('farm:created', { tilled });
        return tilled;
    }

    /**
     * Plant seeds on all empty farmland nearby.
     */
    async plantSeeds(seedType: string = 'wheat_seeds', maxRange: number = 32): Promise<number> {
        if (!this.bot) return 0;
        this.isFarming = true;

        const mcData = require('minecraft-data')(this.bot.version);
        const farmlandId = mcData.blocksByName['farmland']?.id;
        if (!farmlandId) return 0;

        const farmlandBlocks = this.bot.findBlocks({
            matching: farmlandId,
            maxDistance: maxRange,
            count: 100,
        });

        let planted = 0;
        const seed = this.bot.inventory.items().find(i => i.name === seedType || i.name.includes(seedType));
        if (!seed) {
            logger.info('Farm', `No ${seedType} in inventory`);
            this.isFarming = false;
            return 0;
        }

        for (const pos of farmlandBlocks) {
            if (!this.isFarming) break;

            // Check if the block above farmland is air (empty for planting)
            const above = this.bot.blockAt(pos.offset(0, 1, 0));
            if (above && above.name !== 'air') continue;

            try {
                const dist = this.bot.entity.position.distanceTo(pos);
                if (dist > 4) {
                    await withTimeout(
                        this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2)),
                        8000,
                        'Plant navigate'
                    );
                }

                await this.bot.equip(seed, 'hand');
                const farmBlock = this.bot.blockAt(pos);
                if (farmBlock) {
                    await this.bot.placeBlock(farmBlock, new Vec3(0, 1, 0));
                    planted++;
                    await sleep(100);
                }
            } catch (e) {
                logger.debug('Farm', `Plant failed at ${pos}: ${e instanceof Error ? e.message : String(e)}`);
            }

            // Check if we still have seeds
            const remaining = this.bot.inventory.items().find(i => i.name === seedType);
            if (!remaining) break;
        }

        this.isFarming = false;
        logger.info('Farm', `Planted ${planted} ${seedType}`);
        return planted;
    }

    /**
     * Harvest mature crops nearby.
     */
    async harvest(maxRange: number = 32): Promise<number> {
        if (!this.bot) return 0;
        this.isFarming = true;

        const mcData = require('minecraft-data')(this.bot.version);
        let harvested = 0;

        // Find mature crops
        const cropNames = ['wheat', 'carrots', 'potatoes', 'beetroots'];

        for (const cropName of cropNames) {
            if (!this.isFarming) break;

            const blockType = mcData.blocksByName[cropName];
            if (!blockType) continue;

            const blocks = this.bot.findBlocks({
                matching: blockType.id,
                maxDistance: maxRange,
                count: 64,
            });

            for (const pos of blocks) {
                if (!this.isFarming) break;

                const block = this.bot.blockAt(pos);
                if (!block) continue;

                // Check if mature (getProperties gives the 'age' metadata)
                const props = (block as any).getProperties?.() || {};
                const age = props.age ?? 0;
                const maxAge = cropName === 'beetroots' ? BEETROOT_MATURE : MATURE_AGE;

                if (age < maxAge) continue;

                try {
                    const dist = this.bot.entity.position.distanceTo(pos);
                    if (dist > 4) {
                        await withTimeout(
                            this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)),
                            8000,
                            'Harvest navigate'
                        );
                    }

                    await this.bot.dig(block);
                    harvested++;
                    await sleep(100);
                } catch (e) {
                    logger.debug('Farm', `Harvest failed at ${pos}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }

        this.isFarming = false;
        logger.info('Farm', `Harvested ${harvested} crops`);

        // Auto-replant
        if (harvested > 0) {
            await this.plantSeeds('wheat_seeds');
        }

        return harvested;
    }

    /**
     * Full farm cycle: harvest → replant.
     */
    async farmCycle(): Promise<{ harvested: number; planted: number }> {
        const harvested = await this.harvest();
        const planted = await this.plantSeeds();
        return { harvested, planted };
    }

    stop(): void {
        this.isFarming = false;
        if (this.bot) this.bot.pathfinder.stop();
    }
}
