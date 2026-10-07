# Clawd Pets artwork

148 SVG scenes from https://github.com/abderrahimghazali/clawd-pet,
revision `b208f0c04a4084a17f4e5f5adf5198a752be0b36`.

Copyright (c) 2026 Abderrahim GHAZALI. MIT license: see [LICENSE](LICENSE).
Clawd is Anthropic's mascot; this is an unofficial fan project.

`svg/` preserves all original files. `catalog.json` preserves gallery order
and categories. `frames/` contains palette-indexed, delta-compressed frames as ES modules,
loaded through `frames.mjs`. Each file stays below Claude's 1 MiB source limit.
`preview.png` is a contact sheet of all included scenes.

Rebuild from the repository root with:

```sh
python scripts/bake-pets.py --chromium /usr/bin/chromium
```

Build-only prerequisites: Python Pillow, Playwright, and Chromium. The script
isolates each SVG in a separate document, pauses and seeks its CSS animations,
finds a stable crop across each loop, rasterizes vectors at 3x device pixel
ratio, and samples 12 frames per second. Each scene uses one 64-color RGBA
palette; XOR deltas use raw DEFLATE, with a keyframe every 16 frames. Palette
quantization can slightly change gradients and shadows. This keeps all
148 scenes below the engine's 8 MiB limit for the entire module graph.
`hooks/pet-codec.mjs` reconstructs frames and produces PNGs with crisp 2x
nearest-neighbor enlargement (up to 480x480 before cropping). Only the current
scene's pixels and PNG are cached. Browser networking is disabled. Complex
loops are capped at eight seconds; image updates are capped at 12 fps.
No browser, renderer, dependency install, or network access is needed at runtime.

The DEFLATE codec uses the MIT-licensed fflate 0.8.2; see
`hooks/vendor/fflate-LICENSE` and `hooks/vendor/README.md`.
