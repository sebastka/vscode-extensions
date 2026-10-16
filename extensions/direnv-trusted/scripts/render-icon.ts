import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

// The Marketplace requires a PNG icon of at least 128x128 pixels.
const svg = await readFile('images/icon.svg', 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 } }).render().asPng();
await writeFile('images/icon.png', png);
