'use strict';

// Renders assets/icon.svg into the raster icons electron-builder needs:
//   assets/icon.png   (1024x1024, used on Linux & as the in-app/dock icon)
//   assets/icon.ico   (Windows)
//   assets/icon.icns  (macOS)

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, 'assets');
const SVG = path.join(ASSETS, 'icon.svg');

async function main() {
  let sharp, png2icons;
  try {
    sharp = require('sharp');
    png2icons = require('png2icons');
  } catch (e) {
    console.error('Missing dev dependencies. Run: npm install');
    throw e;
  }

  const svg = fs.readFileSync(SVG);
  const pngBuf = await sharp(svg, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngBuf);
  console.log('wrote assets/icon.png');

  const ico = png2icons.createICO(pngBuf, png2icons.BILINEAR, 0, false, true);
  if (ico) { fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico); console.log('wrote assets/icon.ico'); }

  const icns = png2icons.createICNS(pngBuf, png2icons.BILINEAR, 0);
  if (icns) { fs.writeFileSync(path.join(ASSETS, 'icon.icns'), icns); console.log('wrote assets/icon.icns'); }
}

main().catch((e) => { console.error(e); process.exit(1); });
