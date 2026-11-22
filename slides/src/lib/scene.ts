export interface Scene {
  readonly root: HTMLElement;
  /** Called when the deck enters/leaves this scene. */
  activate(on: boolean): void;
  /** stage = section's data-stage; build = number of visible fragments. */
  setStep(stage: string, build: number): void;
  /** per animation frame, only while active */
  frame(now: number): void;
  /** scene-specific keys; return true if handled */
  key?(e: KeyboardEvent): boolean;
}

export function $(root: ParentNode, sel: string): HTMLElement {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as HTMLElement;
}
export function $c(root: ParentNode, sel: string): HTMLCanvasElement {
  return $(root, sel) as HTMLCanvasElement;
}
