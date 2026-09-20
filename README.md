# Modular Autonomous Minecraft AI Bot v2

A sophisticated, modular Minecraft bot built with **TypeScript**, **Mineflayer**, and **AI-driven decision making**. The bot connects to a Minecraft server and autonomously survives, progresses, builds, and interacts with players through natural language chat.

---

## 🎯 Purpose

This bot is designed to be a **fully autonomous Minecraft agent** that can:
- **Survive indefinitely**: Eat, avoid hazards, recover from death, re-equip gear
- **Progress through the game**: Wood → Stone → Iron → Diamond tools & armor automatically
- **Build & farm**: Create shelters, place torches, build farms, harvest crops
- **Explore & navigate**: Pathfind to players, pillars, bridges, return home
- **Chat with AI brain**: Natural language → AI (Gemini/Groq) → bot actions
- **Persist state**: Crash recovery, config hot-reload, periodic backups
- **Modular architecture**: Each capability is a swappable module

> **Future Roadmap**: This codebase is being prepared to become an **MCP (Model Context Protocol) server**, allowing LLMs to directly control the bot via standardized tool calls instead of chat parsing.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        BotManager                               │
│  (Lifecycle: connect, reconnect, module init, graceful shutdown)│
└─────────────────────┬───────────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┬─────────────┬──────────────┐
        ▼             ▼             ▼             ▼              ▼
   ┌─────────┐  ┌──────────┐  ┌───────────┐ ┌──────────┐ ┌───────────┐
   │TaskEngin│  │StateMach.│  │ModeManager│ │EmergencyM.│ │RecoveryM. │
   │(Priority│  │(Valid    │  │(FULL/HALF/│ │(Eat,hazrd,│ │(Crash save│
   │ queue)  │  │transitions)│ │ PASSIVE)  │ │ death rec) │ │ & resume) │
   └────┬────┘  └────┬─────┘  └─────┬─────┘ └────┬─────┘ └─────┬─────┘
        │            │            │             │             │
        └────────────┴────────────┴─────────────┴─────────────┘
                             │
                    ┌────────▼────────┐
                    │   EventBus      │
                    │ (Pub/Sub hub)   │
                    └────────┬────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
┌──────▼──────┐       ┌──────▼──────┐       ┌─────▼─────┐
│  Modules    │       │ Persistence │       │  Config   │
│ (14 modules)│       │(DB,Atomic,  │       │ HotReload │
└─────────────┘       │ BackupMgr)  │       └───────────┘
                      └─────────────┘
