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
        m1k_advanced: resolve(__dirname, 'src/m1k_advanced.html'),
        m1k_calibrate: resolve(__dirname, 'src/m1k_calibrate.html'),
        smudemo: resolve(__dirname, 'src/smudemo.html'),
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
