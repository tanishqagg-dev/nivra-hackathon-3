/** What the current sensitivity means in practice, in plain words. */
export function sensitivityText(power: number) {
  if (power < 0.2) return { name: 'Careful', detail: 'Needs 3 clear strikes within a few seconds. Fewest false alarms.' }
  if (power < 0.4) return { name: 'Balanced', detail: 'Needs 2 clear strikes within a few seconds.' }
  if (power < 0.6) return { name: 'Sensitive', detail: 'One clear strike toward another person raises an alert.' }
  if (power < 0.9) return { name: 'High', detail: 'One strike, and slower or shorter strikes also count.' }
  return { name: 'Maximum', detail: 'Alerts on the first fast arm movement toward another person. Play and sports will also trigger it.' }
}

/** Model and sensitivity controls. Shown in the console drawer and on Settings → Detection. */
