import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { FightDecision } from '../src/lib/fightDecision.ts'

const directory = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../backend/evaluation-fresh/', import.meta.url))
const report = JSON.parse(readFileSync(`${directory}/predictions.json`, 'utf8'))
const inputs = JSON.parse(readFileSync(`${directory}/inputs.json`, 'utf8'))
const metadata = existsSync(`${directory}/video-metadata.json`) ? JSON.parse(readFileSync(`${directory}/video-metadata.json`, 'utf8')) : {}
const rows = report.videos.map(video => {
  const decision = new FightDecision()
  const alerts = []
  let lateWindowsDropped = 0
  for (const window of video.windows) {
    if (window.roundtripMs > 4_000) {
      decision.reset()
      lateWindowsDropped += 1
      continue
    }
    const result = decision.update(window.score, window.endSeconds * 1000, window.aboveThreshold)
    if (result.event) alerts.push(window.endSeconds)
  }
  const predictedFight = alerts.length > 0
  const intervals = metadata[video.id]?.annotatedIntervalsSeconds ?? []
  return {
    id: video.id, expectedFight: video.expectedFight, predictedFight,
    correct: video.expectedFight === predictedFight,
    result: video.expectedFight ? predictedFight ? 'Detected' : 'Missed' : predictedFight ? 'False alert' : 'Correctly quiet',
    durationSeconds: video.durationSeconds, windows: video.windows.length,
    positiveWindows: video.windows.filter(window => window.aboveThreshold).length,
    firstAlertSeconds: alerts[0] ?? null, alertCount: alerts.length,
    annotatedFightIntervalsSeconds: intervals,
    firstAlertDelayFromAnnotatedOnsetSeconds: alerts.length && intervals.length ? alerts[0] - intervals[0][0] : null,
    alertsOutsideAnnotatedContext: intervals.length ? alerts.filter(time => !intervals.some(([start, end]) => time >= start && time - 6 <= end)).length : null,
    insufficientDuration: video.insufficientDuration,
    lateWindowsDropped,
    sourceUrl: video.url, sourceId: video.sourceId,
    triggerCounts: video.windows.reduce((counts, window) => {
      for (const trigger of window.triggers ?? []) counts[trigger] = (counts[trigger] ?? 0) + 1
      return counts
    }, {}),
  }
})
const count = predicate => rows.filter(predicate).length
const tp = count(row => row.expectedFight && row.predictedFight)
const tn = count(row => !row.expectedFight && !row.predictedFight)
const fp = count(row => !row.expectedFight && row.predictedFight)
const fn = count(row => row.expectedFight && !row.predictedFight)
const latencies = report.videos.flatMap(video => video.windows.map(window => window.inferenceMs)).sort((a, b) => a - b)
const complete = rows.length === inputs.videos.length
const role = inputs.role ?? 'original-baseline'
const caveat = role === 'calibration-previous' ? 'Previously inspected videos used to choose the new rule. This is a calibration replay, not independent validation.' : 'Not used to choose this rule. Model-training source overlap is unknown.'
const output = { complete, role, method: report.method, trainingOverlap: caveat,
  inferenceMs: { min: latencies[0] ?? null, median: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null, max: latencies.at(-1) ?? null },
  metrics: { tested: rows.length, correct: tp + tn, tp, tn, fp, fn, accuracy: (tp + tn) / rows.length,
    precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null }, videos: rows }
writeFileSync(`${directory}/results.json`, JSON.stringify(output, null, 2))
const lines = [`# Ten-video test${complete ? '' : ' (running)'}`, '',
  caveat, '', inputs.selection ?? 'Convenience sample, not a representative benchmark.', '',
  report.method, '',
  '| Video | Expected | Result | Duration | Windows | First alert in video |',
  '|---|---|---|---|---|---|',
  ...rows.map(row => `| [${row.id}](http://127.0.0.1:5173/backend/evaluation/videos/${row.id}.mp4) | ${row.expectedFight ? 'Fight' : 'Normal'} | ${row.result} | ${row.durationSeconds.toFixed(1)} s | ${row.windows} | ${row.firstAlertSeconds === null ? '—' : `${row.firstAlertSeconds.toFixed(1)} s`} |`), '',
  `${tp + tn}/${rows.length} videos classified correctly. TP ${tp}, TN ${tn}, FP ${fp}, FN ${fn}.`, '',
  `Median model inference: ${output.inferenceMs.median} ms; range ${output.inferenceMs.min}–${output.inferenceMs.max} ms. This excludes video-window collection and confirmation delay.`, '',
  'The result is video-level: a video is positive if the actual application decision engine raises at least one two-window alert. A correct positive does not prove every alert occurred inside the annotated fight interval. First alert time is source-video time, not physical webcam wall-clock latency. This sample alone does not validate 90% general accuracy.', '',
  `${rows.reduce((sum, row) => sum + row.lateWindowsDropped, 0)} windows exceeded the live client's four-second response-age limit and were discarded before alert decisions. The offline scan does not simulate browser sampling, health-retry backoff, or a physical webcam. Click a video ID to inspect its source file while the local demo server is running.`, '',
  'Where matching frame annotations were available, results.json records the delay from annotated fight onset and alerts outside the annotated context. Otherwise incident timing remains unverified. Frame indices are converted using the decoded frame rate.', '',
  '## False-alert signals', '',
  ...rows.filter(row => !row.expectedFight && row.predictedFight).map(row => `- ${row.id}: ${Object.entries(row.triggerCounts).map(([name, count]) => `${name} above threshold in ${count} windows`).join('; ')}.`), '',
  role === 'calibration-previous' ? 'The changed agreement rule was chosen after viewing baseline failures. This score must not be presented as unseen-data accuracy.' : 'All errors were kept in the score. No rule was changed after inference on this set.', '',
  '## Sources', '', ...rows.map(row => `- ${row.id}: [${row.sourceId}](${row.sourceUrl})`), '']
writeFileSync(`${directory}/REPORT.md`, lines.join('\n'))
console.log(JSON.stringify(output.metrics))
for (const row of rows) console.log(`${row.id}: ${row.result}; ${row.positiveWindows}/${row.windows} positive windows; first alert ${row.firstAlertSeconds ?? 'none'}`)
