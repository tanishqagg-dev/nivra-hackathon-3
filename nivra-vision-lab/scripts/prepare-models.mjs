import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const modelsRoot = new URL('../public/models/', import.meta.url)
const models = [
  {
    file: 'pose_landmarker_full.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
  },
  {
    file: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
  },
  {
    file: 'efficientdet_lite0_float16.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
    sha256: '4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993',
  },
]

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

await mkdir(modelsRoot, { recursive: true })
for (const model of models) {
  const path = new URL(model.file, modelsRoot)
  let existing
  try {
    existing = await readFile(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (existing) {
    if (digest(existing) !== model.sha256) {
      throw new Error(`${model.file} does not match the pinned checksum. Existing file was left unchanged.`)
    }
    console.log(`Verified ${model.file} (${existing.length.toLocaleString()} bytes)`)
    continue
  }

  const response = await fetch(model.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${model.file}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (digest(bytes) !== model.sha256) {
    throw new Error(`${model.file}: download did not match the pinned checksum. Nothing was saved.`)
  }
  await writeFile(path, bytes, { flag: 'wx' })
  console.log(`Downloaded ${model.file} (${bytes.length.toLocaleString()} bytes)`)
}
