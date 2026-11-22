import {
  ACESFilmicToneMapping, NoToneMapping, AmbientLight, BufferAttribute, BufferGeometry, Color, DirectionalLight, DynamicDrawUsage, Euler, GridHelper, Group, LineBasicMaterial,
  LineSegments, Mesh, PerspectiveCamera, Raycaster, Scene, ShaderChunk, ShaderMaterial, SRGBColorSpace, Vector2, Vector3,
  WebGLRenderer, WebGLRenderTarget, MOUSE,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { snapshot, type ModelInput as GlbInput } from './input.js';
import { snapshotPreviewLights, type PreviewLight } from './preview-lights.js';
import { decode, stale, type Model, type ModelOutlineRow, type Part } from './model.js';
export type { PreviewLight } from './preview-lights.js';
export interface ModelInput extends GlbInput { previewLights?: readonly PreviewLight[] }
export { limits, type ModelPreview, type ShaderBinding } from './input.js';
export type { ModelOutlineRow } from './model.js';

const emptyOutline: readonly ModelOutlineRow[] = Object.freeze([]);

export type Vec3 = readonly [number, number, number];
export type PresetView = 'front' | 'back' | 'top';
export interface CameraPose { position: Vec3; target: Vec3 }
export type CaptureView = PresetView | CameraPose;
export interface CameraFrame { image: Blob; camera: CameraPose; objectIds: readonly string[]; version: string | null }
export interface SelectionChange {
  selection: readonly string[];
  removed: readonly string[];
  reason: 'selection' | 'load' | 'dispose';
}
export interface ViewerOptions {
  onSelectionChange?: (event: SelectionChange) => void;
  onPlayerModeChange?: (enabled: boolean) => void;
  ariaLabel?: string;
  instructions?: string;
  background?: string | number;
  ground?: boolean;
}
export interface ModelVersion { version: string; objectIds: readonly string[] }
interface Job {
  generation: number;
  input: ModelInput;
  resolve: (result: ModelVersion) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}
const movement = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'ControlLeft', 'ControlRight']);
const presets = { front: [0, 0, 1], back: [0, 0, -1], top: [0, 1, 0] } as const;
let generation = 0;

