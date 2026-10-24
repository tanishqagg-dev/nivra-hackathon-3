/** A number whose digits roll like an odometer when it changes. Screen readers get the plain value. */
export function RollingNumber({ value, suffix = '', className = '', proportional = false }: { value: number | null; suffix?: string; className?: string; proportional?: boolean }) {
  const text = value === null || !Number.isFinite(value) ? '–' : String(Math.round(value))
  return (
    <span className={`rolling-number ${proportional ? 'is-proportional' : ''} ${className}`}>
      <span className="visually-hidden">{text}{suffix}</span>
      {[...text].map((char, index) => /\d/.test(char) ? (
        // Keyed from the right so the ones digit stays in place when the number grows.
        <span className="rolling-digit" key={text.length - index} aria-hidden="true">
          {/* Equal-width digits never overlap while rolling; big headline numbers use their own widths. */}
          <span className="rolling-sizer">{proportional ? char : '0'}</span>
          <span className="rolling-strip" style={{ transform: `translateY(${-Number(char) * 10}%)` }}>
            {'0123456789'.split('').map(digit => <span key={digit}>{digit}</span>)}
          </span>
        </span>
      ) : <span key={`c${text.length - index}`} aria-hidden="true">{char}</span>)}
      {suffix ? <span className="rolling-suffix" aria-hidden="true">{suffix}</span> : null}
    </span>
  )
}
