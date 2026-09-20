const mcData = require('minecraft-data')('1.21.1');

const stoneId = mcData.blocksByName.stone.id;
console.log('Stone ID:', stoneId);

const blockFromId = mcData.blocks[stoneId];
console.log('Block from ID:', blockFromId ? blockFromId.name : 'null');
console.log('HarvestTools keys:', blockFromId && blockFromId.harvestTools ? Object.keys(blockFromId.harvestTools) : 'null');

process.exit(0);