export class ThreeViewer {
  private readonly renderer: WebGLRenderer;
  private readonly camera = new PerspectiveCamera(50, 1, 0.01, 10000);
  private readonly scene = new Scene();
  private readonly controls: OrbitControls;
  private readonly ground?: GridHelper;
  private readonly marks = new BufferAttribute(new Float32Array(4096 * 24 * 3), 3).setUsage(DynamicDrawUsage);
  private readonly selectionOutline = new LineSegments(new BufferGeometry().setAttribute('position', this.marks),
    new LineBasicMaterial({ color: 0x69acff, depthTest: false, transparent: true, opacity: 0.9 }));
  private readonly keys = new Set<string>();
  private readonly listeners = new AbortController();
  private readonly picking = new Raycaster();
  private readonly studio = new Group();
  private model?: Model;
  private scope?: string;
  private version: string | null = null;
  private active?: Job;
  private queued?: Job;
  private latest = 0;
  private closed = false;
  private selected = new Set<string>();
  private ownedShaders = new Set<ShaderMaterial>();
  private shaders = new Map<string, Map<number, ShaderMaterial[]>>();
  private previewTime = { value: 0 };
  private previewStart?: number;
  private player = false;
  private playerDistance = 1;
  private pointer?: { id: number; x: number; y: number; multi: boolean; look: boolean };
  private marquee?: HTMLDivElement;
  private frame = 0;
  private lastFrame = 0;
  private dirty = true;
  private captureCount = 0;
  private readonly attributes: ReadonlyMap<string, string | null>;
  private readonly touchAction: string;
  private readonly observer?: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, private readonly options: ViewerOptions = {}) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.transmissionResolutionScale = 0.5;
    this.scene.background = new Color(options.background ?? 0xededed);
    this.camera.position.set(3, 2, 4);
    this.attributes = new Map(['tabindex', 'aria-label', 'aria-description'].map(key => [key, canvas.getAttribute(key)]));
    this.touchAction = canvas.style.touchAction;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', options.ariaLabel ?? canvas.getAttribute('aria-label') ?? '3D model viewer');
    canvas.setAttribute('aria-description', options.instructions ?? canvas.getAttribute('aria-description') ??
      'Left click to select; left drag for box selection. Shift or Control modifies selection. Right drag rotates; middle drag pans; scroll zooms. In player mode use WASD, Shift to move faster, Space to rise, Control to descend, and Escape to exit.');
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    this.controls.addEventListener('change', () => { this.dirty = true; });
    const light = new DirectionalLight(0xffffff, 2); light.position.set(3, 5, 4);
    this.selectionOutline.visible = false; this.selectionOutline.frustumCulled = false; this.selectionOutline.renderOrder = 1;
    this.studio.add(new AmbientLight(0xffffff, 1.3), light);
    this.scene.add(this.studio, this.selectionOutline);
    if (options.ground) {
      this.ground = new GridHelper(1, 16, 0x777777, 0x999999);
      this.ground.material.transparent = true;
      this.ground.material.opacity = 0.4;
      this.ground.material.depthWrite = false;
      this.ground.visible = false;
      this.scene.add(this.ground);
    }
    const opts = { signal: this.listeners.signal };
    canvas.addEventListener('contextmenu', event => event.preventDefault(), opts);
    // Capture phase keeps OrbitControls from owning the selection pointer.
    canvas.addEventListener('pointerdown', this.down, { ...opts, capture: true });
    canvas.addEventListener('wheel', event => {
      if (this.pointer) { event.stopImmediatePropagation(); event.preventDefault(); }
    }, { ...opts, capture: true, passive: false });
    canvas.addEventListener('pointermove', this.move, opts);
    canvas.addEventListener('pointerup', this.up, opts);
    canvas.addEventListener('pointercancel', this.resetPointer, opts);
    canvas.addEventListener('lostpointercapture', this.resetPointer, opts);
    canvas.addEventListener('blur', this.clearInput, opts);
    canvas.ownerDocument.defaultView?.addEventListener('blur', this.clearInput, opts);
    canvas.addEventListener('keydown', this.keyDown, opts);
    canvas.addEventListener('keyup', this.keyUp, opts);
    canvas.addEventListener('webglcontextrestored', () => { this.dirty = true; }, opts);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas);
    }
    this.frame = requestAnimationFrame(this.tick);
  }

  get outline(): readonly ModelOutlineRow[] { return this.model?.outline ?? emptyOutline; }
  get selection(): readonly string[] { return [...this.selected]; }
  get objectIds(): readonly string[] { return this.model ? [...this.model.objects.keys()] : []; }
  get playerMode(): boolean { return this.player; }
  labelFor(id: string): string | undefined { return this.model?.objects.get(id)?.label; }

  async load(input: ModelInput): Promise<ModelVersion> {
    this.assertOpen();
    if (input.signal?.aborted) throw stale();
    const gen = ++generation;
    this.latest = gen;
    this.abort(this.active); this.abort(this.queued);
    this.queued = undefined;
    const previewLights = input.previewLights === undefined ? undefined : snapshotPreviewLights(input.previewLights);
    if (previewLights?.length && input.identity !== 'playground') throw new Error('Preview lights require playground identity');
    const copy: ModelInput = { ...snapshot(input), previewLights };
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (this.queued === job) this.queued = undefined;
        this.abort(job);
      };
      const job = { generation: gen, input: copy, resolve, reject, cleanup: () => copy.signal?.removeEventListener('abort', cancel) };
      copy.signal?.addEventListener('abort', cancel, { once: true });
      this.queued = job;
      void this.drain();
    });
  }

  private abort(job?: Job) { if (job) { job.cleanup(); job.reject(stale()); } }
  private async drain() {
    if (this.active || !this.queued || this.closed) return;
    const job = this.active = this.queued; this.queued = undefined;
    const current = () => !this.closed && this.latest === job.generation && !job.input.signal?.aborted;
    let next: Model | undefined;
    const owned = new Set<ShaderMaterial>(), shaders = new Map<string, Map<number, ShaderMaterial[]>>();
    const previewTime = { value: 0 };
    let deleted: string[] = [];
    try {
      next = await decode(job.input, current, job.input.previewLights);
      if (!current()) throw stale();
      const toneMapping = job.input.preview?.toneMapping === 'aces' ? ACESFilmicToneMapping : NoToneMapping;
      const exposure = job.input.preview?.exposure ?? 1;
      if (job.input.shaders?.length) {
        const pendingScene = new Scene();
        pendingScene.add(next.root);
        if (!next.hasAuthoredLights) {
          const studio = this.studio.clone(); studio.visible = true;
          pendingScene.add(studio);
        }
        const { toneMapping: priorToneMapping, toneMappingExposure: priorExposure } = this.renderer;
        this.renderer.toneMapping = toneMapping;
        this.renderer.toneMappingExposure = exposure;
        try {
          for (const { objectId, slot, vertex, fragment } of job.input.shaders) {
            if (shaders.get(objectId)?.has(slot)) throw new Error(`Duplicate shader binding: ${objectId}[${slot}]`);
            this.applyShader(next, shaders, objectId, slot, ({ material }) => {
              const shader = new ShaderMaterial({
                vertexShader: vertex, fragmentShader: fragment,
                uniforms: { playgroundTime: previewTime, playgroundOpacity: { value: material.opacity } },
                opacity: material.opacity, transparent: material.transparent, side: material.side,
                depthTest: material.depthTest, depthWrite: material.depthWrite, depthFunc: material.depthFunc,
              });
              owned.add(shader);
              return shader;
            }, pendingScene);
          }
        } finally {
          this.renderer.toneMapping = priorToneMapping;
          this.renderer.toneMappingExposure = priorExposure;
          pendingScene.remove(next.root);
        }
      }
      if (!current()) throw stale();
      const previous = this.model;
      const scope = job.input.identity === 'playground' ? job.input.identityScope ?? '' : undefined;
      deleted = this.selection.filter(id => this.scope !== scope || !next!.objects.has(id));
      if (previous) { this.scene.remove(previous.root); previous.close(); }
      this.ownedShaders.forEach(s => s.dispose());
      this.ownedShaders = owned; this.shaders = shaders;
      this.previewTime = previewTime; this.previewStart = undefined;
      this.model = next; this.scope = scope; this.version = job.input.version;
      this.renderer.toneMapping = toneMapping;
      this.renderer.toneMappingExposure = exposure;
      this.studio.visible = !next.hasAuthoredLights;
      this.scene.add(next.root); next = undefined;
      if (this.ground) {
        const { bounds } = this.model;
        this.ground.visible = !bounds.isEmpty();
        if (this.ground.visible) {
          const size = bounds.getSize(new Vector3());
          const span = Math.max(0.01, size.x, size.z, size.y * 0.5);
          bounds.getCenter(this.ground.position);
          this.ground.position.y = bounds.min.y - span * 0.0001;
          this.ground.scale.setScalar(span * 1.6);
        }
      }
      for (const id of deleted) this.selected.delete(id);
      if (!previous && !this.model.bounds.isEmpty()) this.fit();
      this.refreshSelection();
      job.resolve({ version: job.input.version, objectIds: this.objectIds });
    } catch (error) {
      if (next) { next.close(); owned.forEach(s => s.dispose()); }
      job.reject(current() ? error : stale());
    } finally { job.cleanup(); this.active = undefined; }
    try { if (deleted.length) this.notify('load', deleted); }
    finally { void this.drain(); }
  }

  setSelection(ids: Iterable<string>): void {
    this.assertOpen();
    const next = new Set<string>();
    for (const id of ids) {
      if (!this.model?.objects.has(id)) throw new RangeError(`Unknown objectId: ${id}`);
      next.add(id);
    }
    if (next.size === this.selected.size && [...next].every(id => this.selected.has(id))) return;
    this.selected = next; this.refreshSelection(); this.notify('selection', []);
  }

  private notify(reason: SelectionChange['reason'], removed: string[]) {
    try { this.options.onSelectionChange?.({ selection: this.selection, removed, reason }); }
    catch (error) { this.canvas.ownerDocument.defaultView?.reportError?.(error); }
  }

  private refreshSelection() {
    let vertex = 0;
    for (const id of this.selected) {
      const { min, max } = this.model!.objects.get(id)!.bounds;
      for (let i = 0; i < 8; i++) for (const axis of [1, 2, 4]) {
        if (i & axis) continue;
        for (const j of [i, i | axis]) {
          this.marks.setXYZ(vertex++, j & 1 ? max.x : min.x, j & 2 ? max.y : min.y, j & 4 ? max.z : min.z);
        }
      }
    }
    this.marks.clearUpdateRanges();
    if (vertex) { this.marks.addUpdateRange(0, vertex * 3); this.marks.needsUpdate = true; }
    this.selectionOutline.geometry.setDrawRange(0, vertex);
    this.selectionOutline.visible = vertex > 0; this.dirty = true;
  }

  /** A directly bound shader is borrowed; caller owns its uniforms, textures and lifecycle. */
  bindShader(objectId: string, slot: number, shader: ShaderMaterial | null): void {
    this.assertOpen();
    if (!this.model) throw new RangeError(`Unknown objectId: ${objectId}`);
    const previous = this.shaders.get(objectId)?.get(slot);
    this.applyShader(this.model, this.shaders, objectId, slot, shader === null ? null : () => shader);
    for (const old of previous ?? []) {
      if (this.ownedShaders.delete(old)) old.dispose();
    }
    this.dirty = true;
  }

  private applyShader(model: Model, shaders: Map<string, Map<number, ShaderMaterial[]>>, id: string, slot: number, create: ((part: Part) => ShaderMaterial) | null, lighting = this.scene) {
    const obj = model.objects.get(id);
    if (!obj) throw new RangeError(`Unknown objectId: ${id}`);
    const parts = obj.parts.filter(part => part.slot === slot);
    if (!parts.length) {
      const reason = obj.parts.some(part => part.slot === undefined) ? 'Missing shadowMaterialSlots metadata' : 'Unknown material slot';
      throw new RangeError(`${reason}: ${id}[${slot}]`);
    }
    const materials = create ? parts.map(part => {
      const shader = create(part);
      if (!shader.isShaderMaterial) throw new TypeError('Expected ShaderMaterial');
      this.checkShader(part.mesh, shader, `${id}[${slot}]`, lighting);
      return shader;
    }) : undefined;
    const overrides = shaders.get(id) ?? new Map<number, ShaderMaterial[]>();
    if (materials) overrides.set(slot, materials); else overrides.delete(slot);
    if (overrides.size) shaders.set(id, overrides); else shaders.delete(id);
    parts.forEach(({ mesh, material }, i) => { mesh.material = materials?.[i] ?? material; });
  }

  private checkShader(mesh: Mesh, shader: ShaderMaterial, binding: string, lighting: Scene) {
    const scene = new Scene(), sample = new Mesh(mesh.geometry, shader);
    sample.matrixAutoUpdate = false; sample.matrix.copy(mesh.matrixWorld); sample.frustumCulled = false; scene.add(sample);
    try {
      let expanded = 0;
      function checkChunks(source: string, depth: number) {
        expanded += source.length;
        if (depth > 16 || expanded > 1024 * 1024) throw new RangeError('Expanded shader source budget exceeded');
        for (const match of source.matchAll(/^[ \t]*#include +<([\w\d./]+)>/gm)) {
          const chunks = ShaderChunk as Record<string, string>;
          if (!Object.hasOwn(chunks, match[1])) throw new Error(`Unknown Three shader chunk: ${match[1]}`);
          checkChunks(chunks[match[1]], depth + 1);
        }
      }
      checkChunks(shader.vertexShader, 0); checkChunks(shader.fragmentShader, 0);
      const gl = this.renderer.getContext();
      if (gl.isContextLost()) throw new Error('WebGL context is lost');
      // Check the shader against the lighting and tone mapping it will actually render with.
      this.renderer.compile(scene, this.camera, lighting);
      const properties = this.renderer.properties.get(shader) as { currentProgram?: { program?: WebGLProgram } };
      const program = properties.currentProgram?.program;
      if (!program) throw new Error('No WebGL shader program');
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = [gl.getProgramInfoLog(program), ...(gl.getAttachedShaders(program) ?? []).map(s => gl.getShaderInfoLog(s))];
        throw new Error(info.filter(Boolean).join('\n') || 'link failed');
      }
    } catch (error) { throw new Error(`Shader ${binding}: ${String(error)}`, { cause: error }); }
  }

  setPlayerMode(enabled: boolean): void {
    this.assertOpen();
    if (this.player === enabled) return;
    const target = this.currentTarget();
    this.clearInput();
    this.player = enabled; this.controls.enabled = !enabled;
    if (enabled) this.playerDistance = Math.max(0.001, this.camera.position.distanceTo(target));
    else { this.controls.target.copy(target); this.controls.update(); }
    this.notifyPlayer(enabled);
  }
  private notifyPlayer(enabled: boolean) {
    try { this.options.onPlayerModeChange?.(enabled); }
    catch (error) { this.canvas.ownerDocument.defaultView?.reportError?.(error); }
  }

  private focused() { return (this.canvas.getRootNode() as Document | ShadowRoot).activeElement === this.canvas; }
  private keyDown = (e: KeyboardEvent) => {
    if (!this.player || !this.focused()) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.setPlayerMode(false); }
    else if (movement.has(e.code) && !e.metaKey && !e.altKey) { e.preventDefault(); this.keys.add(e.code); }
  };
  private keyUp = (e: KeyboardEvent) => { if (this.keys.delete(e.code)) e.preventDefault(); };
  private clearInput = () => { this.keys.clear(); this.resetPointer(); };
  private resetPointer = (event?: PointerEvent) => {
    if (event && this.pointer?.id !== event.pointerId) return;
    const p = this.pointer; this.pointer = undefined;
    this.marquee?.remove(); this.marquee = undefined;
    if (p && this.canvas.hasPointerCapture(p.id)) this.canvas.releasePointerCapture(p.id);
  };
  private down = (e: PointerEvent) => {
    if (this.pointer) { e.stopImmediatePropagation(); return; }
    if (!e.isPrimary || e.pointerType === 'touch') return;
    this.canvas.focus({ preventScroll: true });
    const look = this.player && e.button === 2;
    if (e.button !== 0 && !look) return;
    e.stopImmediatePropagation();
    this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, multi: e.shiftKey || e.ctrlKey || e.metaKey, look };
    this.canvas.setPointerCapture(e.pointerId);
  };
  private move = (e: PointerEvent) => {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId) return;
    if (p.look) {
      if (!this.focused()) return;
      const rotation = new Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      rotation.y -= (e.clientX - p.x) * 0.004;
      rotation.x = Math.max(-1.55, Math.min(1.55, rotation.x - (e.clientY - p.y) * 0.004));
      this.camera.quaternion.setFromEuler(rotation); this.dirty = true;
      p.x = e.clientX; p.y = e.clientY;
    } else if (this.marquee || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 5) {
      if (!this.marquee) {
        this.marquee = this.canvas.ownerDocument.createElement('div');
        this.marquee.setAttribute('aria-hidden', 'true');
        this.marquee.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:1px solid Highlight;background:color-mix(in srgb,Highlight 15%,transparent)';
        this.canvas.ownerDocument.body.append(this.marquee);
      }
      const r = this.canvas.getBoundingClientRect();
      const x = Math.max(r.left, Math.min(r.right, e.clientX)), y = Math.max(r.top, Math.min(r.bottom, e.clientY));
      Object.assign(this.marquee.style, { left: `${Math.min(p.x, x)}px`, top: `${Math.min(p.y, y)}px`, width: `${Math.abs(x - p.x)}px`, height: `${Math.abs(y - p.y)}px` });
    }
  };
  private up = (e: PointerEvent) => {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId) return;
    const dragged = !!this.marquee || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 5;
    this.resetPointer();
    if (p.look || !this.model) return;
    this.resize(); this.camera.updateMatrixWorld();
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const ndc = (x: number, y: number) => new Vector2((x - r.left) * 2 / r.width - 1, 1 - (y - r.top) * 2 / r.height);
    const end = ndc(e.clientX, e.clientY), hits: string[] = [];
    if (dragged) {
      const start = ndc(p.x, p.y);
      const minX = Math.max(-1, Math.min(start.x, end.x)), maxX = Math.min(1, Math.max(start.x, end.x));
      const minY = Math.max(-1, Math.min(start.y, end.y)), maxY = Math.min(1, Math.max(start.y, end.y));
      const point = new Vector3();
      for (const [id, obj] of this.model.objects) {
        obj.bounds.getCenter(point).project(this.camera);
        if (point.z >= -1 && point.z <= 1 && point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) hits.push(id);
      }
    } else if (Math.abs(end.x) <= 1 && Math.abs(end.y) <= 1) {
      this.picking.near = this.camera.near; this.picking.far = this.camera.far;
      this.picking.setFromCamera(end, this.camera);
      const hit = this.picking.intersectObject(this.model.root, true)[0];
      const id = hit && this.model.ids.get(hit.object);
      if (id) hits.push(id);
    }
    const next = new Set(p.multi ? this.selected : []);
    for (const id of hits) { if (p.multi && !dragged && next.has(id)) next.delete(id); else next.add(id); }
    this.setSelection(next);
  };

  private resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return; // Hidden with v-show: retain the last real drawing buffer and projection.
    const scale = Math.min(1, 4096 / Math.max(w, h), Math.sqrt(8_388_608 / (w * h)));
    const width = Math.max(1, Math.floor(w * scale)), height = Math.max(1, Math.floor(h * scale));
    if (width !== this.canvas.width || height !== this.canvas.height || this.camera.aspect !== width / height) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.dirty = true;
    }
  }

  private currentTarget() {
    return this.player ? this.camera.position.clone().addScaledVector(this.camera.getWorldDirection(new Vector3()), this.playerDistance) : this.controls.target.clone();
  }

  private framed(camera: PerspectiveCamera, axis: Vector3) {
    const bounds = this.model?.bounds;
    const center = bounds?.getCenter(new Vector3()) ?? new Vector3();
    const radius = Math.max(0.05, (bounds?.getSize(new Vector3()).length() ?? 0) / 2);
    const vfov = camera.fov * Math.PI / 360;
    const distance = radius * 1.15 / Math.sin(Math.min(vfov, Math.atan(Math.tan(vfov) * camera.aspect)));
    camera.position.copy(center).addScaledVector(axis.normalize(), distance);
    camera.near = Math.max(0.00001, radius / 1000);
    camera.far = Math.max(10000, distance + radius * 10);
    camera.updateProjectionMatrix(); camera.lookAt(center);
    return center;
  }

  setView(view: PresetView): void {
    this.assertOpen(); this.resize();
    if (!Object.hasOwn(presets, view)) throw new RangeError('Unknown camera preset');
    if (this.player) this.setPlayerMode(false);
    // OrbitControls cannot use an exact pole. Independent top capture can.
    const axis = view === 'top' ? new Vector3(0, 1, 0.000001) : new Vector3(...presets[view]);
    this.applyFraming(axis);
  }
  fit(): void {
    this.assertOpen(); this.resize();
    const axis = this.camera.getWorldDirection(new Vector3()).negate();
    this.applyFraming(axis);
  }
  private applyFraming(axis: Vector3) {
    const target = this.framed(this.camera, axis);
    if (this.player) this.playerDistance = this.camera.position.distanceTo(target);
    else { this.controls.target.copy(target); this.controls.update(); }
    this.dirty = true;
  }

  private tick = (time: number) => {
    if (this.closed) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.lastFrame ? Math.min((time - this.lastFrame) / 1000, 0.05) : 0;
    this.lastFrame = time;
    if (this.player && this.focused() && this.keys.size) {
      const key = (code: string) => Number(this.keys.has(code));
      const forward = this.camera.getWorldDirection(new Vector3()); forward.y = 0; forward.normalize();
      const right = new Vector3(-forward.z, 0, forward.x);
      const delta = forward.multiplyScalar(key('KeyW') - key('KeyS')).addScaledVector(right, key('KeyD') - key('KeyA'));
      delta.y = key('Space') - Math.max(key('ControlLeft'), key('ControlRight'));
      if (delta.lengthSq()) {
        const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 8 : 3;
        this.camera.position.addScaledVector(delta.normalize(), speed * dt); this.dirty = true;
      }
    }
    if (!this.observer) this.resize();
    if (this.ownedShaders.size) {
      this.previewStart ??= time;
      this.previewTime.value = (time - this.previewStart) / 1000;
    }
    if (this.dirty || this.shaders.size) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
  };

  private cameraFor(view?: CaptureView) {
    if (view === undefined) return { camera: this.camera, target: this.currentTarget() };
    const camera = this.camera.clone(); camera.up.set(0, 1, 0);
    if (typeof view === 'string') {
      if (!Object.hasOwn(presets, view)) throw new RangeError('Unknown camera preset');
      if (view === 'top') camera.up.set(0, 0, -1);
      return { camera, target: this.framed(camera, new Vector3(...presets[view])) };
    }
    if (![view.position, view.target].every(v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 1e15))) throw new TypeError('Expected finite camera position and target');
    const target = new Vector3(...view.target);
    camera.position.set(...view.position);
    if (camera.position.equals(target)) throw new RangeError('Camera position equals target');
    if (camera.position.x === target.x && camera.position.z === target.z) {
      camera.up.set(0, 0, camera.position.y > target.y ? -1 : 1);
    }
    camera.lookAt(target);
    return { camera, target };
  }
  getCamera(view?: CaptureView): CameraPose {
    this.assertOpen(); this.resize();
    const { camera, target } = this.cameraFor(view);
    return { position: camera.position.toArray(), target: target.toArray() };
  }
  async captureFrame(view?: CaptureView): Promise<CameraFrame> {
    this.assertOpen(); this.resize();
    if (this.renderer.getContext().isContextLost()) throw new Error('WebGL context is lost');
    if (this.captureCount >= 2) throw new Error('Too many captures in progress');
    const { camera, target } = this.cameraFor(view);
    const pose = { position: camera.position.toArray(), target: target.toArray() };
    const version = this.version, objectIds = this.selection;
    this.captureCount++;
    try {
      const surface = view === undefined ? this.canvas : this.renderInspection(camera);
      if (view === undefined) { this.renderer.render(this.scene, camera); this.dirty = false; }
      const image = await new Promise<Blob>((resolve, reject) => {
        surface.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas PNG encoding failed')), 'image/png');
      });
      return { image, camera: pose, version, objectIds };
    } finally { this.captureCount--; }
  }
  private renderInspection(camera: PerspectiveCamera): HTMLCanvasElement {
    const { width, height } = this.canvas;
    if (!width || !height || width * height > 8_388_608) throw new RangeError('Invalid inspection size');
    const surface = this.canvas.ownerDocument.createElement('canvas');
    surface.width = width; surface.height = height;
    const ctx = surface.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Cannot create inspection canvas');
    // Three r180 ordinarily treats render targets as linear intermediate passes
    // and skips tone mapping. Use its XR final-output path to match the canvas.
    // Explicit RGBA8 stores shader-encoded sRGB without a second framebuffer conversion.
    const target = Object.assign(new WebGLRenderTarget(width, height, {
      colorSpace: SRGBColorSpace, internalFormat: 'RGBA8',
    }), { isXRRenderTarget: true });
    const prior = this.renderer.getRenderTarget();
    try {
      const pixels = new Uint8Array(width * height * 4);
      this.renderer.setRenderTarget(target); this.renderer.render(this.scene, camera);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      const image = ctx.createImageData(width, height);
      for (let y = 0, stride = width * 4; y < height; y++) {
        image.data.set(pixels.subarray((height - y - 1) * stride, (height - y) * stride), y * stride);
      }
      ctx.putImageData(image, 0, 0);
      return surface;
    } finally { this.renderer.setRenderTarget(prior); target.dispose(); }
  }
  async capture(view?: CaptureView): Promise<Blob> { return (await this.captureFrame(view)).image; }

  private assertOpen() { if (this.closed) throw stale(); }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.abort(this.active); this.abort(this.queued); this.queued = undefined;
    cancelAnimationFrame(this.frame); this.observer?.disconnect();
    this.listeners.abort(); this.clearInput(); this.controls.dispose();
    for (const [name, value] of this.attributes) {
      if (value === null) this.canvas.removeAttribute(name); else this.canvas.setAttribute(name, value);
    }
    this.canvas.style.touchAction = this.touchAction;
    this.model?.close(); this.model = undefined;
    this.shaders.clear(); this.ownedShaders.forEach(s => s.dispose()); this.ownedShaders.clear();
    this.ground?.dispose();
    this.selectionOutline.geometry.dispose(); this.selectionOutline.material.dispose(); this.scene.clear(); this.renderer.dispose();
    const removed = [...this.selection]; this.selected.clear();
    if (removed.length) this.notify('dispose', removed);
    if (this.player) { this.player = false; this.notifyPlayer(false); }
  }
}
