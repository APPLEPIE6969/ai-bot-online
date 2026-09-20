const mcData = require('minecraft-data')('1.21.1');
console.log('ID 9:', mcData.items[9]?.name);
console.log('ID 1228:', mcData.items[1228]?.name);
console.log('ID 35:', mcData.items[35]?.name);
process.exit(0);
