import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { EventBus } from './EventBus';
import { StateMachine } from './StateMachine';
import { TaskEngine } from './TaskEngine';
import { ModeManager } from './ModeManager';
import { EmergencyManager } from './EmergencyManager';
import { Database } from '../persistence/Database';
import { BotState } from '../types/enums';
import { BotConfig, Module } from '../types/interfaces';
import { logger } from '../utils/logger';
import { sleep } from '../utils/math';

// ─── Patch: Register 1.21.x support using 1.21.1 data ─────
const mcDataLib = require('minecraft-data');
const mcpc = mcDataLib.versions.pc;
const base = mcpc.find((v: any) => v.minecraftVersion === '1.21.1');
if (base) {
    if (!mcpc.find((v: any) => v.minecraftVersion === '1.21.11')) {
        const patched = { ...base, minecraftVersion: '1.21.11', version: base.version };
        mcpc.push(patched);
        mcDataLib.supportedVersions.pc.push('1.21.11');
        if (mcDataLib.versionsByMinecraftVersion?.pc) mcDataLib.versionsByMinecraftVersion.pc['1.21.11'] = patched;
    }
    ['1.21.2', '1.21.3', '1.21.4'].forEach((ver: string) => {
        if (!mcpc.find((v: any) => v.minecraftVersion === ver)) {
            const p = { ...base, minecraftVersion: ver, version: base.version };
            mcpc.push(p);
            mcDataLib.supportedVersions.pc.push(ver);
            if (mcDataLib.versionsByMinecraftVersion?.pc) mcDataLib.versionsByMinecraftVersion.pc[ver] = p;
        }
    });
    logger.info('BotManager', 'Registered 1.21.x variants for ViaFabric/ViaVersion compatibility.');
}

/**
 * Top-level bot lifecycle manager.
 * Handles connection, reconnection, module initialization, and shutdown.
 */
export class BotManager {
    bot: Bot | null = null;
    readonly eventBus: EventBus;
    readonly stateMachine: StateMachine;
    readonly taskEngine: TaskEngine;
    readonly modeManager: ModeManager;
    readonly emergencyManager: EmergencyManager;
    readonly database: Database;

    private config: BotConfig;
    private modules: Module[] = [];
    private reconnectAttempts = 0;
    private isShuttingDown = false;

    constructor() {
        this.database = new Database();
        this.config = this.database.getConfig();
        this.eventBus = new EventBus();
        this.stateMachine = new StateMachine(this.eventBus);
        this.taskEngine = new TaskEngine(this.eventBus, this.stateMachine);
        this.modeManager = new ModeManager(this.eventBus, this.database);
        this.emergencyManager = new EmergencyManager(this.eventBus, this.stateMachine, this.taskEngine);
    }

    /**
     * Register a module to be initialized on bot spawn.
     */
    registerModule(module: Module): void {
        this.modules.push(module);
        logger.info('BotManager', `Module registered: ${module.name}`);
    }

    /**
     * Start the bot: connect, init modules, begin loop.
     */
    async start(): Promise<void> {
        this.stateMachine.transition(BotState.CONNECTING);

        try {
            this.bot = this.createBot();
            this.setupEventHandlers(this.bot);
        } catch (e) {
            logger.error('BotManager', `Failed to create bot: ${e instanceof Error ? e.message : String(e)}`);
            await this.handleReconnect();
        }
    }

