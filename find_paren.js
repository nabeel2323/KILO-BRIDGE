const fs = require('fs');
const lines = fs.readFileSync('C:/TAIF/KILO-BRIDGE/src/app.ts','utf8').split('\n');
let open = 0;
let maxOpen = 0;
let maxLine = -1;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (c === '(') open++;
    if (c === ')') open--;
    if (open > maxOpen) {
      maxOpen = open;
      maxLine = i + 1;
    }
  }
}
console.log('Final count:', open);
console.log('Max open count:', maxOpen);
console.log('Max open at line:', maxLine);
console.log('Last line:', lines.length);
console.log('Line', maxLine, ':', lines[maxLine - 1]);
