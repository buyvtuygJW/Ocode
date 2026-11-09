// The fallback upstream ref has three malformed context lines in the photon
// 0.3.4 dependency patch. Linux Bun rejects them; Windows Bun may accept them.
// Repair only this exact known hunk, leaving all other upstream patches alone.
const fs = require('node:fs');
const path = require('node:path');

const relative = 'patches/@silvia-odwyer%2Fphoton-node@0.3.4.patch';
const bad = "\n      ;\n  };\n  \n-const path = require('path').join(__dirname, 'photon_rs_bg.wasm');";
const good = "\n     ;\n };\n \n-const path = require('path').join(__dirname, 'photon_rs_bg.wasm');";

function repairText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const before = bad.replaceAll('\n', eol);
  const after = good.replaceAll('\n', eol);
  const parts = text.split(before);
  if (parts.length > 2) throw new Error('Ambiguous photon patch: duplicate known hunk');
  if (parts.length === 2) return { text: parts.join(after), repaired: true };
  return { text, repaired: false };
}

function repairFile(root) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return 'absent';
  const original = fs.readFileSync(file, 'utf8');
  const result = repairText(original);
  if (result.repaired) fs.writeFileSync(file, result.text);
  return result.repaired ? 'repaired' : 'unchanged';
}

if (require.main === module) {
  try {
    console.log(`Photon dependency patch: ${repairFile(process.argv[2] || '.')}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { repairText, repairFile, relative };
