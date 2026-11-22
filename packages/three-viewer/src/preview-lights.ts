// Structured-clone scene data, never glTF extensions or executable Three objects.
type Triple = readonly [number, number, number];
export type PreviewLight =
  | { readonly type: 'ambient'; readonly color: Triple; readonly intensity: number }
  | { readonly type: 'hemisphere'; readonly color: Triple; readonly intensity: number;
      readonly groundColor: Triple; readonly direction: Triple };

export const MAX_PREVIEW_LIGHTS = 16;
export const MAX_PREVIEW_LIGHT_INTENSITY = 1_000_000;

function invalid(detail: string): never { throw new Error(`Invalid preview lights: ${detail}`); }
function triple(value: unknown, min: number, max: number, label: string): Triple {
  if (!Array.isArray(value) || value.length !== 3) invalid(label);
  const [x, y, z] = value;
  if (![x, y, z].every(n => Number.isFinite(n) && n >= min && n <= max)) invalid(label);
  return Object.freeze([x, y, z]);
}

export function snapshotPreviewLights(value: unknown): readonly PreviewLight[] {
  if (!Array.isArray(value) || value.length > MAX_PREVIEW_LIGHTS) invalid('expected an array of at most 16 lights');
  const result: PreviewLight[] = [];
  for (const light of value) {
    if (!light || typeof light !== 'object' || Array.isArray(light)) invalid('expected a light record');
    const { type, intensity } = light;
    if (!Number.isFinite(intensity) || intensity < 0 || intensity > MAX_PREVIEW_LIGHT_INTENSITY) invalid('intensity');
    const color = triple(light.color, 0, 1, 'linear RGB');
    if (type === 'ambient') result.push(Object.freeze({ type, color, intensity }));
    else if (type === 'hemisphere') {
      const groundColor = triple(light.groundColor, 0, 1, 'linear ground RGB');
      const direction = triple(light.direction, -1, 1, 'direction');
      if (Math.abs(Math.hypot(...direction) - 1) > 1e-6) invalid('expected a unit direction');
      result.push(Object.freeze({ type, color, intensity, groundColor, direction }));
    } else invalid('unsupported light type');
  }
  return Object.freeze(result);
}
