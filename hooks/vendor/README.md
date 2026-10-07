# fflate

Only `inflateSync` and `deflateSync` from fflate 0.8.2 are bundled, using
esbuild 0.25.10 in browser/ESM mode with tree shaking. License and copyright
are preserved in `fflate-LICENSE` (Copyright 2023 Arjun Barrett, MIT).

Upstream: https://github.com/101arrowz/fflate

To reproduce the bundle, install those exact versions outside this checkout,
create an entry module exporting these two functions from fflate's
`esm/browser.js`, and run:

```sh
esbuild entry.mjs --bundle --format=esm --platform=browser --minify \
  --legal-comments=inline --outfile=hooks/vendor/fflate.mjs
```

No npm installation is needed to run the plugin.
