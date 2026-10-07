#!/usr/bin/env python3
"""Bake vendored CSS/SVG animations into offline PNG frames for the mods sandbox.

Needs Python Pillow, Playwright, and Chromium. Runtime needs none of these.
Run from any directory: python scripts/bake-pets.py --chromium /usr/bin/chromium
"""
import argparse
import base64
import io
import json
import math
import zlib
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SIZE, COLS, BOUNDS_FRAMES = 80, 12, 32
SCALE, FPS = 3, 12


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    source = ROOT / 'assets/clawd-pets'
    catalog = json.loads((source / 'catalog.json').read_text())
    pets = catalog['pets']
    rows = math.ceil(len(pets) / COLS)
    # Separate documents isolate the upstream SVGs' repeated CSS names and IDs.
    documents = [(source / 'svg' / f"clawd-{p['id']}.svg").read_text() for p in pets]
    boxes = [None for _ in pets]
    encoded = [[] for _ in pets]
    with sync_playwright() as play:
        browser = play.chromium.launch(executable_path=args.chromium, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': SIZE * COLS, 'height': SIZE * rows})
        page.route('**/*', lambda route: route.abort())
        page.set_content('<style>body{margin:0;display:grid;grid-template-columns:repeat(12,80px)}iframe{border:0;width:80px;height:80px}</style>')
        for svg in documents:
            page.evaluate('html => { const f=document.createElement("iframe"); f.srcdoc=html; document.body.append(f); }',
                          '<style>html,body{margin:0;width:80px;height:80px;overflow:hidden}svg{width:80px;height:80px}</style>' + svg)
        page.wait_for_function('Array.from(document.querySelectorAll("iframe")).every(f=>f.contentDocument?.querySelector("svg"))')
        loops = page.evaluate('''() => Array.from(document.querySelectorAll('iframe'), f => {
          const animations = f.contentDocument.getAnimations();
          let loop = 1000;
          const gcd = (a,b) => b ? gcd(b,a%b) : a;
          for (const a of animations) {
            a.pause();
            const timing = a.effect.getTiming();
            const d = Math.round(Number(timing.duration) * (timing.direction.includes('alternate') ? 2 : 1));
            if (d > 0) loop = loop / gcd(loop,d) * d;
          }
          // Complex, incommensurate loops are sampled over eight seconds.
          return Math.min(8000, Math.max(2000, loop));
        })''')
        # Find one stable crop per complete animation, at inexpensive resolution.
        for index in range(BOUNDS_FRAMES):
            page.evaluate('''({index,loops,count}) => Array.from(document.querySelectorAll('iframe')).forEach((f,i) => {
              for (const a of f.contentDocument.getAnimations()) a.currentTime = index * loops[i] / count;
            })''', {'index': index, 'loops': loops, 'count': BOUNDS_FRAMES})
            image = Image.open(io.BytesIO(page.screenshot(omit_background=True))).convert('RGBA')
            for i in range(len(pets)):
                x, y = i % COLS * SIZE, i // COLS * SIZE
                box = image.crop((x,y,x+SIZE,y+SIZE)).getbbox()
                if box:
                    old = boxes[i]
                    boxes[i] = (min(old[0],box[0]),min(old[1],box[1]),max(old[2],box[2]),max(old[3],box[3])) if old else box
        for i, box in enumerate(boxes):
            if not box:
                raise ValueError(f"Blank animation: {pets[i]['id']}")
            boxes[i] = (max(0,box[0]-2),max(0,box[1]-2),min(SIZE,box[2]+2),min(SIZE,box[3]+2))
        # Rasterize the original vectors at 3x, never reuse the tiny 80px frames.
        # Encode each crop immediately, keeping memory independent of frame count.
        counts = [math.ceil(loop / 1000 * FPS) for loop in loops]
        page.set_viewport_size({'width': SIZE * COLS, 'height': SIZE * rows})
        high = browser.new_page(viewport={'width': SIZE * COLS, 'height': SIZE * rows}, device_scale_factor=SCALE)
        high.route('**/*', lambda route: route.abort())
        high.set_content('<style>body{margin:0;display:grid;grid-template-columns:repeat(12,80px)}iframe{border:0;width:80px;height:80px}</style>')
        for svg in documents:
            high.evaluate('html => { const f=document.createElement("iframe"); f.srcdoc=html; document.body.append(f); }',
                          '<style>html,body{margin:0;width:80px;height:80px;overflow:hidden}svg{width:80px;height:80px}</style>' + svg)
        high.wait_for_function('Array.from(document.querySelectorAll("iframe")).every(f=>f.contentDocument?.querySelector("svg"))')
        high.evaluate('''() => Array.from(document.querySelectorAll('iframe')).forEach(f => {
          for (const a of f.contentDocument.getAnimations()) a.pause();
        })''')
        contact = Image.new('RGBA', (SIZE * COLS, SIZE * rows), '#241c19')
        for index in range(max(counts)):
            high.evaluate('''({index,loops,counts}) => Array.from(document.querySelectorAll('iframe')).forEach((f,i) => {
              for (const a of f.contentDocument.getAnimations()) a.currentTime = Math.min(index,counts[i]-1) * loops[i] / counts[i];
            })''', {'index': index, 'loops': loops, 'counts': counts})
            image = Image.open(io.BytesIO(high.screenshot(omit_background=True))).convert('RGBA')
            for i in range(len(pets)):
                if index >= counts[i]:
                    continue
                x, y = i % COLS * SIZE * SCALE, i // COLS * SIZE * SCALE
                box = boxes[i]
                frame = image.crop((x+box[0]*SCALE,y+box[1]*SCALE,x+box[2]*SCALE,y+box[3]*SCALE))
                buffer = io.BytesIO()
                frame.save(buffer, format='PNG')
                encoded[i].append(base64.b64encode(buffer.getvalue()).decode())
                if index == counts[i]//4:
                    tile = image.crop((x,y,x+SIZE*SCALE,y+SIZE*SCALE)).resize((SIZE,SIZE), Image.Resampling.LANCZOS)
                    contact.alpha_composite(tile,(i % COLS * SIZE, i // COLS * SIZE))
            if index % 8 == 0 or index == max(counts)-1:
                print(f'Captured high-resolution frame {index + 1}/{max(counts)}', flush=True)
        browser.close()
    for i, pet in enumerate(pets):
        box = boxes[i]
        pet.update(loopMs=loops[i], width=(box[2]-box[0])*SCALE, height=(box[3]-box[1])*SCALE, frames=encoded[i])
    contact.convert('RGB').save(source / 'preview.png')
    pack_pets(pets)
    write_modules(source, pets)
    print(f'Baked {len(pets)} pets; PNG frames require no browser at runtime.')


def pack_pets(pets):
    # One consistent RGBA palette per complete scene, then XOR against the
    # preceding indexed frame. Keyframes bound random seeking to 15 deltas.
    for pet in pets:
        images = [Image.open(io.BytesIO(base64.b64decode(frame))).convert('RGBA') for frame in pet['frames']]
        width, height = pet['width'], pet['height']
        sheet = Image.new('RGBA', (width, height * len(images)))
        for i, image in enumerate(images):
            sheet.paste(image, (0,i*height))
        indexed = sheet.quantize(colors=64, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        pet['palette'] = base64.b64encode(bytes(indexed.getpalette('RGBA'))).decode()
        pet['keyInterval'] = 16
        frames, previous = [], None
        for i in range(len(images)):
            raw = indexed.crop((0,i*height,width,(i+1)*height)).tobytes()
            delta = raw if i % 16 == 0 else bytes(a ^ b for a,b in zip(raw,previous))
            compressor = zlib.compressobj(9,zlib.DEFLATED,-15)
            frames.append(base64.b64encode(compressor.compress(delta)+compressor.flush()).decode())
            previous = raw
        pet['frames'] = frames


def write_modules(source, pets):
    # Claude's loader caps each source file at 1 MiB. Keep chunks below 700 KiB.
    destination = source / 'frames'
    destination.mkdir(exist_ok=True)
    groups, group, size = [], [], 0
    for frame in (frame for pet in pets for frame in pet['frames']):
        data = json.dumps(frame)
        if group and size + len(data) > 700_000:
            groups.append(group)
            group, size = [], 0
        group.append(data)
        size += len(data)
    if group:
        groups.append(group)
    header = '// Generated by scripts/bake-pets.py. Artwork: MIT, see ../LICENSE.\n'
    for i, group in enumerate(groups):
        (destination / f'{i}.mjs').write_text(header + 'export const frames = [' + ','.join(group) + '];\n')
    for obsolete in destination.glob('*.mjs'):
        if obsolete.stem.isdigit() and int(obsolete.stem) >= len(groups):
            obsolete.unlink()
    definitions, offset = [], 0
    for pet in pets:
        metadata = {key:value for key,value in pet.items() if key != 'frames'}
        count = len(pet['frames'])
        definitions.append(json.dumps(metadata,separators=(',', ':'))[:-1] + f',frames:frames.slice({offset},{offset+count})' + '}')
        offset += count
    (source / 'frames.mjs').write_text(
        '// Generated by scripts/bake-pets.py. Artwork: MIT, see LICENSE.\n' +
        ''.join(f'import {{ frames as group{i} }} from "./frames/{i}.mjs";\n' for i in range(len(groups))) +
        'const frames = [' + ','.join(f'...group{i}' for i in range(len(groups))) + '];\n' +
        'export const pets = [' + ','.join(definitions) + '];\n')
    module_bytes = sum(p.stat().st_size for p in destination.glob('*.mjs')) + (source / 'frames.mjs').stat().st_size
    if module_bytes > 7_500_000:
        raise ValueError(f'Packed assets leave no room in the 8 MiB module graph: {module_bytes} bytes')


if __name__ == '__main__':
    main()