```

---

## 📦 Module Catalog (14 Modules)

### Core Modules

| Module | Purpose | Key Features |
|--------|---------|--------------|
| **BotManager** | Top-level lifecycle | Connection, reconnection (exponential backoff), module orchestration, 1.21.x protocol patching |
| **TaskEngine** | Priority task queue | Interruptible tasks, timeouts, retries, FIFO priority queue |
| **StateMachine** | Bot state control | Validated transitions (IDLE, EXECUTING, EMERGENCY, RECOVERING, etc.) |
| **ModeManager** | Autonomy levels | `FULL_AUTO` (no confirm), `HALF_AUTO` (survival auto), `PASSIVE` (all confirm) |
| **EmergencyManager** | Always-on survival | Auto-eat (food ≤14), hazard avoidance (lava/fire/cactus), death recovery, gear re-equip |
| **RecoveryManager** | Crash resilience | Saves task+position on crash, detects crash loops (5→disable auto-resume), resume hints |
| **ConfigHotReload** | Live config updates | Watches `config/config.json`, emits `config:reload` event |
| **PerformanceMonitor** | Resource tracking | Memory thresholds (warn 512MB, kill 1024MB), auto-save on threshold |

### Gameplay Modules

| Module | Purpose | Key Actions (via Chat) |
|--------|---------|------------------------|
| **ChatModule** | AI chat interface | Registers 50+ actions, calls Gemini/Groq, parses JSON responses |
| **NavigationModule** | Movement & pathfinding | `goTo`, `goToPlayer`, `followPlayer`, `stop`, `pillarUp` |
| **MiningModule** | Block breaking & trees | `mineBlock`, `chopTrees`, auto-tool selection (GameKnowledge), item collection |
| **CraftingModule** | Item crafting | `craftItem`, `craftSequence`, delegates to GameKnowledge for smart deps |
| **InventoryModule** | Inventory management | `equipBestArmor`, `listItems`, `discardJunk`, `dropItem` |
| **CombatModule** | Fighting & defense | `attack`, auto-target, threat assessment (GameKnowledge) |
| **StashModule** | Chest storage system | `createStash`, `storeItems`, `retrieveItems`, `stashInfo` (persisted) |
| **ProgressionModule** | Autonomous advancement | `run` (smart loop), `gatherIronContinuously`, goal-driven by GameKnowledge |
| **BuildingModule** | Structure placement | `buildShelter`, `placeTorches`, safe placement (GameKnowledge) |
| **FarmModule** | Agriculture | `createFarm`, `plantSeeds`, `harvest`, `farmCycle` |
| **ExplorationModule** | World discovery | `explore`, `scanForPOIs`, `setHome`, `goHome` |
| **GameKnowledge** | **Brain** for game mechanics | Tool selection, crafting chains, smelting, progression goals, threat levels, combat confidence |

---

## 🧠 GameKnowledge — The "Smart" Layer

`GameKnowledge` is the **central intelligence** that makes the bot understand Minecraft mechanics without hardcoded recipes:

- **Tool Selection**: Uses `minecraft-data` `harvestTools` + material fallback → picks best tool in inventory
- **Crafting Dependency Resolution**: Full chains (e.g., `diamond_pickaxe` → `diamond` + `stick` + `crafting_table` → `planks` → `log`)
- **Smelting Intelligence**: Knows `raw_iron`→`iron_ingot`, best fuel (lava_bucket > coal_block > coal)
- **Progression Goals**: Dynamic priority list based on inventory state:
  1. Eat if hungry & has food
  2. Chop trees if no wood
  3. Craft wooden tools
  4. Mine cobblestone → stone tools
  5. Mine coal → torches + furnace
  6. Mine iron → smelt → iron tools/armor
  7. Mine diamonds → diamond tools
- **Combat Intelligence**: Threat levels (Warden=100, Creeper=40, Zombie=20), combat confidence scoring
- **Safe Placement**: Finds collision-free, supported positions for placing blocks

---

## 💬 Chat Actions (50+ Registered)

The AI can invoke these actions via chat (registered in `src/index.ts`):

**Navigation**: `come`, `follow`, `stop`, `gather_iron_continuously`, `go_home`
**Mining**: `chop_tree`, `mine <block>`, `gather_wood`
**Crafting**: `craft <item>`, `get_wooden_tools`, `get_stone_tools`
**Inventory**: `equip_armor`, `inventory`, `discard_junk`, `drop <item>`
**Stash**: `create_stash <label>`, `store_items`, `retrieve_items <item>`, `stash_info`
**Building**: `build_shelter`, `place_torches`
**Farming**: `create_farm`, `plant_seeds <crop>`, `harvest`, `farm_cycle`
**Exploration**: `explore`, `scan_area`, `set_home`, `exploration_info`
**Progression**: `progress`, `stop_progress`
**Meta**: `set_mode <full_auto|half_auto|passive>`, `status`, `backup`, `recovery_info`, `perf`

---

## 🔧 Configuration

### `config/config.json` (Hot-reloadable)
```json
{
  "mode": "FULL_AUTO",
  "serverHost": "peak.progamer.me",
  "serverPort": 25565,
  "botUsername": "AIBot",
  "confirmationTimeout": 30,
  "autoBuildFarms": true,
  "autoStash": true,
  "maxTaskRetries": 3,
  "autoReconnect": true,
  "reconnectDelayMs": 5000,
  "maxReconnectDelayMs": 60000,
  "apiKeys": { "google": "", "groq": "" },
  "aiModels": ["gemini-2.0-flash", "llama-3.3-70b-versatile"]
}
```

### Environment (`.env` — not committed)
```
GOOGLE_API_KEY=your_key
GROQ_API_KEY=your_key
```

---

## 💾 Persistence & Data

### Files (in `data/`, gitignored)
| File | Purpose |
|------|---------|
| `state.db.json` | Bot mode, position, active task, last saved |
| `stash.db.json` | Stash entries (id, label, x,y,z, items) |
| `recovery.db.json` | Last task, position, crash count, pending action |
| `backups/` | Timestamped snapshots of all `.db.json` (keep 10) |

### Atomic Writes
All JSON writes use **AtomicWriter**: write to `.tmp` → backup old to `.bak` → atomic rename. On read, falls back to `.bak` if main corrupt.

---

## 🤖 AI Integration

### Multi-Provider Fallback (in `index.js` legacy, `ChatModule.ts` TypeScript)
- **Google Gemini**: `gemini-2.0-flash`, `gemini-2.5-flash`, `gemma-3-27b-it`, etc.
- **Groq**: `llama-3.3-70b-versatile`, `qwen/qwen3-32b`, `meta-llama/llama-4-maverick-17b-128e-instruct`, etc.
- **Fallback Chain**: Tries each model in `aiModels` order until one succeeds

### Prompt Engineering (ChatModule)
- Includes bot state (HP, food, position, held item)
- Recent chat history (last 10 messages)
- Available actions list (injected dynamically)
- Special rules: negation handling, "get me iron" → `gather_iron_continuously`

---

## 🚀 Running the Bot

### Prerequisites
- Node.js 18+
- Minecraft server (tested on 1.21.11 via ViaVersion)

### Install
```bash
npm install
npm run build   # compiles TypeScript to dist/
```

### Start
```bash
# Development (ts-node)
npm run dev

# Production (compiled)
npm start

