// SPDX-License-Identifier: MIT
// Indexed, delta-compressed animation frames; PNG output uses nearest-neighbor
// enlargement so the terminal never stretches a tiny picture into a blurred one.
import { inflateSync, deflateSync } from "./vendor/fflate.mjs";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function decode64(text) {
  const length = Math.floor(text.length * 3 / 4) - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
  const bytes = new Uint8Array(length);
  let value = 0, bits = 0, index = 0;
  for (const char of text) {
    if (char === "=") break;
    value = (value << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (value >> bits) & 255;
    }
  }
  return bytes;
}

function encode64(bytes) {
  const result = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | ((bytes[i+1] ?? 0) << 8) | (bytes[i+2] ?? 0);
    result.push(alphabet[value >>> 18], alphabet[value >>> 12 & 63], i+1 < bytes.length ? alphabet[value >>> 6 & 63] : "=", i+2 < bytes.length ? alphabet[value & 63] : "=");
  }
  return result.join("");
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c >>> 0;
}
function uint32(out, offset, n) {
  out[offset] = n >>> 24; out[offset+1] = n >>> 16; out[offset+2] = n >>> 8; out[offset+3] = n;
}
function chunk(name, data) {
  const out = new Uint8Array(data.length + 12);
  uint32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[i+4] = name.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < data.length + 8; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
  uint32(out, data.length + 8, (crc ^ 0xffffffff) >>> 0);
  return out;
}

export function indexedPNG(pixels, palette, width, height) {
  const scale = 2, w = width * scale, h = height * scale;
  const header = new Uint8Array(13);
  uint32(header, 0, w); uint32(header, 4, h);
  header[8] = 8; header[9] = 3; // 8-bit palette, lossless PNG.
  const rgb = new Uint8Array(palette.length / 4 * 3);
  const alpha = new Uint8Array(palette.length / 4);
  for (let i = 0; i < alpha.length; i++) {
    rgb.set(palette.subarray(i*4,i*4+3),i*3); alpha[i] = palette[i*4+3];
  }
  const scan = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) scan[y*(w+1)+x+1] = pixels[Math.floor(y/scale)*width + Math.floor(x/scale)];
  let a = 1, b = 0;
  for (const value of scan) { a = (a+value)%65521; b = (b+a)%65521; }
  const compressed = deflateSync(scan, { level: 1 });
  const zlib = new Uint8Array(compressed.length + 6);
  zlib.set([0x78,0x01]); zlib.set(compressed,2); uint32(zlib,zlib.length-4,((b<<16)|a)>>>0);
  const chunks = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk("IHDR",header),chunk("PLTE",rgb),chunk("tRNS",alpha),chunk("IDAT",zlib),chunk("IEND",new Uint8Array())];
  const out = new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));
  let offset = 0;
  for (const c of chunks) { out.set(c,offset); offset += c.length; }
  return encode64(out);
}

// Only the current scene is cached; random collection cannot grow memory forever.
let cachedPet, cachedIndex = -1, cachedPixels, cachedPalette, cachedPNG;
export function decodePetFrame(pet, index) {
  if (pet !== cachedPet) {
    cachedPet = pet; cachedIndex = -1; cachedPixels = undefined;
    cachedPalette = decode64(pet.palette);
  }
  if (index === cachedIndex && cachedPNG) return { png: cachedPNG };
  const key = Math.floor(index / pet.keyInterval) * pet.keyInterval;
  if (cachedIndex < key || cachedIndex > index || !cachedPixels) {
    cachedPixels = inflateSync(decode64(pet.frames[key]));
    cachedIndex = key;
  }
  while (cachedIndex < index) {
    const diff = inflateSync(decode64(pet.frames[++cachedIndex]));
    for (let i = 0; i < diff.length; i++) cachedPixels[i] ^= diff[i];
  }
  cachedPNG = indexedPNG(cachedPixels,cachedPalette,pet.width,pet.height);
  return { png: cachedPNG };
}