    /**
     * Gracefully stop the bot.
     */
    async stop(): Promise<void> {
        this.isShuttingDown = true;
        logger.info('BotManager', 'Shutting down...');

        // Save state
        if (this.bot) {
            this.database.saveState({
                position: this.bot.entity?.position
                    ? { x: Math.floor(this.bot.entity.position.x), y: Math.floor(this.bot.entity.position.y), z: Math.floor(this.bot.entity.position.z) }
                    : null,
            });
        }

        // Cancel all tasks
        await this.taskEngine.cancelAll('Bot shutting down');

        // Cleanup modules
        for (const module of this.modules) {
            try {
                await module.cleanup();
            } catch (e) {
                logger.error('BotManager', `Module cleanup error (${module.name}): ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // Cleanup emergency manager
        this.emergencyManager.cleanup();

        // Disconnect
        if (this.bot) {
            this.bot.quit();
            this.bot = null;
        }

        this.stateMachine.transition(BotState.DISCONNECTED);
        logger.info('BotManager', 'Shutdown complete');
    }

    // ─── Internal ─────────────────────────────────────────

    private createBot(): Bot {
        logger.info('BotManager', `Connecting to ${this.config.serverHost}:${this.config.serverPort} as "${this.config.botUsername}"...`);

        // Force mineflayer and protocol to accept 1.21.11
        const mcProtocol = require('minecraft-protocol');
        if (mcProtocol.supportedVersions && !mcProtocol.supportedVersions.includes('1.21.11')) {
            mcProtocol.supportedVersions.push('1.21.11');
        }

        const bot = mineflayer.createBot({
            host: this.config.serverHost,
            port: this.config.serverPort,
            username: this.config.botUsername,
            auth: 'offline',
            version: '1.21.11',
            hideErrors: false,
        });

        // Intercept ping to bypass protocol 774 unsupported error
        if ((bot as any)._client) {
            const client = (bot as any)._client;
            if (!client.autoVersionHooks) client.autoVersionHooks = [];
            client.autoVersionHooks.push((response: any, clientObj: any, optionsObj: any) => {
                if (response && response.version && response.version.protocol === 774) {
                    logger.info('BotManager', 'Intercepted protocol 774 ping -> downgrading to 767 (1.21.1) for schemas');
                    response.version.protocol = 767;
                    clientObj.version = '1.21.1';
                    optionsObj.version = '1.21.1';
                    optionsObj.protocolVersion = 767;
                }
            });
        }

        // Load pathfinder
        bot.loadPlugin(pathfinder);

        return bot;
    }

    private setupEventHandlers(bot: Bot): void {
        bot.once('spawn', async () => {
            logger.info('BotManager', `Bot spawned at ${bot.entity.position}`);
            this.reconnectAttempts = 0;

            // Setup pathfinder
            const mcData = require('minecraft-data')(bot.version);
            const defaultMovements = new Movements(bot);
            defaultMovements.canDig = true;
            defaultMovements.allow1by1towers = true;
            bot.pathfinder.setMovements(defaultMovements);

            // Init emergency manager (always active)
            this.emergencyManager.init(bot);

            // Init all modules
            for (const module of this.modules) {
                try {
                    await module.init(bot, this.eventBus);
                    logger.info('BotManager', `Module initialized: ${module.name}`);
                } catch (e) {
                    logger.error('BotManager', `Module init error (${module.name}): ${e instanceof Error ? e.message : String(e)}`);
                }
            }

            this.stateMachine.transition(BotState.IDLE);
            logger.info('BotManager', `Ready! Mode: ${this.modeManager.getMode()}`);
            bot.chat(`I'm online! Mode: ${this.modeManager.getMode()}`);

            // Emit bot:ready so GameKnowledge and other systems can initialize
            this.eventBus.emit('bot:ready' as any, { bot });
        });

        bot.on('error', (err) => {
            logger.error('BotManager', `Bot error: ${err.message}`);
        });

        bot.on('kicked', (reason) => {
            logger.warn('BotManager', `Kicked: ${reason}`);
            this.handleDisconnect();
        });

        bot.on('end', (reason) => {
            logger.warn('BotManager', `Disconnected: ${reason}`);
            this.handleDisconnect();
        });
    }

    private async handleDisconnect(): Promise<void> {
        if (this.isShuttingDown) return;

        // Save state before anything
        this.database.saveState({
            activeTaskId: this.taskEngine.getCurrentTaskName(),
        });

        this.stateMachine.transition(BotState.DISCONNECTED);
        this.emergencyManager.cleanup();
        await this.taskEngine.cancelAll('Disconnected');

        if (this.config.autoReconnect) {
            await this.handleReconnect();
        }
    }

    private async handleReconnect(): Promise<void> {
        if (this.isShuttingDown) return;

        this.reconnectAttempts++;
        const delay = Math.min(
            this.config.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1),
            this.config.maxReconnectDelayMs
        );

        logger.info('BotManager', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);
        await sleep(delay);

        if (!this.isShuttingDown) {
            this.bot = null;
            await this.start();
        }
    }
}
