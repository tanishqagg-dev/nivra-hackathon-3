import type { ObjectRole } from '../types/vision'

const LABEL_DETAILS = {
  person: { name: 'Person', role: 'person' },
  backpack: { name: 'Backpack', role: 'bag' },
  umbrella: { name: 'Umbrella', role: 'portable' },
  handbag: { name: 'Handbag / purse', role: 'bag' },
  suitcase: { name: 'Suitcase', role: 'bag' },
  tie: { name: 'Tie', role: 'portable' },
  frisbee: { name: 'Frisbee', role: 'portable' },
  skis: { name: 'Skis', role: 'portable' },
  snowboard: { name: 'Snowboard', role: 'portable' },
  'sports ball': { name: 'Sports ball', role: 'portable' },
  kite: { name: 'Kite', role: 'portable' },
  'baseball bat': { name: 'Baseball bat', role: 'restricted' },
  'baseball glove': { name: 'Baseball glove', role: 'portable' },
  skateboard: { name: 'Skateboard', role: 'portable' },
  surfboard: { name: 'Surfboard', role: 'portable' },
  'tennis racket': { name: 'Tennis racket', role: 'portable' },
  bottle: { name: 'Bottle', role: 'portable' },
  'wine glass': { name: 'Glass', role: 'portable' },
  cup: { name: 'Cup', role: 'portable' },
  fork: { name: 'Fork', role: 'portable' },
  knife: { name: 'Knife', role: 'restricted' },
  spoon: { name: 'Spoon', role: 'portable' },
  bowl: { name: 'Bowl', role: 'portable' },
  banana: { name: 'Banana', role: 'portable' },
  apple: { name: 'Apple', role: 'portable' },
  sandwich: { name: 'Sandwich', role: 'portable' },
  orange: { name: 'Orange', role: 'portable' },
  broccoli: { name: 'Broccoli', role: 'portable' },
  carrot: { name: 'Carrot', role: 'portable' },
  'hot dog': { name: 'Food item', role: 'portable' },
  pizza: { name: 'Pizza', role: 'portable' },
  donut: { name: 'Donut', role: 'portable' },
  cake: { name: 'Cake', role: 'portable' },
  laptop: { name: 'Laptop', role: 'portable' },
  mouse: { name: 'Mouse', role: 'portable' },
  remote: { name: 'Remote', role: 'portable' },
  keyboard: { name: 'Keyboard', role: 'portable' },
  'cell phone': { name: 'Phone', role: 'portable' },
  book: { name: 'Book', role: 'portable' },
  clock: { name: 'Clock', role: 'portable' },
  vase: { name: 'Vase', role: 'portable' },
  scissors: { name: 'Scissors', role: 'restricted' },
  'teddy bear': { name: 'Teddy bear', role: 'portable' },
  'hair drier': { name: 'Hair dryer', role: 'portable' },
  toothbrush: { name: 'Toothbrush', role: 'portable' },
} as const satisfies Record<string, { name: string; role: ObjectRole }>

export type SupportedObjectLabel = keyof typeof LABEL_DETAILS

export const DETECTOR_ALLOWLIST = Object.freeze(
  Object.keys(LABEL_DETAILS) as SupportedObjectLabel[],
)

export function isSupportedObjectLabel(label: string): label is SupportedObjectLabel {
  return label in LABEL_DETAILS
}

export function objectDisplayName(label: SupportedObjectLabel): string {
  return LABEL_DETAILS[label].name
}

export function objectRole(label: SupportedObjectLabel): ObjectRole {
  return LABEL_DETAILS[label].role
}

export function isBagRole(role: ObjectRole): boolean {
  return role === 'bag'
}

export function isRestrictedRole(role: ObjectRole): boolean {
  return role === 'restricted'
}
