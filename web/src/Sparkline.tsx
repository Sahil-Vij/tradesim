/**
 * A small line of the prices seen since the page opened. Drawn from real ticks only: until there
 * are two, it draws nothing rather than invent a shape.
 */
export function Sparkline({ points, width = 96, height = 28 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const y = (p: number) => height - 2 - ((p - min) / span) * (height - 4);
  const line = points.map((p, i) => `${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const rising = points[points.length - 1]! >= points[0]!;
  const color = rising ? "var(--color-gain)" : "var(--color-loss)";
  const id = `spark-${rising ? "up" : "down"}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
