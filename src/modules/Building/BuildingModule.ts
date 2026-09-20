import { Bot } from 'mineflayer';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';
import { Vec3 } from 'vec3';

/**
 * A blueprint is a 3D array of block placements, defined layer by layer (Y-up).
 * Each layer is a 2D grid [z][x] of block names. Empty string = air.
 */
export interface Blueprint {
    name: string;
    /** layers[y][z][x] = block name or '' for air */
    layers: string[][][];
    /** Size in blocks */
    sizeX: number;
    sizeY: number;
    sizeZ: number;
}

/**
 * Building Module
 * Handles blueprint-based building, block placement, and simple structures.
 */
export class BuildingModule implements Module {
    name = 'BuildingModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private isBuilding = false;

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Building', 'Building module initialized');
    }

    async cleanup(): Promise<void> {
        this.isBuilding = false;
        this.bot = null;
    }

    /**
     * Build a blueprint at the given origin position, layer by layer.
     */
    async buildBlueprint(blueprint: Blueprint, origin: Vec3): Promise<{ placed: number; failed: number }> {
        if (!this.bot) return { placed: 0, failed: 0 };
        this.isBuilding = true;

        let placed = 0, failed = 0;
        logger.info('Building', `Building "${blueprint.name}" at ${origin} (${blueprint.sizeX}x${blueprint.sizeY}x${blueprint.sizeZ})`);

        for (let y = 0; y < blueprint.sizeY && this.isBuilding; y++) {
            const layer = blueprint.layers[y];
            if (!layer) continue;

            for (let z = 0; z < blueprint.sizeZ && this.isBuilding; z++) {
                const row = layer[z];
                if (!row) continue;

                for (let x = 0; x < blueprint.sizeX && this.isBuilding; x++) {
                    const blockName = row[x];
                    if (!blockName || blockName === '' || blockName === 'air') continue;

                    const targetPos = origin.offset(x, y, z);
                    const ok = await this.placeBlockAt(blockName, targetPos);
                    if (ok) placed++;
                    else failed++;
                }
            }

            logger.info('Building', `Layer ${y + 1}/${blueprint.sizeY} done (placed: ${placed}, failed: ${failed})`);
        }

        this.isBuilding = false;
        this.eventBus?.emit('building:complete', { name: blueprint.name, placed, failed });
        return { placed, failed };
    }

    /**
     * Build a simple shelter (5x4x5 cobblestone box with a door opening).
     */
    async buildShelter(origin?: Vec3): Promise<boolean> {
        if (!this.bot) return false;
        const pos = origin || this.bot.entity.position.offset(3, 0, 0).floored();

        const blueprint = this.createShelterBlueprint();
        const result = await this.buildBlueprint(blueprint, pos);
        return result.placed > 0;
    }

    /**
     * Build a platform of given size and material.
     */
    async buildPlatform(width: number, depth: number, material: string = 'cobblestone', origin?: Vec3): Promise<number> {
        if (!this.bot) return 0;
        const pos = origin || this.bot.entity.position.offset(2, -1, 0).floored();
        let placed = 0;

        for (let z = 0; z < depth && this.isBuilding !== false; z++) {
            for (let x = 0; x < width; x++) {
                const ok = await this.placeBlockAt(material, pos.offset(x, 0, z));
                if (ok) placed++;
            }
        }

        return placed;
    }

    /**
     * Place torches in a grid pattern for lighting.
     */
    async placeTorches(centerPos: Vec3, radius: number = 5, spacing: number = 4): Promise<number> {
        if (!this.bot) return 0;
        let placed = 0;

        for (let x = -radius; x <= radius; x += spacing) {
            for (let z = -radius; z <= radius; z += spacing) {
                const ok = await this.placeBlockAt('torch', centerPos.offset(x, 0, z));
                if (ok) placed++;
            }
        }

        logger.info('Building', `Placed ${placed} torches`);
        return placed;
    }

    stop(): void {
        this.isBuilding = false;
    }

    // ─── Internal ───────────────────────────────────────

    private async placeBlockAt(blockName: string, pos: Vec3): Promise<boolean> {
        if (!this.bot) return false;

        // Check if position already has the right block
        const existing = this.bot.blockAt(pos);
        if (existing && existing.name === blockName) return true;
        if (existing && existing.name !== 'air' && existing.name !== 'water' && existing.name !== 'grass' && existing.name !== 'tall_grass') {
            return false; // Don't replace non-air blocks
        }

        // Find the block in inventory
        const item = this.bot.inventory.items().find(i => i.name === blockName || i.name.includes(blockName));
        if (!item) return false;

        try {
            await this.bot.equip(item, 'hand');

            // Need a reference block adjacent to placement
            const refOffsets = [
                new Vec3(0, -1, 0), // below
                new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
                new Vec3(0, 0, 1), new Vec3(0, 0, -1),
                new Vec3(0, 1, 0), // above
            ];

            for (const offset of refOffsets) {
                const refBlock = this.bot.blockAt(pos.minus(offset));
                if (refBlock && refBlock.name !== 'air' && refBlock.name !== 'water') {
                    try {
                        await this.bot.placeBlock(refBlock, offset);
                        await sleep(100);
                        return true;
                    } catch (_) {
                        continue;
                    }
                }
            }
        } catch (e) {
            logger.debug('Building', `Place failed at ${pos}: ${e instanceof Error ? e.message : String(e)}`);
        }

        return false;
    }

    private createShelterBlueprint(): Blueprint {
        const W = 'cobblestone'; // Wall
        const A = '';             // Air
        const D = '';             // Door opening (air)

        // 5x4x5 shelter
        return {
            name: 'Simple Shelter',
            sizeX: 5, sizeY: 4, sizeZ: 5,
            layers: [
                // Floor (y=0)
                [
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                ],
                // Walls layer 1 (y=1)
                [
                    [W, W, D, W, W],
                    [W, A, A, A, W],
                    [W, A, A, A, W],
                    [W, A, A, A, W],
                    [W, W, W, W, W],
                ],
                // Walls layer 2 (y=2)
                [
                    [W, W, D, W, W],
                    [W, A, A, A, W],
                    [W, A, A, A, W],
                    [W, A, A, A, W],
                    [W, W, W, W, W],
                ],
                // Roof (y=3)
                [
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                    [W, W, W, W, W],
                ],
            ],
        };
    }
}
