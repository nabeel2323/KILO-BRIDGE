const fs = require('fs');
const raw = fs.readFileSync('C:/TAIF/KILO-BRIDGE/debug-config-kiloconfig.json');
// Strip UTF-8 BOM if present
let clean = raw;
if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
  clean = raw.slice(3);
}
const c = JSON.parse(clean);
console.log('permission.bash:', c.permission.bash);
console.log('permission.read:', c.permission.read);
console.log('permission.external_directory:', c.permission.external_directory);
console.log('permission_origins.bash:', JSON.stringify(c.permission_origins.bash));
console.log('permission_origins.read:', JSON.stringify(c.permission_origins.read));