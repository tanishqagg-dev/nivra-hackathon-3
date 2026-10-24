export interface PoseLandmark {
  x: number
  y: number
  z: number
  visibility?: number
  presence?: number
}

export type PoseLandmarks = PoseLandmark[]

export type PoseQuality = 'full' | 'lite'

export interface NormalizedBox {
  x: number
  y: number
  width: number
  height: number
}

export type ObjectRole = 'person' | 'bag' | 'portable' | 'restricted'

export interface ObjectObservation {
  label: string
  displayName: string
  score: number
  box: NormalizedBox
  role: ObjectRole
}

export type VisionDelegate = 'GPU' | 'CPU'

export interface VisionDelegates {
  pose: VisionDelegate
  objects: VisionDelegate
}

export type VisionTaskKind = 'pose' | 'objects'

export type VisionWorkerRequest =
  | {
      type: 'init'
      task: VisionTaskKind
      modelPath: string
      wasmRoot: string
      maxPoses: number
      poseConfidence: number
      objectConfidence: number
      poseDelegate?: VisionDelegate
    }
  | { type: 'frame'; bitmap: ImageBitmap; timestampMs: number }
  | {
      type: 'configure'
      maxPoses: number
      poseConfidence: number
      objectConfidence: number
    }
  | { type: 'dispose' }

export type VisionWorkerResponse =
  | { type: 'ready'; task: VisionTaskKind; delegate: VisionDelegate }
  | {
      type: 'pose-result'
      timestampMs: number
      inferenceMs: number
      poses: PoseLandmarks[]
    }
  | {
      type: 'object-result'
      timestampMs: number
      inferenceMs: number
      objects: ObjectObservation[]
    }
  | { type: 'error'; task: VisionTaskKind | null; code: string; message: string }
