import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { Database } from '../../persistence/Database';
import { logger } from '../../utils/logger';
import { sleep, generateId } from '../../utils/math';
import { withTimeout } from '../../utils/safety';
import { Vec3 } from 'vec3';

/** A point of interest discovered during exploration */
export interface POI {
    id: string;
    type: 'village' | 'dungeon' | 'mineshaft' | 'stronghold' | 'portal' | 'ore_vein' | 'landmark' | 'custom';
    label: string;
    x: number;
    y: number;
    z: number;
    discoveredAt: number;
}

/** A mapped chunk record */
interface ChunkRecord {
    chunkX: number;
    chunkZ: number;
    exploredAt: number;
    biome: string;
}

/**
 * Exploration Module
 * Systematic world exploration: spiral outward, record POIs, track explored chunks.
 */
export class ExplorationModule implements Module {
    name = 'ExplorationModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private isExploring = false;
    private pois: POI[] = [];
    private exploredChunks: Set<string> = new Set();
    private homePosition: Vec3 | null = null;

    constructor(private database: Database) { }

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        this.homePosition = new Vec3(
            bot.entity.position.x,
            bot.entity.position.y,
            bot.entity.position.z
        );
        logger.info('Exploration', 'Exploration module initialized');
    }

    async cleanup(): Promise<void> {
        this.isExploring = false;
        this.bot = null;
    }

    /**
     * Explore outward from current position in a spiral pattern.
     * @param maxChunks Maximum number of chunks to explore
     * @param chunkRadius Radius per step (in chunks, 16 blocks each)
     */
    async explore(maxChunks: number = 25, chunkRadius: number = 3): Promise<{ chunksExplored: number; poisFound: number }> {
        if (!this.bot) return { chunksExplored: 0, poisFound: 0 };
        this.isExploring = true;

        const startPos = this.bot.entity.position.clone();
        let chunksExplored = 0;
        let poisFound = 0;

        // Spiral exploration: move outward in a square spiral
        const directions = [
            new Vec3(1, 0, 0),   // East
            new Vec3(0, 0, 1),   // South
            new Vec3(-1, 0, 0),  // West
            new Vec3(0, 0, -1),  // North
        ];

        let stepSize = 1;
        let dirIndex = 0;
        let stepsInDirection = 0;
        let turnsAtThisStep = 0;

        for (let i = 0; i < maxChunks && this.isExploring; i++) {
            const dir = directions[dirIndex % 4];
            const targetX = startPos.x + dir.x * stepSize * chunkRadius * 16;
            const targetZ = startPos.z + dir.z * stepSize * chunkRadius * 16;

            // Navigate there
            try {
                await withTimeout(
                    this.bot.pathfinder.goto(new goals.GoalXZ(targetX, targetZ)),
                    30000,
                    'Explore navigate'
                );
            } catch (e) {
                logger.debug('Exploration', `Couldn't reach (${targetX}, ${targetZ}), trying next`);
            }

            // Record this chunk
            const chunkKey = this.getChunkKey(this.bot.entity.position);
            if (!this.exploredChunks.has(chunkKey)) {
                this.exploredChunks.add(chunkKey);
                chunksExplored++;
            }

            // Scan for POIs
            const newPois = await this.scanForPOIs();
            poisFound += newPois;

            // Spiral logic
            stepsInDirection++;
            if (stepsInDirection >= stepSize) {
                stepsInDirection = 0;
                dirIndex++;
                turnsAtThisStep++;
                if (turnsAtThisStep >= 2) {
                    turnsAtThisStep = 0;
                    stepSize++;
                }
            }

            await sleep(1000);
        }

        this.isExploring = false;
        logger.info('Exploration', `Explored ${chunksExplored} chunks, found ${poisFound} POIs`);
        this.eventBus?.emit('exploration:complete', { chunksExplored, poisFound });
        return { chunksExplored, poisFound };
    }

    /**
     * Scan the area around the bot for points of interest.
     */
    async scanForPOIs(): Promise<number> {
        if (!this.bot) return 0;
        let found = 0;

        const mcData = require('minecraft-data')(this.bot.version);
        const pos = this.bot.entity.position;

        // Check for ore veins
        const oreScans = [
            { name: 'diamond_ore', type: 'ore_vein' as const, label: 'Diamond Vein' },
            { name: 'emerald_ore', type: 'ore_vein' as const, label: 'Emerald Vein' },
            { name: 'ancient_debris', type: 'ore_vein' as const, label: 'Ancient Debris' },
        ];

        for (const scan of oreScans) {
            const blockType = mcData.blocksByName[scan.name];
            if (!blockType) continue;

            const oreBlocks = this.bot.findBlocks({
                matching: blockType.id,
                maxDistance: 32,
                count: 1,
            });

            if (oreBlocks.length > 0) {
                const orePos = oreBlocks[0];
                if (!this.hasPOINear(orePos.x, orePos.y, orePos.z, 32)) {
                    this.addPOI(scan.type, scan.label, orePos.x, orePos.y, orePos.z);
                    found++;
                }
            }
        }

        // Check for village structures (look for village-specific blocks)
        const villageBlocks = ['bell', 'blast_furnace', 'smoker', 'composter', 'lectern'];
        for (const vBlock of villageBlocks) {
            const blockType = mcData.blocksByName[vBlock];
            if (!blockType) continue;

            const blocks = this.bot.findBlocks({
                matching: blockType.id,
                maxDistance: 64,
                count: 1,
            });

            if (blocks.length > 0) {
                const bPos = blocks[0];
                if (!this.hasPOINear(bPos.x, bPos.y, bPos.z, 64)) {
                    this.addPOI('village', `Village (${vBlock})`, bPos.x, bPos.y, bPos.z);
                    found++;
                    break; // One village POI is enough
                }
            }
        }

        // Check for dungeon spawners
        const spawner = mcData.blocksByName['spawner'];
        if (spawner) {
            const spawnerBlocks = this.bot.findBlocks({
                matching: spawner.id,
                maxDistance: 32,
                count: 1,
            });
            if (spawnerBlocks.length > 0) {
                const sPos = spawnerBlocks[0];
                if (!this.hasPOINear(sPos.x, sPos.y, sPos.z, 16)) {
                    this.addPOI('dungeon', 'Dungeon Spawner', sPos.x, sPos.y, sPos.z);
                    found++;
                }
            }
        }

        // Check for nether portal
        const portal = mcData.blocksByName['nether_portal'];
        if (portal) {
            const portalBlocks = this.bot.findBlocks({
                matching: portal.id,
                maxDistance: 64,
                count: 1,
            });
            if (portalBlocks.length > 0) {
                const pPos = portalBlocks[0];
                if (!this.hasPOINear(pPos.x, pPos.y, pPos.z, 16)) {
                    this.addPOI('portal', 'Nether Portal', pPos.x, pPos.y, pPos.z);
                    found++;
                }
            }
        }

        return found;
    }

    /**
     * Get home position (spawn/first connect).
     */
    getHome(): Vec3 | null {
        return this.homePosition;
    }

    /**
     * Set a custom home position.
     */
    setHome(pos: Vec3): void {
        this.homePosition = pos;
        logger.info('Exploration', `Home set to (${pos.x}, ${pos.y}, ${pos.z})`);
    }

    /**
     * Navigate back home.
     */
    async goHome(): Promise<boolean> {
        if (!this.bot || !this.homePosition) return false;
        try {
            await withTimeout(
                this.bot.pathfinder.goto(new goals.GoalNear(this.homePosition.x, this.homePosition.y, this.homePosition.z, 3)),
                60000,
                'Go home'
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get all discovered POIs.
     */
    getPOIs(): POI[] {
        return [...this.pois];
    }

    /**
     * Get a summary of exploration.
     */
    getSummary(): string {
        return `Explored ${this.exploredChunks.size} chunks | ${this.pois.length} POIs: ${this.pois.map(p => `${p.label}@(${p.x},${p.y},${p.z})`).join(', ')}`;
    }

    stop(): void {
        this.isExploring = false;
        if (this.bot) this.bot.pathfinder.stop();
    }

    // ─── Internal ───────────────────────────────────────

    private addPOI(type: POI['type'], label: string, x: number, y: number, z: number): void {
        const poi: POI = { id: generateId(), type, label, x, y, z, discoveredAt: Date.now() };
        this.pois.push(poi);
        this.eventBus?.emit('exploration:poi', poi);
        logger.info('Exploration', `★ POI: ${label} at (${x}, ${y}, ${z})`);
        if (this.bot) this.bot.chat(`Found: ${label} at (${x}, ${y}, ${z})!`);
    }

    private hasPOINear(x: number, y: number, z: number, radius: number): boolean {
        return this.pois.some(p =>
            Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2) < radius
        );
    }

    private getChunkKey(pos: Vec3): string {
        return `${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`;
    }
}
