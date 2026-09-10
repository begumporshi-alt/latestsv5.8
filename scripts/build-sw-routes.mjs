/**
 * Build step: emit public/precache-manifest.json for the service worker.
 *
 * The SW cannot enumerate routes at runtime, and its bytes must not change
 * per deploy (it is committed, not generated) — so this script writes the
 * route list plus the build id next to it, and the SW re-warms its caches
 * whenever that build id changes.
 *
 * Runs from `npm run build` (postbuild). It never fails the build: if the
 * route scan or the write breaks, it warns and leaves the previous manifest
 * (or none) in place — the SW then falls back to its built-in core routes.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.cwd()
const appDir = join(root, 'app')
const outFile = join(root, 'public', 'precache-manifest.json')

/** Routes the SW always warms, even with no manifest. */
const CORE_ROUTES = [
  '/dashboard',
  '/sales/pos',
  '/sales',
  '/inventory',
  '/crm',
  '/employees',
  '/hr/attendance',
  '/sync',
  '/offline',
]

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Dynamic segments ([id]) render per-record data — not precacheable.
      if (entry.name.startsWith('[')) continue
      walk(full, out)
    } else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      const rel = relative(appDir, dir)
      const route = rel
        .split(sep)
        // Route groups — (erp), (auth) — are not part of the URL.
        .filter((part) => part && !part.startsWith('('))
        .join('/')
      out.add(route ? `/${route}` : '/')
    }
  }
}

function buildVersion() {
  try {
    const id = readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8').trim()
    if (id) return id
  } catch {
    // No production build id (e.g. the step ran outside a build) — fall back
    // to a content hash of the route list so the value is at least stable.
  }
  return null
}

/**
 * Every build asset must be precached, not just the URLs referenced by a
 * route's HTML: App Router loads each route's page chunk dynamically from the
 * RSC flight data, so a route that was never opened online would have no
 * chunk cached and could not render offline at all (blank page). The whole
 * .next/static tree is a few MB — cheap to warm once per deploy.
 */
function collectAssets() {
  const assets = []
  const staticDir = join(root, '.next', 'static')
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (!entry.name.endsWith('.map')) {
        assets.push(`/_next/static/${relative(staticDir, full).split(sep).join('/')}`)
      }
    }
  }
  walk(staticDir)
  return assets.sort()
}

function main() {
  const routes = new Set()
  walk(appDir, routes)
  for (const r of CORE_ROUTES) routes.add(r)
  const sorted = Array.from(routes).sort()

  const version = buildVersion() || `t${Date.now().toString(36)}`
  const assets = collectAssets()
  const manifest = { version, generatedAt: new Date().toISOString(), routes: sorted, assets }
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[sw] precache manifest: ${sorted.length} routes, ${assets.length} assets (build ${version})`)
}

try {
  main()
} catch (err) {
  // Never break a production build over the precache manifest.
  console.warn('[sw] precache manifest generation failed:', err)
  if (!existsSync(outFile)) {
    try {
      writeFileSync(
        outFile,
        `${JSON.stringify({ version: `t${Date.now().toString(36)}`, routes: CORE_ROUTES }, null, 2)}\n`,
        'utf8',
      )
    } catch {
      // SW falls back to its built-in core routes.
    }
  }
}
