import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type Option<T extends string> = { value: T; label: ReactNode; disabled?: boolean; testId?: string }

/**
 * Grey track with a black pill that slides to the selected option.
 * Buttons keep aria-pressed so tests and screen readers see the state.
 */
export function Segmented<T extends string>({ options, value, onChange, label, className = '', size = 'md' }: {
  options: Option<T>[]; value: T | null; onChange(value: T): void; label: string; className?: string; size?: 'sm' | 'md'
}) {
  const track = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const selected = track.current?.querySelector<HTMLElement>('[aria-pressed="true"]')
      setPill(selected ? { x: selected.offsetLeft, w: selected.offsetWidth } : null)
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    if (track.current) observer?.observe(track.current)
    return () => observer?.disconnect()
  }, [value, options.length])

  return (
    <div className={`segmented is-${size} ${className}`} role="group" aria-label={label} ref={track}>
      <span className={`segmented-pill ${pill ? 'is-shown' : ''}`} aria-hidden="true" style={pill ? { transform: `translateX(${pill.x}px)`, width: pill.w } : undefined} />
      {options.map(option => (
        <button key={option.value} type="button" aria-pressed={option.value === value} disabled={option.disabled}
          data-testid={option.testId} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  )
}
