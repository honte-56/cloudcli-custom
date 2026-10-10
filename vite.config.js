import { createRequire } from 'node:module'
import { cpSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

// Resolve each package's own aliases so named imports retain their exact
// components without loading whole icon, grammar, and theme catalogs.
const lucideRoot = resolve(dirname(createRequire(import.meta.url).resolve('lucide-react/package.json')), 'dist/esm')
const syntaxRoot = resolve(dirname(createRequire(import.meta.url).resolve('react-syntax-highlighter/package.json')), 'dist/esm')
const packageImports = new Map()
for (const [name, entry] of [
  ['lucide-react', resolve(lucideRoot, 'lucide-react.js')],
  ['react-syntax-highlighter', resolve(syntaxRoot, 'index.js')],
  ['react-syntax-highlighter/dist/esm/styles/prism', resolve(syntaxRoot, 'styles/prism/index.js')],
]) {
  const exports = new Map()
  for (const match of readFileSync(entry, 'utf8').matchAll(/export \{([^}]+)\} from '([^']+)';/g)) {
    for (const specifier of match[1].split(',')) {
      const alias = specifier.trim().match(/^default as (\w+)$/)
      if (alias) exports.set(alias[1], resolve(dirname(entry), match[2]))
    }
  }
  packageImports.set(name, exports)
}
const srcRoot = fileURLToPath(new URL('./src/', import.meta.url))
const directPackageImports = {
  name: 'direct-package-imports',
  apply: 'build',
  enforce: 'pre',
  transform(code, id) {
    if (!id.startsWith(srcRoot)) return
    const transformed = code.replace(/import\s*\{([^}]+)\}\s*from\s*(['"])(lucide-react|react-syntax-highlighter(?:\/dist\/esm\/styles\/prism)?)\2/g, (original, specifiers, _quote, packageName) => {
      const exports = packageImports.get(packageName)
      const imports = []
      for (const specifier of specifiers.split(',')) {
        const value = specifier.trim()
        if (!value || value.startsWith('type ')) continue
        const name = value.match(/^(\w+)(?:\s+as\s+(\w+))?$/)
        if (!name || !exports.has(name[1])) return original
        imports.push(`import ${name[2] || name[1]} from ${JSON.stringify(exports.get(name[1]))};`)
      }
      return imports.join('\n')
    })
    return transformed === code ? undefined : { code: transformed, map: null }
  },
}

// Translation resources are default JSON imports. Emit a single JSON string
// per resource to keep their field trees out of Rollup's JavaScript AST.
const translationRoot = fileURLToPath(new URL('./src/modules/i18n/locales/', import.meta.url))
const translationPrefix = '\0cloudcli-translation:'
const translationJson = {
  name: 'compact-translation-json',
  apply: 'build',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (!source.includes('/locales/') || !source.endsWith('.json')) return
    const resolved = await this.resolve(source, importer, { skipSelf: true })
    if (resolved?.id.startsWith(translationRoot)) return translationPrefix + resolved.id + '.js'
  },
  load(id) {
    if (!id.startsWith(translationPrefix)) return
    const path = id.slice(translationPrefix.length, -3)
    const json = JSON.stringify(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))
    return `export default /* #__PURE__ */ JSON.parse(${JSON.stringify(json)})`
  },
}

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [directPackageImports, translationJson, react(), {
      name: 'copy-mermaid-runtime',
      closeBundle() {
        cpSync(dirname(createRequire(import.meta.url).resolve('mermaid')),
          fileURLToPath(new URL('./dist/vendor/mermaid', import.meta.url)), {
            recursive: true,
            filter: (sourcePath) => !sourcePath.endsWith('.map') && !sourcePath.endsWith('.d.ts'),
          })
      },
    }],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        // Use Mermaid's published ESM distribution so low-memory hosts do not
        // parse and rebuild its entire diagram engine with every UI change.
        external: ['mermaid'],
        output: {
          paths: { mermaid: '/vendor/mermaid/mermaid.esm.min.mjs' },
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
