import { useEffect, useRef, useState } from 'react'
import { ArrowsOut, DownloadSimple, Pause, Play } from '@phosphor-icons/react'
import { CLIP_POST_MS, CLIP_PRE_MS } from '../services/ClipRecorder'

type Props = {
  src: string | null
  poster?: string | null
  /** Shown while the clip is still being recorded. */
  pending?: boolean
  autoPlay?: boolean
  downloadName?: string
  className?: string
}

const ALERT_AT = CLIP_PRE_MS / (CLIP_PRE_MS + CLIP_POST_MS)

/** Five-second alert clip: muted loop, scrubber with a red tick where the alert fired. */
export function ClipPlayer({ src, poster, pending = false, autoPlay = true, downloadName = 'nivra-clip', className = '' }: Props) {
  const video = useRef<HTMLVideoElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const element = video.current
    if (!element || !src) return
    let frame = 0
    const loop = () => {
      // WebM from MediaRecorder often reports Infinity duration until it has played once.
      const total = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : (CLIP_PRE_MS + CLIP_POST_MS) / 1_000
      setProgress(Math.min(1, element.currentTime / total))
      setDuration(total)
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [src])

  const toggle = () => {
    const element = video.current
    if (!element) return
    if (element.paused) void element.play().catch(() => undefined)
    else element.pause()
  }
  const seek = (clientX: number) => {
    const element = video.current, track = bar.current
    if (!element || !track) return
    const box = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    element.currentTime = ratio * (duration || (CLIP_PRE_MS + CLIP_POST_MS) / 1_000)
  }
  const seconds = (value: number) => `0:${String(Math.max(0, Math.round(value))).padStart(2, '0')}`

  return (
    <figure className={`clip-player ${src ? 'has-clip' : ''} ${className}`} data-testid="clip-player">
      <div className="clip-frame">
        {src ? (
          <video ref={video} src={src} poster={poster ?? undefined} muted loop playsInline autoPlay={autoPlay} preload="auto"
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
        ) : poster ? <img src={poster} alt="" /> : null}
        {!src ? (
          <figcaption className="clip-pending">
            <span className="clip-rec" aria-hidden="true" />
            {pending ? 'Saving the 5 second clip' : 'No clip for this alert'}
          </figcaption>
        ) : null}
        {src ? <span className="clip-badge">{seconds(progress * duration)} / {seconds(duration || 5)}</span> : null}
      </div>
      {src ? (
        <div className="clip-controls">
          <button type="button" className="clip-button" aria-label={playing ? 'Pause clip' : 'Play clip'} onClick={toggle}>
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          </button>
          <div className="clip-track" ref={bar} role="slider" aria-label="Clip position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} tabIndex={0}
            onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId); seek(event.clientX) }}
            onPointerMove={event => { if (event.buttons) seek(event.clientX) }}
            onKeyDown={event => {
              const element = video.current
              if (!element) return
              if (event.key === 'ArrowRight') element.currentTime = Math.min(duration, element.currentTime + 0.25)
              if (event.key === 'ArrowLeft') element.currentTime = Math.max(0, element.currentTime - 0.25)
            }}>
            <span className="clip-fill" style={{ transform: `scaleX(${progress})` }} />
            <span className="clip-alert-tick" style={{ left: `${ALERT_AT * 100}%` }} title="Alert" />
          </div>
          <a className="clip-button" href={src} download={downloadName} aria-label="Download clip"><DownloadSimple size={15} /></a>
          <button type="button" className="clip-button" aria-label="Expand clip" onClick={() => void video.current?.requestFullscreen?.().catch(() => undefined)}><ArrowsOut size={15} /></button>
        </div>
      ) : (
        // Same height as the controls so the buttons below never jump when the clip arrives.
        <div className="clip-controls is-placeholder" aria-hidden="true"><span className="clip-button" /><div className="clip-track" /></div>
      )}
    </figure>
  )
}
