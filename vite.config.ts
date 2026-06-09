import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pixelpulse: resolve(__dirname, 'src/pixelpulse.html'),
        bodeplot: resolve(__dirname, 'src/bodeplot.html'),
        curvetrace: resolve(__dirname, 'src/curvetrace.html'),
        fwupdate: resolve(__dirname, 'src/fwupdate.html'),
        calibrate: resolve(__dirname, 'src/calibrate.html'),
        debuginfo: resolve(__dirname, 'src/debuginfo.html'),
        editsenseresistor: resolve(__dirname, 'src/editsenseresistor.html'),
        setup: resolve(__dirname, 'src/setup.html'),
      },
    },
  },
  css: {
    lightningcss: {
      errorRecovery: true,
    },
  },
  server: {
    port: 8000,
  },
});
