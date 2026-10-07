# Clawd Pets artwork

148 SVG scenes from https://github.com/abderrahimghazali/clawd-pet,
revision `b208f0c04a4084a17f4e5f5adf5198a752be0b36`.

Copyright (c) 2026 Abderrahim GHAZALI. MIT license: see [LICENSE](LICENSE).
Clawd is Anthropic's mascot; this is an unofficial fan project.

`svg/` preserves all original files. `catalog.json` preserves gallery order
and categories. `frames/` contains generated PNG frames as ES modules,
loaded through `frames.mjs`. Each file stays below Claude's 1 MiB source limit.
`preview.png` is a contact sheet of all included scenes.

Rebuild from the repository root with:

```sh
python scripts/bake-pets.py --chromium /usr/bin/chromium
```

Build-only prerequisites: Python Pillow, Playwright, and Chromium. The script
isolates each SVG in a separate document, pauses and seeks its CSS animations,
captures 32 samples per loop, trims transparent padding across the entire
loop, and stores transparent PNGs. Browser networking is disabled. Complicated
loops are capped at eight seconds; runtime image updates are capped at 8 fps.
No browser, renderer, dependency install, or network access is needed at runtime.
