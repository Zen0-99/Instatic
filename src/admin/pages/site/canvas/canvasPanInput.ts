interface WheelPanEvent {
  deltaX: number
  deltaY: number
  shiftKey: boolean
}

interface PointerPanEvent {
  button: number
}

interface PointerPanOptions {
  spaceHeld: boolean
}

type CanvasSpacePanSource = 'parentDocument' | 'iframe'

const CANVAS_SPACE_PAN_DATA_KEYS: Record<CanvasSpacePanSource, string> = {
  parentDocument: 'instaticCanvasParentSpacePan',
  iframe: 'instaticCanvasIframeSpacePan',
}

export function panDeltaFromWheel(event: WheelPanEvent): { dx: number; dy: number } {
  const wheelX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
  const wheelY = event.shiftKey ? 0 : event.deltaY
  return { dx: invertWheelDelta(wheelX), dy: invertWheelDelta(wheelY) }
}

export function shouldStartCanvasPointerPan(
  event: PointerPanEvent,
  { spaceHeld }: PointerPanOptions,
): boolean {
  return spaceHeld && event.button === 0
}

export function setCanvasSpacePanActive(
  doc: Document,
  source: CanvasSpacePanSource,
  active: boolean,
): void {
  const key = CANVAS_SPACE_PAN_DATA_KEYS[source]
  if (active) {
    doc.documentElement.dataset[key] = '1'
    return
  }
  delete doc.documentElement.dataset[key]
}

export function isCanvasSpacePanActive(doc: Document): boolean {
  const { dataset } = doc.documentElement
  return (
    dataset[CANVAS_SPACE_PAN_DATA_KEYS.parentDocument] === '1' ||
    dataset[CANVAS_SPACE_PAN_DATA_KEYS.iframe] === '1'
  )
}

function invertWheelDelta(delta: number): number {
  return delta === 0 ? 0 : -delta
}
