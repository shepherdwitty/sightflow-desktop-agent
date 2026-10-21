import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const commercialOn =
  process.env.SIGHTFLOW_COMMERCIAL === '1' || process.env.RENDERER_VITE_COMMERCIAL === 'true'

export default defineConfig({
  main: {
    // 商业开关在打包时写死。安装包启动时通常没有这两个环境变量，
    // 如果仍在运行时读取，商业包会退回开源界面。
    define: {
      'process.env.SIGHTFLOW_COMMERCIAL': JSON.stringify(commercialOn ? '1' : '0'),
      'process.env.RENDERER_VITE_COMMERCIAL': JSON.stringify(commercialOn ? 'true' : 'false')
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'test-cli': resolve(__dirname, 'scripts/test-cli.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    define: {
      'import.meta.env.RENDERER_VITE_COMMERCIAL': JSON.stringify(commercialOn ? 'true' : 'false')
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Box-select wizard runs in a separate transparent BrowserWindow
          // and loads its own React tree; second entry keeps its bundle isolated.
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})
