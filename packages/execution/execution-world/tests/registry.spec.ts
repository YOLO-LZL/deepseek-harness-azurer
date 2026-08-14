import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ExecutionWorldRegistry, {
  ExecutionError,
  LOCAL_PROVIDER_ID,
  executionLocationEquals,
  localLocation,
} from '../src/index.ts'
import type { ExecutionLocation, ExecutionWorldProvider, ResolvedExecutionWorld } from '../src/index.ts'
import * as localProviderPlugin from '../src/local.ts'
import { LocalExecutionWorldProvider, createLocalWorkspaceOperations } from '../src/local.ts'

/** A minimal fake provider for routing tests. */
function fakeProvider(id: string, capabilities: ExecutionWorldProvider['capabilities']): ExecutionWorldProvider {
  return {
    id,
    label: `Fake ${id}`,
    capabilities,
    resolve(location: ExecutionLocation): ResolvedExecutionWorld {
      if (location.providerId !== id) {
        throw new ExecutionError(`fake '${id}' cannot resolve '${location.providerId}'`, 'execution-provider-not-found')
      }
      return { location }
    },
    defaultLocation(): ExecutionLocation {
      return { providerId: id, target: null, root: `/fake/${id}` }
    },
  }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(ExecutionWorldRegistry)
  return { ctx, registry: ctx.executionWorlds }
}

describe('execution world registry', () => {
  it('routes undefined to the local provider default', async () => {
    const { registry } = await harness()
    // The local provider registers even with no seams; resolving without a
    // world names the local default, whose backends answer unavailable.
    registry.register(new LocalExecutionWorldProvider(undefined, undefined))
    expect(registry.provider(LOCAL_PROVIDER_ID)).toBeDefined()
    expect(() => registry.resolve())
      .toThrowError(expect.objectContaining({ code: 'execution-unavailable' }))
  })

  it('routes undefined to the local world when seams are mounted', async () => {
    const { registry } = await harness()
    const fs = { resolve: async () => ({}) } as never
    const subprocess = { spawn: () => ({}) } as never
    registry.register(new LocalExecutionWorldProvider(fs, subprocess))
    const world = registry.resolve()
    expect(world.location.providerId).toBe(LOCAL_PROVIDER_ID)
    expect(world.filesystem).toBe(fs)
    expect(world.subprocess).toBe(subprocess)
  })

  it('rejects duplicate provider ids', async () => {
    const { registry } = await harness()
    registry.register(fakeProvider('alpha', { filesystem: true, subprocess: false, workspace: false }))
    expect(() => registry.register(fakeProvider('alpha', { filesystem: true, subprocess: false, workspace: false })))
      .toThrow(/already registered/)
  })

  it('routes a location to its provider', async () => {
    const { registry } = await harness()
    registry.register(fakeProvider('alpha', { filesystem: true, subprocess: true, workspace: false }))
    const world = registry.resolve({ providerId: 'alpha', target: { id: 7 }, root: '/alpha/root' })
    expect(world.location).toMatchObject({ providerId: 'alpha', root: '/alpha/root' })
  })

  it('throws execution-provider-not-found for an unknown provider', async () => {
    const { registry } = await harness()
    expect(() => registry.resolve({ providerId: 'ghost', target: null, root: '/' }))
      .toThrowError(expect.objectContaining({ code: 'execution-provider-not-found' }))
  })

  it('throws execution-provider-not-found when the local default is missing', async () => {
    const { registry } = await harness()
    expect(() => registry.resolve())
      .toThrowError(expect.objectContaining({ code: 'execution-provider-not-found' }))
  })

  it('unregisters routes on disposal', async () => {
    const { registry } = await harness()
    const dispose = registry.register(fakeProvider('beta', { filesystem: true, subprocess: false, workspace: false }))
    expect(registry.resolve({ providerId: 'beta', target: null, root: '/' }).location.providerId).toBe('beta')
    dispose()
    expect(() => registry.resolve({ providerId: 'beta', target: null, root: '/' }))
      .toThrowError(expect.objectContaining({ code: 'execution-provider-not-found' }))
    // Disposal is idempotent.
    dispose()
    expect(registry.listProviders()).toHaveLength(0)
  })

  it('scopes registration to the enclosing effect', async () => {
    const ctx = new Context()
    await ctx.plugin(ExecutionWorldRegistry)
    const registry = ctx.executionWorlds
    // Registration inside a plugin fiber binds the effect to that fiber:
    // disposing the fiber unregisters the provider.
    const fiber = await ctx.plugin({
      apply: (scope: Context) => {
        scope.effect(() => registry.register(fakeProvider('gamma', { filesystem: true, subprocess: false, workspace: false })))
      },
    })
    expect(registry.provider('gamma')).toBeDefined()
    await fiber.dispose()
    expect(registry.provider('gamma')).toBeUndefined()
  })

  it('rejects a replaced registration from an earlier disposer', async () => {
    const { registry } = await harness()
    const first = fakeProvider('delta', { filesystem: true, subprocess: false, workspace: false })
    const dispose = registry.register(first)
    dispose()
    registry.register(fakeProvider('delta', { filesystem: true, subprocess: false, workspace: false }))
    // The stale disposer must not remove the replacement.
    dispose()
    expect(registry.provider('delta')).toBeDefined()
  })

  it('workspace() answers the local workspace operations', async () => {
    const { registry } = await harness()
    registry.register(new LocalExecutionWorldProvider(undefined, undefined))
    const ops = registry.workspace()
    expect(ops).toBeDefined()
    const location = localLocation(process.cwd())
    expect(await ops.status(location)).toMatchObject({ kind: 'ok' })
  })

  it('workspace() throws execution-unavailable without a workspace capability', async () => {
    const { registry } = await harness()
    registry.register(fakeProvider('epsilon', { filesystem: true, subprocess: false, workspace: false }))
    expect(() => registry.workspace({ providerId: 'epsilon', target: null, root: '/' }))
      .toThrowError(expect.objectContaining({ code: 'execution-unavailable' }))
  })
})

