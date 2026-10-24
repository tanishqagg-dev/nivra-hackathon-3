import { useEffect, useState, type RefObject } from 'react'
import { FightDecision, FIGHT_FRAMES, FIGHT_SAMPLE_MS, FIGHT_STRIDE_MS, FIGHT_WINDOW_MS, type FightPrediction } from '../lib/fightDecision'
import type { ReviewEvent } from '../lib/sceneEngine'

export type FightState = {
  status: 'connecting' | 'ready' | 'warming' | 'clear' | 'observing' | 'alert' | 'error'
  message: string
  prediction: FightPrediction | null
  samples: number
  streak: number
  events: ReviewEvent[]
  device: string | null
}
const INITIAL: FightState = {
  status: 'connecting', message: 'Connecting to the local fight model…', prediction: null,
  samples: 0, streak: 0, events: [], device: null,
}

export function useFightDetector(videoRef: RefObject<HTMLVideoElement | null>, active: boolean, sessionId: number, enabled = true) {
  const [state, setState] = useState<FightState>(INITIAL)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setState({ ...INITIAL, status: 'ready', message: 'Video model disabled.' })
      return
    }
    let disposed = false
    let busy = false
    let ready = false
    let lastCapture = -Infinity
    let lastVideoTime = -1
    let lastRequest = -Infinity
    let healthChecked = -Infinity
    let device: string | null = null
    let streamEpoch = 0
    let samples: { time: number; pixels: ImageData }[] = []
    const decision = new FightDecision()
    const controllers = new Set<AbortController>()
    const frame = document.createElement('canvas')
    frame.width = frame.height = 224
    const context = frame.getContext('2d', { willReadFrequently: true })
    const strip = document.createElement('canvas')
    strip.width = 224 * FIGHT_FRAMES
    strip.height = 224
    const stripContext = strip.getContext('2d')
    setState({ ...INITIAL, events: [] })

    const request = async (path: string, init?: RequestInit) => {
      const controller = new AbortController()
      controllers.add(controller)
      const timeout = window.setTimeout(() => controller.abort(), 8_000)
      try {
        const response = await fetch(`/api/fight/${path}`, { ...init, signal: controller.signal })
        if (!response.ok) throw new Error(`Local model returned ${response.status}`)
        return await response.json()
      } finally {
        clearTimeout(timeout)
        controllers.delete(controller)
      }
    }

    const tick = async () => {
      if (disposed) return
      const now = performance.now()
      if (!ready) {
        if (busy) return
        if (now - healthChecked < 3_000) return
        healthChecked = now
        busy = true
        try {
          const health = await request('health')
          if (!health.ready) throw new Error(health.error || 'Local model is loading. Retrying…')
          if (health.engine !== 'consensus-v2' || health.requiredVotes !== 2) throw new Error('An older fight backend is running. Restart npm run demo.')
          if (disposed) return
          ready = true
          device = health.device
          setState(previous => ({ ...previous, device, status: active ? 'warming' : 'ready',
            message: active ? 'Collecting four seconds of live video.' : 'The trained fight models are ready. Start the camera.' }))
        } catch (error) {
          if (!disposed) setState(previous => ({ ...previous, status: 'error', prediction: null, streak: 0,
            message: error instanceof Error && !error.message.startsWith('Local model returned') && error.name !== 'TypeError'
              ? error.message : 'Local fight model is unavailable. Start npm run demo, then retry.' }))
        } finally { busy = false }
        return
      }
      if (!active || !context || !stripContext) return
      const video = videoRef.current
      if (document.hidden || !video || video.paused || video.ended || video.readyState < 2 || !video.videoWidth || video.currentTime === lastVideoTime) {
        if (now - lastCapture > 750 && samples.length) {
          samples = []
          streamEpoch += 1
          decision.reset()
          setState(previous => ({ ...previous, status: 'warming', prediction: null, samples: 0, streak: 0,
            message: 'Waiting for fresh camera frames.' }))
        }
        return
      }
      if (now - lastCapture < FIGHT_SAMPLE_MS - 15) return
      if (now - lastCapture > 750) { samples = []; streamEpoch += 1; decision.reset() }
      lastCapture = now
      lastVideoTime = video.currentTime
      // Match author preprocessing: full RGB frame resized to 224 × 224; no mirror or crop.
      context.drawImage(video, 0, 0, 224, 224)
      samples.push({ time: now, pixels: context.getImageData(0, 0, 224, 224) })
      samples = samples.filter(sample => now - sample.time <= FIGHT_WINDOW_MS + 750).slice(-FIGHT_FRAMES)
      setState(previous => ({ ...previous, samples: samples.length }))
      if (busy || samples.length < FIGHT_FRAMES || now - lastRequest < FIGHT_STRIDE_MS) return
      const windowEnd = now
      const requestEpoch = streamEpoch
      lastRequest = now
      samples.forEach((sample, index) => stripContext.putImageData(sample.pixels, index * 224, 0))
      busy = true
      try {
        const blob = await new Promise<Blob>((resolve, reject) => strip.toBlob(
          value => value ? resolve(value) : reject(new Error('Could not prepare camera frames')), 'image/jpeg', .9))
        if (disposed) return
        if (requestEpoch !== streamEpoch || performance.now() - lastCapture > 750) return
        const prediction = await request('predict', { method: 'POST', body: blob,
          headers: { 'Content-Type': 'image/jpeg' } }) as FightPrediction
        if (disposed) return
        if (requestEpoch !== streamEpoch || performance.now() - lastCapture > 750) return
        if (performance.now() - windowEnd > 4_000) throw new Error('Inference is too slow for fresh alerts. Close other heavy apps and retry.')
        if (prediction.threshold !== 0.4 || typeof prediction.aboveThreshold !== 'boolean' || !Number.isFinite(prediction.inferenceMs) || prediction.inferenceMs < 0) throw new Error('Unexpected model response')
        if (!prediction.agreement || prediction.agreement.required !== 2 || !Number.isInteger(prediction.agreement.votes) || prediction.agreement.votes < 0 || prediction.agreement.votes > 3 || prediction.aboveThreshold !== (prediction.agreement.votes >= 2)) throw new Error('Model agreement is invalid. Restart the fight backend.')
        const result = decision.update(prediction.score, windowEnd, prediction.aboveThreshold)
        setState(previous => ({ ...previous, prediction, streak: result.streak,
          status: result.streak >= 2 ? 'alert' : result.streak ? 'observing' : 'clear',
          message: result.streak >= 2 ? 'A possible fight was flagged across consecutive windows. Review the scene.'
            : result.streak ? 'A possible fight was flagged in one window. Checking the next window.'
              : 'No fight pattern in the latest video window.',
          events: result.event ? [result.event, ...previous.events].slice(0, 10) : previous.events,
        }))
      } catch (error) {
        if (!disposed) {
          ready = false
          healthChecked = performance.now()
          samples = []
          decision.reset()
          setState(previous => ({ ...previous, status: 'error', prediction: null, samples: 0, streak: 0,
            message: error instanceof Error ? error.message : 'Local inference failed. Retrying…' }))
        }
      } finally { busy = false }
    }

    void tick()
    const timer = window.setInterval(() => { void tick() }, 25)
    return () => {
      disposed = true
      clearInterval(timer)
      controllers.forEach(controller => controller.abort())
      samples = []
    }
  }, [active, enabled, retry, sessionId, videoRef])

  return { ...state, retry: () => setRetry(value => value + 1) }
}
