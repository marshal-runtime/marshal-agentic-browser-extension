// false in this repository (a developer loads it unpacked). The Marley site's packager (zygstinct apps/web/scripts/package-browser-extension.mjs)
// sets it to true in the zip it serves, so an owner's unpacked install behaves like a store install: production pairing only, no local socket.
export const SITE_INSTALL = false;
