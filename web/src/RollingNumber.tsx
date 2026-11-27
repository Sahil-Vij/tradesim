const DIGITS = "0123456789".split("");

/**
 * Shows a formatted number like "$60,695.63" where each digit rolls to its new value, like an
 * odometer. Screen readers and tests get the plain text; the rolling columns are hidden from them.
 * Digits are keyed from the right, so "$9.99" → "$10.00" adds a column on the left instead of
 * shifting every digit sideways.
 */
export function RollingNumber({ value, className = "" }: { value: string; className?: string }) {
  const chars = value.split("");
  return (
    <span className={`relative inline-flex whitespace-nowrap ${className}`}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((char, i) => {
          const key = chars.length - i;
          if (!/\d/.test(char)) return <span key={`c${key}`}>{char}</span>;
          return (
            <span key={`d${key}`} className="roll-digit">
              <span className="roll-strip" style={{ transform: `translateY(-${Number(char) * 10}%)` }}>
                {DIGITS.map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