# Legacy JavaScript entry point
npm run legacy
```

### TypeScript Config
- Target: ES2020
- Module: CommonJS
- Strict mode enabled
- Source maps for debugging

---

## 🛡️ Safety & Reliability Features

| Feature | Implementation |
|---------|----------------|
| **Crash Recovery** | `RecoveryManager` saves state on `uncaughtException`/`unhandledRejection`/`SIGINT` |
| **Crash Loop Detection** | Stops auto-resume after 5 consecutive crashes |
| **Auto-Reconnect** | Exponential backoff (5s → 7.5s → 11.25s... max 60s) |
| **Memory Monitoring** | Warns at 512MB, forces state save at 1024MB |
| **Atomic Persistence** | Temp file + backup + atomic rename |
| **Periodic Backups** | Every 5 minutes, keep 10, integrity-validated |
| **Graceful Shutdown** | SIGINT/SIGTERM → save state → cancel tasks → cleanup modules → quit |
| **Timeout Guards** | All navigation/crafting/mining have configurable timeouts |
| **Async Locks** | `MiningModule` uses `AsyncLock` to prevent concurrent digs |

---

## 📁 Project Structure

```
ai-bot-online/
├── .gitignore
├── package.json
├── tsconfig.json
├── index.js              # Legacy JS entry (with hardcoded keys → placeholders)
├── src/
│   ├── index.ts          # Main TypeScript entry point
│   ├── core/
│   │   ├── BotManager.ts
│   │   ├── TaskEngine.ts
│   │   ├── StateMachine.ts
│   │   ├── ModeManager.ts
│   │   ├── EmergencyManager.ts
│   │   ├── RecoveryManager.ts
│   │   ├── ConfigHotReload.ts
│   │   ├── PerformanceMonitor.ts
│   │   └── EventBus.ts
│   ├── modules/
│   │   ├── Chat/ChatModule.ts
│   │   ├── Navigation/NavigationModule.ts
│   │   ├── Mining/MiningModule.ts
│   │   ├── Crafting/CraftingModule.ts
│   │   ├── Inventory/InventoryModule.ts
│   │   ├── Combat/CombatModule.ts
│   │   ├── Stash/StashModule.ts
│   │   ├── Progression/ProgressionModule.ts
│   │   ├── Building/BuildingModule.ts
│   │   ├── Farm/FarmModule.ts
│   │   ├── Exploration/ExplorationModule.ts
│   │   └── GameKnowledge/GameKnowledge.ts
│   ├── persistence/
│   │   ├── Database.ts
│   │   ├── AtomicWriter.ts
│   │   └── BackupManager.ts
│   ├── types/
│   │   ├── interfaces.ts
│   │   └── enums.ts
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── math.ts
│   │   └── safety.ts
│   └── data/
│       ├── config.json
│       ├── social.json
│       └── stashes.json
├── data/                 # Runtime data (gitignored)
│   ├── state.db.json
│   ├── stash.db.json
│   ├── recovery.db.json
│   └── backups/
├── config/               # Hot-reload config (gitignored)
│   └── config.json
├── auth_cache/           # Microsoft auth tokens (gitignored)
└── node_modules/         # Dependencies (gitignored)
```

---

## 🔮 Future: MCP Server Integration

This codebase is **architected for MCP (Model Context Protocol)**:

### Current State
- All capabilities exposed as **module methods** (e.g., `navigationModule.goToPlayer()`)
- `ChatModule` registers actions as string→handler map
- EventBus provides pub/sub for external hooks

### Planned MCP Tools
| MCP Tool | Maps To |
|----------|---------|
| `bot.move_to` | `NavigationModule.goTo(x,y,z)` |
| `bot.follow_player` | `NavigationModule.followPlayer(name)` |
| `bot.mine_block` | `MiningModule.mineBlock(name, count)` |
| `bot.chop_trees` | `MiningModule.chopTrees(count)` |
| `bot.craft_item` | `CraftingModule.craftItem(name, count)` |
| `bot.equip_armor` | `InventoryModule.equipBestArmor()` |
| `bot.create_stash` | `StashModule.createStash(label)` |
| `bot.store_items` | `StashModule.storeItems()` |
| `bot.build_shelter` | `BuildingModule.buildShelter()` |
| `bot.create_farm` | `FarmModule.createFarm()` |
| `bot.explore` | `ExplorationModule.explore(radius)` |
| `bot.set_mode` | `ModeManager.setMode(mode)` |
| `bot.get_status` | Aggregated status from all modules |

### Benefits
- **Standardized interface** for any LLM to control the bot
- **No chat parsing ambiguity** — structured tool calls with typed parameters
- **Composable workflows** — LLMs can chain tools programmatically
- **Observability** — Every tool call logged with inputs/outputs

---

## 🤝 Contributing

1. Fork & clone
2. Create feature branch
3. Add tests (see `rbx-unit-test` skill)
4. Run `npm run build` and `npm run lint` (if configured)
5. Submit PR

---

## 📄 License

ISC License — see `package.json`

---

## 🙏 Acknowledgments

- **Mineflayer** — Minecraft bot framework
- **mineflayer-pathfinder** — A* pathfinding
- **minecraft-data** — Versioned game data
- **Google Gemini / Groq** — AI providers
- **TypeScript** — Type safety