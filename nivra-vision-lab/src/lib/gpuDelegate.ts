/** Software WebGL is CPU emulation, not hardware acceleration for pose inference. */
export function isSoftwareWebGlRenderer(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false
  let context: WebGL2RenderingContext | null = null
  try {
    const canvas = new OffscreenCanvas(1, 1)
    context = canvas.getContext('webgl2')
    if (!context || context.isContextLost()) return false
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) return false
    const renderer: unknown = context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    return typeof renderer === 'string' &&
      /swiftshader|llvmpipe|softpipe|software (?:rasterizer|renderer)/i.test(renderer)
  } catch {
    // A blocked diagnostic is not evidence of a software renderer.
    return false
  } finally {
    try {
      context?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      // Some browsers do not expose explicit context cleanup.
    }
  }
}
