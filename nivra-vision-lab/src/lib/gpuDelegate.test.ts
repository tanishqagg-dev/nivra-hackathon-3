import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSoftwareWebGlRenderer } from './gpuDelegate'

function installProbe(renderer: unknown) {
  const loseContext = vi.fn()
  const context = {
    isContextLost: vi.fn(() => false),
    getExtension: vi.fn((name: string): unknown => name === 'WEBGL_debug_renderer_info'
      ? { UNMASKED_RENDERER_WEBGL: 37446 }
      : { loseContext }),
    getParameter: vi.fn(() => renderer),
  }
  const getContext = vi.fn(() => context)
  vi.stubGlobal('OffscreenCanvas', class {
    getContext = getContext
  })
  return { context, getContext, loseContext }
}

afterEach(() => vi.unstubAllGlobals())

describe('software WebGL detection', () => {
  it.each([
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)',
    'llvmpipe (LLVM 18.1.8, 256 bits)',
    'softpipe',
    'Software Rasterizer',
    'Software Renderer',
  ])('uses the CPU path for known software renderer %s', renderer => {
    const probe = installProbe(renderer)
    expect(isSoftwareWebGlRenderer()).toBe(true)
    expect(probe.getContext).toHaveBeenCalledWith('webgl2')
    expect(probe.loseContext).toHaveBeenCalledOnce()
  })

  it.each([
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.1)',
    'NVIDIA GeForce RTX 4060',
    'WebKit WebGL',
    '',
    null,
  ])('preserves GPU-first behavior for hardware or unknown renderer %s', renderer => {
    const probe = installProbe(renderer)
    expect(isSoftwareWebGlRenderer()).toBe(false)
    expect(probe.loseContext).toHaveBeenCalledOnce()
  })

  it('preserves GPU-first behavior when the diagnostic extension is blocked', () => {
    const probe = installProbe('SwiftShader')
    probe.context.getExtension.mockImplementation(name => name === 'WEBGL_debug_renderer_info'
      ? null
      : { loseContext: probe.loseContext })
    expect(isSoftwareWebGlRenderer()).toBe(false)
    expect(probe.context.getParameter).not.toHaveBeenCalled()
    expect(probe.loseContext).toHaveBeenCalledOnce()
  })

  it('does not break initialization when WebGL2 is unavailable', () => {
    const getContext = vi.fn(() => null)
    vi.stubGlobal('OffscreenCanvas', class { getContext = getContext })
    expect(isSoftwareWebGlRenderer()).toBe(false)
  })

  it('does not break initialization when OffscreenCanvas is unavailable', () => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    expect(isSoftwareWebGlRenderer()).toBe(false)
  })

  it('releases a lost context without trusting its renderer string', () => {
    const probe = installProbe('SwiftShader')
    probe.context.isContextLost.mockReturnValue(true)
    expect(isSoftwareWebGlRenderer()).toBe(false)
    expect(probe.loseContext).toHaveBeenCalledOnce()
  })

  it('releases the context when querying the renderer throws', () => {
    const probe = installProbe('SwiftShader')
    probe.context.getParameter.mockImplementation(() => { throw new Error('Blocked') })
    expect(isSoftwareWebGlRenderer()).toBe(false)
    expect(probe.loseContext).toHaveBeenCalledOnce()
  })

  it('does not let failed context cleanup change a recognized software result', () => {
    const probe = installProbe('SwiftShader')
    probe.loseContext.mockImplementation(() => { throw new Error('No cleanup') })
    expect(isSoftwareWebGlRenderer()).toBe(true)
  })
})