describe('local provider Loader entry', () => {
  it('preserves metadata through Loader and registers local workspace operations', async () => {
    expect('default' in localProviderPlugin).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(localProviderPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(localProviderPlugin)
    expect(unwrapped.name).toBe('execution-world-local')
    expect(unwrapped.inject).toEqual(['executionWorlds'])
    expect(typeof unwrapped.apply).toBe('function')

    const ctx = new Context()
    await ctx.plugin(ExecutionWorldRegistry)
    const fs = { resolve: async () => ({}) } as never
    const subprocess = { spawn: () => ({}) } as never
    ctx.provide('fs', fs)
    ctx.provide('subprocess', subprocess)
    const plugin = loader.unwrapExports(localProviderPlugin) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(plugin)

    expect(ctx.executionWorlds.provider(LOCAL_PROVIDER_ID)).toBeInstanceOf(LocalExecutionWorldProvider)
    expect(ctx.executionWorlds.resolve()).toMatchObject({ filesystem: fs, subprocess })
    await expect(ctx.executionWorlds.workspaceOf(LOCAL_PROVIDER_ID).resolveLocation({
      providerId: LOCAL_PROVIDER_ID,
      target: null,
      path: process.cwd(),
    })).resolves.toEqual(localLocation(await import('node:fs/promises').then(m => m.realpath(process.cwd()))))

    await fiber.dispose()
    expect(ctx.executionWorlds.provider(LOCAL_PROVIDER_ID)).toBeUndefined()
  })
})

describe('executionLocationEquals', () => {
  it('compares provider, target JSON, and root', () => {
    const a: ExecutionLocation = { providerId: 'ssh', target: { connectionId: 'c1' }, root: '/home/u/w' }
    expect(executionLocationEquals(a, { providerId: 'ssh', target: { connectionId: 'c1' }, root: '/home/u/w' })).toBe(true)
    expect(executionLocationEquals(a, { providerId: 'ssh', target: { connectionId: 'c2' }, root: '/home/u/w' })).toBe(false)
    expect(executionLocationEquals(a, { providerId: 'local', target: null, root: '/home/u/w' })).toBe(false)
    expect(executionLocationEquals(a, { providerId: 'ssh', target: { connectionId: 'c1' }, root: '/other' })).toBe(false)
  })
})

describe('local provider workspace operations', () => {
  it('canonicalizes, lists, and creates directories', async () => {
    const ops = createLocalWorkspaceOperations()
    const location = localLocation(process.cwd())
    const canonical = await ops.canonicalize(location, '.')
    expect(canonical).toBe(await import('node:fs/promises').then(m => m.realpath(process.cwd())))
    const listed = await ops.listDirectory(location, '.')
    expect(Array.isArray(listed)).toBe(true)
    expect(listed.every(entry => typeof entry.name === 'string')).toBe(true)
  })

  it('rejects non-directory create roots', async () => {
    const ops = createLocalWorkspaceOperations()
    await expect(ops.resolveLocation({ providerId: LOCAL_PROVIDER_ID, target: null, path: 'definitely-missing-dir-xyz' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'workspace-remote-path-invalid' }))
  })

  it('rejects foreign provider ids and non-null targets', async () => {
    const ops = createLocalWorkspaceOperations()
    await expect(ops.resolveLocation({ providerId: 'ssh', target: null, path: process.cwd() }))
      .rejects.toThrowError(expect.objectContaining({ code: 'workspace-provider-invalid-target' }))
    await expect(ops.resolveLocation({ providerId: LOCAL_PROVIDER_ID, target: { x: 1 }, path: process.cwd() }))
      .rejects.toThrowError(expect.objectContaining({ code: 'workspace-provider-invalid-target' }))
  })
})
